from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import os
import re
from typing import Any, Callable, NamedTuple
from urllib.parse import urlsplit

from tests.generated_policy import (
    ALLOWED_CONFIG_SOURCES,
    DEFAULT_CACHE_POLICY,
    DEFAULT_GRANULARITY,
    ERROR_KINDS,
    EXPIRY_MARGIN_SECONDS,
    IDENTIFIER_PATTERN,
    OPERATION_INDEPENDENT_DEFAULT,
    OPERATIONS_REQUIRING_VERSION,
    PROTOCOL_VERSION,
    SUPPORTED_AUTH_TYPES,
    SUPPORTED_CACHE,
    SUPPORTED_CAPABILITIES,
    SUPPORTED_GRANULARITY,
    SUPPORTED_OPERATIONS,
    OPERATION_BOUND_REGARDLESS,
    STORED_CREDENTIAL_ENTRY,
    SUPPORTED_REQUEST_KINDS,
    TIMEOUT_SECONDS,
    TOKEN_HELPER_CONFIG_SOURCES,
    TRUSTED_LOCATION_KINDS,
)


class ProtocolViolation(AssertionError):
    """The transcript or provider output violates the protocol contract."""


class ProviderFailure(RuntimeError):
    """The provider returned a protocol-valid error that should stop npm."""


class ResolutionFailure(RuntimeError):
    """Provider resolution would execute from an untrusted or ambiguous source."""


class ClientState(str, Enum):
    SPAWNED = "spawned"
    READY = "ready"
    CLOSED = "closed"
    FAILED = "failed"


@dataclass(frozen=True)
class ProviderConfig:
    configured: bool = True
    legacy_fallback: bool = False


@dataclass(frozen=True)
class RequestContext:
    registry: str
    kind: str = "get"
    operation: str = "read"
    command: str | None = "install"
    interactive: bool = False
    scope: str | None = None
    package: str | None = None
    version: str | None = None


@dataclass
class CacheEntry:
    auth: dict[str, Any]
    granularity: str
    cache: str
    registry: str
    scope: str | None = None
    package: str | None = None
    operation: str | None = None
    expires_at: int | None = None
    operation_independent: bool = True


class CacheKey(NamedTuple):
    """Granularity is part of the key, so entries of different levels never
    collide: a bare tuple made the package-level key for the unscoped package
    `read` equal to the scope-level key of a token bound to operation `read`."""

    granularity: str
    registry: str
    scope: str | None = None
    package: str | None = None
    operation: str | None = None


@dataclass
class CredentialClientModel:
    config: ProviderConfig = field(default_factory=ProviderConfig)
    state: ClientState = ClientState.SPAWNED
    version: int | None = None
    capabilities: frozenset[str] = field(default_factory=frozenset)
    cache: dict[CacheKey, CacheEntry] = field(default_factory=dict)

    def receive_hello(self, message: dict[str, Any]) -> int:
        self._require_state(ClientState.SPAWNED)
        try:
            versions, capabilities = validate_hello(message)
        except ProtocolViolation:
            self.state = ClientState.FAILED
            raise
        if PROTOCOL_VERSION not in versions:
            self.state = ClientState.FAILED
            if self.config.configured and not self.config.legacy_fallback:
                raise ProtocolViolation("no compatible protocol version")
            return 0
        self.version = PROTOCOL_VERSION
        self.capabilities = frozenset(capability for capability in capabilities if capability in SUPPORTED_CAPABILITIES)
        self.state = ClientState.READY
        return PROTOCOL_VERSION

    def build_request(self, context: RequestContext) -> dict[str, Any]:
        self._require_state(ClientState.READY)
        request = {
            "v": self.version,
            "kind": context.kind,
            "registry": context.registry,
            "operation": context.operation,
            "interactive": context.interactive,
        }
        if context.command is not None:
            request["command"] = context.command
        if context.scope is not None:
            request["scope"] = context.scope
        if context.package is not None:
            request["package"] = context.package
        if context.version is not None:
            request["version"] = context.version
        validate_request(request)
        return request

    def handle_response(self, request: dict[str, Any], response: dict[str, Any]) -> str:
        self._require_state(ClientState.READY)
        if ("Ok" in response) == ("Err" in response):
            raise ProtocolViolation("response must contain exactly one of Ok or Err")
        if "Err" in response:
            return self._handle_error(request, response["Err"])
        ok = response["Ok"]
        if not isinstance(ok, dict):
            raise ProtocolViolation("Ok response must be an object")
        kind = ok.get("kind")
        if not isinstance(kind, str) or kind not in SUPPORTED_REQUEST_KINDS:
            raise ProtocolViolation(f"unsupported Ok kind: {kind!r}")
        if kind != request.get("kind"):
            raise ProtocolViolation("Ok.kind must match request kind")
        auth, cache, expires_at, granularity, operation_independent = validate_ok(ok)
        if kind != "get":
            return kind
        self._store_token(request, auth, cache, expires_at, granularity, operation_independent)
        return "ok"

    def reject_credential(
        self,
        context: RequestContext,
        auth_challenges: list[str] | None = None,
        now: int = 0,
    ) -> dict[str, Any] | None:
        """A 401 that leads to `erase`: first drop from this cache every entry
        that served the rejected credential, at every granularity level, so a
        later lookup cannot hand it out again; then build the `erase` request
        with the context of the `get` that produced it (package, scope,
        operation and the granularity of the response). Returns None when the
        provider did not advertise `erase`: the eviction still happens, there is
        just nobody to tell. The retry `get` follows the `erase`."""
        self._require_state(ClientState.READY)
        served = self._evict_served(context, now)
        if "erase" not in self.capabilities:
            return None
        request: dict[str, Any] = {
            "v": self.version,
            "kind": "erase",
            "registry": context.registry,
            "operation": context.operation,
        }
        if context.scope is not None:
            request["scope"] = context.scope
        if context.package is not None:
            request["package"] = context.package
        if served is not None:
            request["granularity"] = served.granularity
        if auth_challenges:
            request["authChallenges"] = list(auth_challenges)
        validate_request(request)
        return request

    def evict_rejected(self, erase_request: dict[str, Any]) -> None:
        """Transcript replay of what the client did before it sent this `erase`:
        the erase carries the context of the `get` that produced the rejected
        credential, so the same lookup finds the entry that served it."""
        context = RequestContext(
            registry=erase_request["registry"],
            scope=erase_request.get("scope"),
            package=erase_request.get("package"),
            operation=erase_request.get("operation", "read"),
        )
        self._evict_served(context)

    def _evict_served(self, context: RequestContext, now: int = 0) -> CacheEntry | None:
        """Removes every entry holding the credential that this context's lookup
        serves, whatever its granularity or operation binding, and returns the
        entry that served it."""
        served = self.lookup(context.registry, context.scope, context.package, context.operation, now)
        if served is not None:
            for key in [key for key, entry in self.cache.items() if entry.auth == served.auth]:
                del self.cache[key]
        return served

    def lookup(
        self,
        registry: str,
        scope: str | None = None,
        package: str | None = None,
        operation: str = "read",
        now: int = 0,
    ) -> CacheEntry | None:
        """Most specific entry first: package, then scope, then registry; at each
        level a token bound to this operation before an operation-independent one.
        An `expires` entry stops matching `EXPIRY_MARGIN_SECONDS` before
        `expiresAt`, so a request never leaves with a token about to lapse; the
        miss that follows is a plain `get`, and a provider with refresh state
        refreshes on its own side."""
        for granularity in ("package", "scope", "registry"):
            for bound_operation in (operation, None):
                key = CacheKey(
                    granularity,
                    registry,
                    scope if granularity != "registry" else None,
                    package if granularity == "package" else None,
                    bound_operation,
                )
                entry = self.cache.get(key)
                if entry is None:
                    continue
                if entry.cache == "expires" and now >= entry.expires_at - EXPIRY_MARGIN_SECONDS:
                    del self.cache[key]
                    continue
                return entry
        return None

    def close(self) -> None:
        self._require_state(ClientState.READY)
        self.state = ClientState.CLOSED

    def _handle_error(self, request: dict[str, Any], err: Any) -> str:
        if not isinstance(err, dict):
            raise ProtocolViolation("Err response must be an object")
        kind = err.get("kind")
        if not isinstance(kind, str) or kind not in ERROR_KINDS:
            raise ProtocolViolation(f"unsupported error kind: {kind!r}")
        message = err.get("message")
        if message is not None and not isinstance(message, str):
            raise ProtocolViolation("Err.message must be a string")
        caused_by = err.get("causedBy")
        if caused_by is not None and (
            not isinstance(caused_by, list) or not all(isinstance(item, str) for item in caused_by)
        ):
            raise ProtocolViolation("Err.causedBy must be string[]")
        if kind == "url-not-supported":
            return "try-next-provider"
        if kind == "not-found":
            # as in Cargo, the chain goes on; `resolve_chain` decides at its end
            return "try-next-provider-not-found"
        raise ProviderFailure(kind)

    def _store_token(
        self,
        request: dict[str, Any],
        auth: dict[str, Any],
        cache: str,
        expires_at: int | None,
        granularity: str,
        operation_independent: bool,
    ) -> None:
        if cache == "never":
            return
        # a `stage-read` answer serves the lookup only: the write after it
        # always gets a `get` of its own, with the record's package and version
        if request.get("operation") in OPERATION_BOUND_REGARDLESS:
            operation_independent = False
        entry = CacheEntry(
            auth=auth,
            granularity=granularity,
            cache=cache,
            registry=request["registry"],
            scope=request.get("scope"),
            package=request.get("package"),
            operation=None if operation_independent else request.get("operation"),
            expires_at=expires_at,
            operation_independent=operation_independent,
        )
        self.cache[cache_key(entry)] = entry

    def _require_state(self, expected: ClientState) -> None:
        if self.state != expected:
            raise ProtocolViolation(f"expected state {expected.value}, got {self.state.value}")


def cache_key(entry: CacheEntry) -> CacheKey:
    return CacheKey(
        entry.granularity,
        entry.registry,
        entry.scope if entry.granularity in {"scope", "package"} else None,
        entry.package if entry.granularity == "package" else None,
        None if entry.operation_independent else entry.operation,
    )


def request_timeout_seconds(request: dict[str, Any]) -> int:
    """The budget the client gives the provider for this request: a `get` that
    may prompt the user (`interactive: true`) gets the `login` budget, any other
    `get` the short one. A kind with no budget of its own is treated as a `get`,
    the bound a newer kind gets until the policy names one."""
    kind = request.get("kind")
    if kind == "get" and request.get("interactive") is True:
        return TIMEOUT_SECONDS["getInteractive"]
    return TIMEOUT_SECONDS.get(kind, TIMEOUT_SECONDS["get"]) if isinstance(kind, str) else TIMEOUT_SECONDS["get"]


def provider_reply_to_unsupported(
    request: dict[str, Any],
    supported_kinds: frozenset[str] = SUPPORTED_REQUEST_KINDS,
    supported_operations: frozenset[str] = SUPPORTED_OPERATIONS,
) -> dict[str, Any] | None:
    """Provider side of forward compatibility: a well-formed request whose kind
    or operation this provider does not know is answered with
    `operation-not-supported`, never served as `read` and never a protocol
    violation; the provider keeps serving. Returns None when both are known."""
    validate_request(request)
    kind = request["kind"]
    if kind not in supported_kinds:
        return {"Err": {"kind": "operation-not-supported", "message": f"unknown request kind: {kind}"}}
    operation = request.get("operation")
    if operation is not None and operation not in supported_operations:
        return {"Err": {"kind": "operation-not-supported", "message": f"unknown operation: {operation}"}}
    return None


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_enum(value: Any, allowed: frozenset[str]) -> bool:
    return isinstance(value, str) and value in allowed


def _is_identifier(value: Any) -> bool:
    # `$` in ECMA-262 does not match before a trailing newline, so fullmatch
    return isinstance(value, str) and _IDENTIFIER.fullmatch(value) is not None


def _is_nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and value != ""


# the schema's `scope` pattern, anchored the way ECMA-262 `$` is (no trailing newline)
_SCOPE = re.compile(r"@[^/]+")
# the schema's `kind` and `operation` pattern: new values may appear within v1
_IDENTIFIER = re.compile(IDENTIFIER_PATTERN)
# the schema's hello `registries` item pattern
_SERVED_REGISTRY = re.compile(r"https?://[^/?#\s]+(/[^?#\s]*)?")


def validate_hello(message: Any) -> tuple[list[int], list[str]]:
    """Schema `hello`: v is a non-empty array of unique integers >= 1;
    capabilities, when present, is an array of unique non-empty strings."""
    if not isinstance(message, dict):
        raise ProtocolViolation("provider hello must be an object")
    versions = message.get("v")
    if (
        not isinstance(versions, list)
        or not versions
        or not all(_is_int(v) and v >= 1 for v in versions)
        or len(set(versions)) != len(versions)
    ):
        raise ProtocolViolation("provider hello must contain v: unique integers >= 1, at least one")
    capabilities = message.get("capabilities", [])
    if (
        not isinstance(capabilities, list)
        or not all(_is_nonempty_string(capability) for capability in capabilities)
        or len(set(capabilities)) != len(capabilities)
    ):
        raise ProtocolViolation("provider hello capabilities must be unique non-empty strings")
    registries = message.get("registries", [])
    if (
        not isinstance(registries, list)
        or not all(isinstance(entry, str) and _SERVED_REGISTRY.fullmatch(entry) for entry in registries)
        or len(set(registries)) != len(registries)
    ):
        raise ProtocolViolation("provider hello registries must be unique absolute http(s) URLs")
    return versions, capabilities


_DEFAULT_PORTS = {"http": 80, "https": 443}


def _canonical(url: str) -> tuple[str | None, str, int | None, str]:
    """Scheme (None for a `//host/path/` key), host (lowercase, punycode),
    port (None when default), and path with dot segments resolved, ending
    in `/`. The path keeps its case and its percent-encodings."""
    parts = urlsplit(url)
    scheme = parts.scheme.lower() or None
    host = ".".join(label.encode("idna").decode("ascii") if label else label
                    for label in (parts.hostname or "").split("."))
    port = parts.port
    if scheme is not None and port == _DEFAULT_PORTS.get(scheme):
        port = None
    segments: list[str] = []
    for segment in parts.path.split("/")[1:]:
        if segment == "..":
            if segments:
                segments.pop()
        elif segment != ".":
            segments.append(segment)
    path = "/" + "/".join(segments)
    return scheme, host, port, path if path.endswith("/") else path + "/"


def registry_matches(served: str, url: str) -> bool:
    """Registry matching: does `url` fall under `served`? Host and port equal
    after canonicalization; the served path a prefix of the URL's path at a
    segment boundary, compared byte for byte; the scheme compared only when
    `served` carries one (a hello entry), not for a `//host/path/` key."""
    served_scheme, served_host, served_port, served_path = _canonical(served)
    scheme, host, port, path = _canonical(url)
    if served_scheme is None and scheme is not None and port == _DEFAULT_PORTS.get(scheme):
        port = None
    if served_scheme is not None and served_scheme != scheme:
        return False
    return (served_host, served_port) == (host, port) and path.startswith(served_path)


def validate_request(message: dict[str, Any]) -> None:
    if not isinstance(message, dict):
        raise ProtocolViolation("request must be an object")
    if not _is_int(message.get("v")) or message.get("v") != PROTOCOL_VERSION:
        raise ProtocolViolation("request must use negotiated protocol version")
    if not _is_identifier(message.get("kind")):
        raise ProtocolViolation(f"request kind must match {IDENTIFIER_PATTERN}: {message.get('kind')!r}")
    if not isinstance(message.get("registry"), str):
        raise ProtocolViolation("request requires registry string")
    if "scope" in message:
        scope = message["scope"]
        if scope is not None and (not isinstance(scope, str) or not _SCOPE.fullmatch(scope)):
            raise ProtocolViolation("scope must be null or match ^@[^/]+$")
    for name in ("package", "version", "command", "token"):
        if name in message and not _is_nonempty_string(message[name]):
            raise ProtocolViolation(f"{name} must be a non-empty string")
    if "loginUrl" in message and not isinstance(message["loginUrl"], str):
        raise ProtocolViolation("loginUrl must be a string")
    if "interactive" in message and not isinstance(message["interactive"], bool):
        raise ProtocolViolation("interactive must be boolean")
    kind = message["kind"]
    operation = message.get("operation")
    if "operation" in message and not _is_identifier(operation):
        raise ProtocolViolation(f"operation must match {IDENTIFIER_PATTERN}")
    if "granularity" in message and not _is_enum(message["granularity"], SUPPORTED_GRANULARITY):
        raise ProtocolViolation("granularity must be registry, scope or package")
    if kind == "get":
        if "operation" not in message:
            raise ProtocolViolation("get requests require an operation")
        if "interactive" not in message:
            raise ProtocolViolation("get requests require interactive boolean")
    if operation in OPERATIONS_REQUIRING_VERSION and "version" not in message:
        raise ProtocolViolation(f"{operation} requires version")
    retry = message.get("retry")
    if retry is not None and not isinstance(retry, bool):
        raise ProtocolViolation("retry must be boolean")
    http_status = message.get("httpStatus")
    if http_status is not None and (not _is_int(http_status) or not 100 <= http_status <= 599):
        raise ProtocolViolation("httpStatus must be an HTTP status code")
    if retry is True and http_status is None:
        raise ProtocolViolation("retry=true requires httpStatus")
    auth_challenges = message.get("authChallenges")
    if auth_challenges is not None and (
        not isinstance(auth_challenges, list) or not all(isinstance(challenge, str) for challenge in auth_challenges)
    ):
        raise ProtocolViolation("authChallenges must be string[]")


def validate_auth(auth: Any) -> None:
    if not isinstance(auth, dict):
        raise ProtocolViolation("Ok.auth is required")
    auth_type = auth.get("type")
    if not _is_enum(auth_type, SUPPORTED_AUTH_TYPES):
        raise ProtocolViolation(f"unsupported auth type: {auth_type!r}")
    if auth_type == "bearer" and not _is_nonempty_string(auth.get("token")):
        raise ProtocolViolation("bearer auth requires a non-empty token")
    if auth_type == "basic":
        if not _is_nonempty_string(auth.get("username")) or not _is_nonempty_string(auth.get("password")):
            raise ProtocolViolation("basic auth requires a non-empty username and password")


def validate_ok(ok: dict[str, Any]) -> tuple[Any, str, int | None, str, bool]:
    """Schema `providerOk`, for every kind: returns (auth, cache, expires_at,
    granularity, operation_independent) with defaults applied. `auth` is
    required for get and validated whenever present."""
    kind = ok.get("kind")
    auth = ok.get("auth")
    if kind == "get" or "auth" in ok:
        validate_auth(auth)
    cache = ok.get("cache", DEFAULT_CACHE_POLICY)
    if not _is_enum(cache, SUPPORTED_CACHE):
        raise ProtocolViolation(f"unsupported cache policy: {cache!r}")
    expires_at = ok.get("expiresAt")
    if "expiresAt" in ok and (not _is_int(expires_at) or expires_at < 0):
        raise ProtocolViolation("expiresAt must be an integer Unix timestamp >= 0")
    if cache == "expires" and "expiresAt" not in ok:
        raise ProtocolViolation("cache=expires requires expiresAt")
    granularity = ok.get("granularity", DEFAULT_GRANULARITY)
    if not _is_enum(granularity, SUPPORTED_GRANULARITY):
        raise ProtocolViolation(f"unsupported granularity: {granularity!r}")
    operation_independent = ok.get("operationIndependent", OPERATION_INDEPENDENT_DEFAULT)
    if not isinstance(operation_independent, bool):
        raise ProtocolViolation("operationIndependent must be boolean")
    return auth, cache, expires_at, granularity, operation_independent


def load_transcript(path: str) -> list[dict[str, Any]]:
    import json

    events: list[dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as transcript:
        for line_number, line in enumerate(transcript, 1):
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            try:
                event = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise ProtocolViolation(f"{path}:{line_number}: invalid JSON") from exc
            events.append(event)
    return events


class ChainOutcome(NamedTuple):
    """What a chain decided for one registry: `ok` (entry `entry` answered),
    `stored-credential` (the credential in `.npmrc`), `anonymous`, or `fail`."""

    result: str
    entry: int | None = None
    warnings: tuple[str, ...] = ()


def resolve_chain(
    answers: list[str],
    *,
    per_registry: bool,
    stored_credential: bool,
    legacy_fallback: bool = False,
    oidc_token: bool = False,
) -> ChainOutcome:
    """The end of a provider chain. `answers` holds, in chain order, either
    `STORED_CREDENTIAL_ENTRY` (`npm:token`) or one provider's outcome: `ok`,
    `try-next-provider` (url-not-supported), `try-next-provider-not-found`,
    `no-common-version`, or `fail` (any other error, a spawn failure, an
    oversized line, a timeout).

    A global chain that does not list `npm:token` ends with it implicitly, but
    only while every provider before it declined the registry: after a
    `not-found` the stored credential needs the legacy opt-in, as it does
    after a version mismatch. A per-registry list never consults a stored
    credential it does not list, and says so."""
    if oidc_token:
        # a token from a successful trusted-publishing exchange: no provider is
        # asked, and it is not a stored credential, so nothing is "ignored"
        return ChainOutcome("oidc")
    entries = list(answers)
    listed = STORED_CREDENTIAL_ENTRY in entries

    def done(result: str, entry: int | None = None, *warnings: str) -> ChainOutcome:
        if per_registry and stored_credential and not listed and result != "stored-credential":
            warnings = ("stored credential ignored: the per-registry list does not include npm:token", *warnings)
        return ChainOutcome(result, entry, tuple(warnings))

    if not entries:
        # no provider configured for the registry: what npm does today
        return done("stored-credential" if stored_credential else "anonymous")
    not_found = False
    for index, answer in enumerate(entries):
        if answer == STORED_CREDENTIAL_ENTRY:
            if stored_credential:
                return done("stored-credential", index)
            continue
        if answer == "ok":
            return done("ok", index)
        if answer == "try-next-provider":
            continue
        if answer == "try-next-provider-not-found" or (answer == "no-common-version" and legacy_fallback):
            not_found = True
            continue
        return done("fail", index)
    if not_found:
        if legacy_fallback:
            return done("stored-credential" if stored_credential else "anonymous")
        return done("fail")
    if per_registry:
        return done("fail")
    if stored_credential and not listed:
        return done("stored-credential", None, "stored credential used after every global provider declined the registry")
    return done("anonymous")


def resolve_login_chain(answers: list[str], *, per_registry: bool) -> ChainOutcome:
    """`login` and `logout` travel the chain and end the way `get` ends. A
    listed `npm:token` runs today's `npm login` (`npm-login`); the implicit
    one ends a global chain only when every provider declined, with a warning
    that a plaintext token is stored. After a `not-found` with nothing listed
    behind it, `login` fails rather than store a token `get` would not send."""
    entries = list(answers)
    listed = STORED_CREDENTIAL_ENTRY in entries
    if not per_registry and not listed:
        entries.append(STORED_CREDENTIAL_ENTRY)
    not_found = False
    for index, answer in enumerate(entries):
        if answer == STORED_CREDENTIAL_ENTRY:
            implicit = index == len(answers)
            if implicit and not_found:
                return ChainOutcome("fail", None)
            if implicit:
                return ChainOutcome("npm-login", None, ("plaintext token stored after every global provider declined the registry",))
            return ChainOutcome("npm-login", index)
        if answer == "ok":
            return ChainOutcome("ok", index)
        if answer == "try-next-provider":
            continue
        if answer == "try-next-provider-not-found":
            not_found = True
            continue
        return ChainOutcome("fail", index)
    return ChainOutcome("fail", None)


def classify_401(www_authenticate: str | None, body: Any) -> str:
    """npm's own classification of a 401 (npm-registry-fetch check-response.js
    and npm/cli otplease), which decides erase: `eauthip` and `otp` keep the
    credential, `reject` erases it. `body` is the raw text, or the parsed
    object when the body was JSON, which never matches the text test."""
    asks_otp = isinstance(body, str) and "one-time pass" in body
    if www_authenticate is not None:
        challenge = www_authenticate.lower()
        if "ipaddress" in challenge:
            return "eauthip"
        if "otp" in challenge:
            return "otp"
        return "otp" if asks_otp else "reject"
    return "otp" if asks_otp else "reject"


@dataclass
class DeclinedRegistries:
    """`url-not-supported` depends on `registry` alone, so the client remembers
    it per provider and registry for the rest of the command, and a provider
    that does not serve a registry is asked about it once."""

    declined: set[tuple[str, str]] = field(default_factory=set)

    def should_ask(self, provider: str, registry: str) -> bool:
        return (provider, registry) not in self.declined

    def record(self, provider: str, registry: str, outcome: str) -> None:
        if outcome == "try-next-provider":
            self.declined.add((provider, registry))


def validate_transcript(path: str, config: ProviderConfig | None = None) -> CredentialClientModel:
    client = CredentialClientModel(config=config or ProviderConfig())
    last_request: dict[str, Any] | None = None
    for event in load_transcript(path):
        actor = event.get("from")
        if actor == "provider" and client.state == ClientState.SPAWNED:
            client.receive_hello(event.get("message"))
        elif actor == "client":
            if event.get("event") == "close":
                client.close()
                continue
            message = event.get("message")
            validate_request(message)
            if message["kind"] == "erase":
                client.evict_rejected(message)
            last_request = message
        elif actor == "provider":
            if last_request is None:
                raise ProtocolViolation("provider response without client request")
            client.handle_response(last_request, event.get("message"))
            last_request = None
        else:
            raise ProtocolViolation(f"unsupported transcript event: {event!r}")
    return client


@dataclass(frozen=True)
class ProviderLocation:
    name: str
    kind: str
    path: str


def resolve_provider(command: str, config_source: str, locations: list[ProviderLocation]) -> ProviderLocation:
    if config_source not in ALLOWED_CONFIG_SOURCES:
        raise ResolutionFailure("credentialProvider may only come from user or global config")
    is_absolute = os.path.isabs(command)
    matches = []
    for location in locations:
        if location.kind not in TRUSTED_LOCATION_KINDS:
            continue
        if is_absolute and os.path.normcase(location.path) == os.path.normcase(command):
            matches.append(location)
        elif not is_absolute and location.name == command:
            matches.append(location)
    if not matches:
        raise ResolutionFailure("provider not found in trusted locations")
    if len(matches) > 1:
        raise ResolutionFailure("provider name is ambiguous across trusted locations")
    return matches[0]


class TokenHelperFailure(RuntimeError):
    """A Phase 1 `tokenHelper` could not produce a header; npm fails the request."""


# JavaScript's String.prototype.trim and `\s`: not Python's, which also counts
# \x1c-\x1f and \x85 as whitespace and does not count U+FEFF
JS_WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_ARGUMENTS_REFUSED = "tokenHelper must be an absolute path with no arguments (arguments are not supported)"
_ABSOLUTE_PATH = re.compile(r"^(?:[/\\]|[A-Za-z]:[/\\])")
_HEADER_FORBIDDEN = re.compile(r"[^\t\x20-\x7e]")
_SCHEME = re.compile(r"^[A-Za-z]+ ")


def check_token_helper_config(
    value: str,
    config_source: str,
    exists: Callable[[str], bool] = os.path.exists,
    is_file: Callable[[str], bool] = os.path.isfile,
) -> None:
    """Phase 1 accepts pnpm's `tokenHelper` the way the prototype does: from user
    or global config only, as an absolute path (POSIX or Windows form) with no
    arguments. A path with whitespace in it is a path when it exists as given;
    when it does not, it is refused as arguments if some prefix before a
    whitespace character is an existing file, else as not found. `exists` and
    `is_file` stand in for the filesystem."""
    if config_source not in TOKEN_HELPER_CONFIG_SOURCES:
        raise ResolutionFailure("tokenHelper may only come from user or global config")
    if not _ABSOLUTE_PATH.match(value):
        raise ResolutionFailure(_ARGUMENTS_REFUSED)
    if not any(char in JS_WHITESPACE for char in value) or exists(value):
        return
    for index, char in enumerate(value):
        if char in JS_WHITESPACE and is_file(value[:index]):
            raise ResolutionFailure(_ARGUMENTS_REFUSED)
    raise ResolutionFailure("tokenHelper was not found")


def token_helper_header(exit_code: int, stdout: str) -> str:
    """Maps a `tokenHelper` run to an `Authorization` header value the way the
    prototype does: output is trimmed (JavaScript semantics, so a leading BOM
    goes too), a raw token gets `Bearer `, output that already starts with a
    scheme (`Bearer x`, `Basic x`) is used as is. Refusal messages never
    contain the output, which is the credential."""
    if exit_code != 0:
        raise TokenHelperFailure("tokenHelper exited with a non-zero status")
    token = stdout.strip(JS_WHITESPACE)
    if not token:
        raise TokenHelperFailure("tokenHelper printed an empty token")
    if _HEADER_FORBIDDEN.search(token):
        raise TokenHelperFailure(
            "tokenHelper printed something that is not a valid header value "
            "(more than one line, a control character or a non-ASCII character)"
        )
    return token if _SCHEME.match(token) else f"Bearer {token}"
