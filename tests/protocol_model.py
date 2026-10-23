from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import os
import re
from typing import Any, Callable, NamedTuple
from urllib.parse import urlsplit

from tests.generated_policy import (
    ALLOWED_CONFIG_SOURCES,
    ANONYMOUS_AUTH_TYPE,
    ANONYMOUS_OPERATIONS,
    ANONYMOUS_REQUEST_KINDS,
    STORED_CREDENTIAL_SOURCES,
    DEFAULT_CACHE_POLICY,
    DEFAULT_GRANULARITY,
    ERASE_ERROR_OUTCOMES,
    ERROR_KINDS,
    EXPIRY_MARGIN_SECONDS,
    GLOBAL_CHAIN_LISTED_HOST_OUTCOME,
    IDENTIFIER_PATTERN,
    LINE_SIZE_MINIMUM,
    SCHEME_IN_CACHE_KEY,
    SESSION_ENDS,
    UNKNOWN_CACHE,
    UNKNOWN_ERROR_KIND,
    UNKNOWN_GRANULARITY,
    OPERATION_INDEPENDENT_DEFAULT,
    OPERATIONS_REQUIRING_VERSION,
    PROTOCOL_VERSION,
    SUPPORTED_AUTH_TYPES,
    SUPPORTED_CACHE,
    SUPPORTED_CAPABILITIES,
    SUPPORTED_GRANULARITY,
    SUPPORTED_OPERATIONS,
    OPERATION_BOUND_EXCEPT,
    PACKAGE_BOUND_WHEN_PRESENT,
    FAILED_SESSIONS_BEFORE_NO_RESTART,
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
    operation_independent: bool = OPERATION_INDEPENDENT_DEFAULT
    issuance: int | None = None


@dataclass(frozen=True)
class Issuance:
    """One `get` answer: the credential npm sent with a registry request, the
    context of the `get` that produced it and the response's granularity,
    kept whether or not it was cached (`cache: "never"`). A registry request
    is tied to the issuance it carried, so a late 401 or 403 on it is judged
    against that answer, not against whatever the cache holds by then."""

    id: int
    auth: dict[str, Any]
    granularity: str
    registry: str
    operation: str | None
    scope: str | None = None
    package: str | None = None
    version: str | None = None


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
    issued: dict[int, Issuance] = field(default_factory=dict)
    # erased by a 401, or replaced by the answer to a 403 retry
    retired: set[int] = field(default_factory=set)
    last_issuance: int | None = None
    # hello `registries`: None when the provider did not list any
    registries: list[str] | None = None

    def serves(self, registry: str, global_chain: bool = False) -> bool:
        """Registry matching against hello `registries`: a registry outside
        the list counts as `url-not-supported`, and the provider is sent
        nothing about it. A provider with no list is asked in a per-registry
        list, which names the registry, and serves none in the global chain,
        where it must list what it serves."""
        if self.registries is None:
            return not global_chain
        return any(registry_matches(served, registry) for served in self.registries)

    def request_or_decline(self, context: RequestContext, declined: DeclinedRegistries | None = None,
                           provider: str = "provider", global_chain: bool = False) -> dict[str, Any] | str:
        """The `get` npm sends, or the answer npm already has without sending
        anything: `try-next-provider` when the provider's hello leaves this
        registry out or it declined it earlier in the command, and
        `try-next-provider-not-found` when it answered `not-found` for this
        registry and scope earlier."""
        if declined is not None:
            remembered = declined.remembered(provider, context.registry, context.scope)
            if remembered is not None:
                return remembered
        if not self.serves(context.registry, global_chain):
            if declined is not None:
                declined.record(provider, context.registry, "try-next-provider")
            return "try-next-provider"
        return self.build_request(context)

    def answer_in_chain(self, request: dict[str, Any], response: dict[str, Any],
                        declined: DeclinedRegistries, provider: str = "provider") -> str:
        """`handle_response` for a provider of a chain: a `url-not-supported`
        or `not-found` is remembered for the rest of the command, so the
        provider is not asked again about that registry (or, for `not-found`,
        that registry and scope)."""
        outcome = self.handle_response(request, response)
        if request.get("kind") != "erase":
            declined.record(provider, request["registry"], outcome, request.get("scope"), request.get("operation"))
        return outcome

    def receive_hello(self, message: dict[str, Any]) -> int:
        self._require_state(ClientState.SPAWNED)
        try:
            versions, capabilities = validate_hello(message)
        except ProtocolViolation:
            self.state = ClientState.FAILED
            raise
        if PROTOCOL_VERSION not in versions:
            self.state = ClientState.FAILED
            if self.config.configured:
                raise ProtocolViolation("no compatible protocol version")
            return 0
        self.version = PROTOCOL_VERSION
        self.capabilities = frozenset(capability for capability in capabilities if capability in SUPPORTED_CAPABILITIES)
        self.registries = message.get("registries")
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
        if not isinstance(response, dict):
            raise ProtocolViolation("response must be an object")
        _check_strings(response)
        if ("Ok" in response) == ("Err" in response):
            raise ProtocolViolation("response must contain exactly one of Ok or Err")
        if "Err" in response:
            return self._handle_error(request, response["Err"])
        ok = response["Ok"]
        if not isinstance(ok, dict):
            raise ProtocolViolation("Ok response must be an object")
        kind = ok.get("kind")
        # open, as request kinds are: a newer client may add a kind within v1,
        # and the pairing with the request is what rejects a bogus answer
        if not _is_identifier(kind):
            raise ProtocolViolation(f"Ok.kind must match {IDENTIFIER_PATTERN}: {kind!r}")
        if kind != request.get("kind"):
            raise ProtocolViolation("Ok.kind must match request kind")
        auth, cache, expires_at, granularity, operation_independent = validate_ok(ok)
        if isinstance(auth, dict) and auth.get("type") == ANONYMOUS_AUTH_TYPE:
            # valid only as the answer to a first `get` for `read`: anything
            # else is a malformed answer, as a bearer answer with no token is
            if (
                kind not in ANONYMOUS_REQUEST_KINDS
                or request.get("operation") not in ANONYMOUS_OPERATIONS
                or request.get("retry")
            ):
                raise ProtocolViolation("an anonymous answer is valid only for a get for read that is not a retry")
        if kind != "get":
            return kind
        granularity, operation_independent = self._binding(request, granularity, operation_independent)
        issuance = Issuance(
            id=len(self.issued) + 1,
            auth=auth,
            granularity=granularity,
            registry=request["registry"],
            operation=request.get("operation"),
            scope=request.get("scope"),
            package=request.get("package"),
            version=request.get("version"),
        )
        self.issued[issuance.id] = issuance
        self.last_issuance = issuance.id
        self._store_token(request, auth, cache, expires_at, granularity, operation_independent, issuance.id)
        return "ok"

    def reject_credential(
        self,
        context: RequestContext,
        auth_challenges: list[str] | None = None,
        now: int = 0,
        issuance: int | None = None,
    ) -> dict[str, Any] | None:
        """A 401 that leads to `erase`. `issuance` is the answer whose credential
        the rejected request carried; without it, the one this context's lookup
        serves now. An issuance already erased or replaced sends no erase: the
        request goes again with what the cache now holds, and that counts as its
        one retry. Otherwise every cache entry of that issuance is dropped, at
        every level, and the erase carries the context of the `get` that produced
        it (version included) and the response's granularity, cached or not.
        Returns None for an issuance that was already retired. npm always sends
        `erase` otherwise: there is no capability that suppresses it, and a
        provider with nothing to erase answers `Ok`."""
        self._require_state(ClientState.READY)
        if issuance is None:
            served = self.lookup(context.registry, context.scope, context.package, context.operation, now)
            issuance = served.issuance if served is not None else self._latest_issuance(context)
        if issuance is not None and issuance in self.retired:
            return None
        record = self.issued.get(issuance) if issuance is not None else None
        if issuance is not None:
            self._retire(issuance)
        request: dict[str, Any] = {
            "v": self.version,
            "kind": "erase",
            "registry": context.registry,
            "operation": record.operation if record is not None else context.operation,
        }
        scope = record.scope if record is not None else context.scope
        package = record.package if record is not None else context.package
        version = record.version if record is not None else context.version
        if scope is not None:
            request["scope"] = scope
        if package is not None:
            request["package"] = package
        if version is not None:
            request["version"] = version
        request["granularity"] = record.granularity if record is not None else "registry"
        if auth_challenges:
            request["authChallenges"] = list(auth_challenges)
        validate_request(request)
        return request

    def retry_request(
        self,
        context: RequestContext,
        http_status: int,
        auth_challenges: list[str] | None = None,
    ) -> dict[str, Any]:
        """The `get` that follows a rejected registry request: the context of
        the failed request, `retry: true`, the status of the rejection and the
        challenges of its response. It is sent after an erase (401) or without
        one (403), and for a request whose answer was already erased or
        replaced (`request_after_stale`)."""
        request = self.build_request(context)
        request["retry"] = True
        request["httpStatus"] = http_status
        if auth_challenges:
            request["authChallenges"] = list(auth_challenges)
        validate_request(request)
        return request

    def request_after_stale(
        self,
        context: RequestContext,
        http_status: int,
        issuance: int,
        now: int = 0,
        auth_challenges: list[str] | None = None,
    ) -> dict[str, Any] | None:
        """A 401 or 403 on a request whose answer npm had already erased or
        replaced: no erase and no retry of the usual kind. The request goes
        again with what the cache now holds, and `None` is returned; on a
        cache miss the provider is asked, and that `get` is the request's one
        retry, so it carries `retry: true` and the `httpStatus` of the stale
        rejection, as the retry after an erase does. A provider that saw a
        plain `get` could hand out the token it has just been told was
        refused."""
        self._require_state(ClientState.READY)
        if issuance not in self.retired:
            raise ProtocolViolation("the answer was not erased or replaced: this is the ordinary rejection")
        if self.lookup(context.registry, context.scope, context.package, context.operation, now) is not None:
            return None
        return self.retry_request(context, http_status, auth_challenges)

    def refused_by_403(self, issuance: int) -> bool:
        """A 403 on a request that carried `issuance`. Returns whether a retry
        `get` goes out: not for an issuance already erased or replaced (the
        request goes again with what the cache holds). No erase either way."""
        return issuance not in self.retired

    def replace_after_403(self, issuance: int) -> None:
        """The 403 retry was answered `Ok`: drop every entry of the refused
        issuance, as an erase does but without sending one, so the retry's
        credential is not shadowed by the refused one."""
        self._retire(issuance)

    def evict_rejected(self, erase_request: dict[str, Any]) -> None:
        """Transcript replay of what the client did before it sent this `erase`:
        the erase carries the context of the `get` that produced the rejected
        credential, so the same lookup finds the entry that served it."""
        context = RequestContext(
            registry=erase_request["registry"],
            scope=erase_request.get("scope"),
            package=erase_request.get("package"),
            operation=erase_request.get("operation", "read"),
            version=erase_request.get("version"),
        )
        served = self.lookup(context.registry, context.scope, context.package, context.operation)
        if served is not None and served.issuance is not None:
            self._retire(served.issuance)

    def _latest_issuance(self, context: RequestContext) -> int | None:
        """The answer a request with this context carried when the cache holds
        none (`cache: "never"`): the latest one for the same registry, scope,
        package and operation."""
        for issuance in sorted(self.issued.values(), key=lambda record: record.id, reverse=True):
            if (issuance.registry, issuance.scope, issuance.package) == (context.registry, context.scope, context.package) \
                    and issuance.operation == context.operation:
                return issuance.id
        return None

    def _retire(self, issuance: int) -> None:
        """Drops every cache entry that serves this credential, at every level,
        and retires each answer that carried it."""
        auth = self.issued[issuance].auth if issuance in self.issued else None
        self.retired.add(issuance)
        for key, entry in list(self.cache.items()):
            if entry.issuance == issuance or (auth is not None and entry.auth == auth):
                if entry.issuance is not None:
                    self.retired.add(entry.issuance)
                del self.cache[key]

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
                    registry_key(registry),
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
        # open, as request kinds are: a provider newer than npm may answer with
        # a kind this version does not know, which is read as the most cautious
        # known one (`other`: the request fails, naming the provider)
        if not _is_identifier(kind):
            raise ProtocolViolation(f"Err.kind must match {IDENTIFIER_PATTERN}: {kind!r}")
        if kind not in ERROR_KINDS:
            kind = UNKNOWN_ERROR_KIND
        if "message" in err and not isinstance(err["message"], str):
            raise ProtocolViolation("Err.message must be a string")
        if "causedBy" in err and (
            not isinstance(err["causedBy"], list) or not all(isinstance(item, str) for item in err["causedBy"])
        ):
            raise ProtocolViolation("Err.causedBy must be string[]")
        if request.get("kind") == "erase":
            # the cache already dropped the credential; whatever the provider
            # says about forgetting it, the retry still goes out
            return ERASE_ERROR_OUTCOMES[kind]
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
        issuance: int | None = None,
    ) -> None:
        if cache == "never":
            return
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
            issuance=issuance,
        )
        self.cache[cache_key(entry)] = entry

    @staticmethod
    def _binding(request: dict[str, Any], granularity: str, operation_independent: bool) -> tuple[str, bool]:
        """An answer for any operation but `read` serves that operation only and,
        when the request names a package, that package only, whatever the
        provider said: a workspace publish asks once per package, and a
        `stage-read` answer never serves the write after it."""
        if request.get("operation") in OPERATION_BOUND_EXCEPT:
            return granularity, operation_independent
        if PACKAGE_BOUND_WHEN_PRESENT and request.get("package") is not None:
            granularity = "package"
        return granularity, False

    def _require_state(self, expected: ClientState) -> None:
        if self.state != expected:
            raise ProtocolViolation(f"expected state {expected.value}, got {self.state.value}")


def registry_key(registry: str) -> str:
    """The registry as the cache key holds it. The scheme is part of it
    (`cache.schemeInKey`): an answer for `https://host/` never serves
    `http://host/`, which a provider may treat differently (it declines the
    `http:` form of a registry it serves over `https:`)."""
    if SCHEME_IN_CACHE_KEY:
        return registry
    return re.sub(r"^[A-Za-z][A-Za-z0-9+.-]*:", "", registry)


def cache_key(entry: CacheEntry) -> CacheKey:
    return CacheKey(
        entry.granularity,
        registry_key(entry.registry),
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


# every integer of the protocol fits what every JSON reader holds exactly
MAX_SAFE_INTEGER = 2**53 - 1


def _is_int(value: Any) -> bool:
    """An integer as JSON has it: `1`, `1.0` and `1e0` are one number, and none
    is beyond 2^53 - 1 in either direction."""
    if isinstance(value, bool):
        return False
    if isinstance(value, float):
        return value.is_integer() and abs(value) <= MAX_SAFE_INTEGER
    return isinstance(value, int) and abs(value) <= MAX_SAFE_INTEGER


def _check_strings(value: Any) -> None:
    """No string, member names included, holds a lone surrogate, and no number
    is beyond a double: a message is UTF-8, which cannot spell the one, and the
    readers that can hold either differ."""
    # a stack of its own: a message may nest as deep as the JSON reader let it
    pending = [value]
    while pending:
        value = pending.pop()
        if isinstance(value, str):
            try:
                value.encode("utf-8")
            except UnicodeEncodeError:
                raise ProtocolViolation("a string holds a lone surrogate") from None
        elif isinstance(value, float):
            if value != value or value in (float("inf"), float("-inf")):
                raise ProtocolViolation("a number is beyond a double")
        elif isinstance(value, list):
            pending.extend(value)
        elif isinstance(value, dict):
            for key, item in value.items():
                pending.append(key)
                pending.append(item)


def _is_enum(value: Any, allowed: frozenset[str]) -> bool:
    return isinstance(value, str) and value in allowed


def _is_identifier(value: Any) -> bool:
    # `$` in ECMA-262 does not match before a trailing newline, so fullmatch
    return isinstance(value, str) and _IDENTIFIER.fullmatch(value) is not None


def _is_nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and value != ""


# the schema's `scope` pattern `^@[^/]+$`: `[^/]` takes a newline, so "@scope\n" is a scope
# here as in ECMA-262; fullmatch, because Python's `$` would also take one more after it
_SCOPE = re.compile(r"@[^/]+")
# the schema's `kind` and `operation` pattern: new values may appear within v1
_IDENTIFIER = re.compile(IDENTIFIER_PATTERN)
# the schema's hello `registries` item pattern
_SERVED_REGISTRY = re.compile(r"https?://[^/?#\s@\\]+(/[^?#\s\\]*)?")


def validate_hello(message: Any) -> tuple[list[int], list[str]]:
    """Schema `hello`: v is a non-empty array of unique integers >= 1;
    capabilities, when present, is an array of unique non-empty strings."""
    if not isinstance(message, dict):
        raise ProtocolViolation("provider hello must be an object")
    _check_strings(message)
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


def _canonical(url: str) -> tuple[str | None, str, int | None, str] | None:
    """Scheme (None for a `//host/path/` key), host (lowercase, punycode),
    port (None when default), and path with dot segments resolved, ending
    in `/`. The path keeps its case and its percent-encodings. `None` for a
    URL that has no canonical form (a port over 65535, a host label over 63
    characters, an unpaired bracket): the schema accepts such a hello entry and
    it matches nothing."""
    try:
        parts = urlsplit(url)
        scheme = parts.scheme.lower() or None
        host = ".".join(label.encode("idna").decode("ascii") if label else label
                        for label in (parts.hostname or "").split("."))
        port = parts.port
    except (ValueError, UnicodeError):
        return None
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
    `served` carries one (a hello entry), not for a `//host/path/` key. A URL
    with no canonical form matches nothing and is matched by nothing."""
    canonical_served, canonical_url = _canonical(served), _canonical(url)
    if canonical_served is None or canonical_url is None:
        return False
    served_scheme, served_host, served_port, served_path = canonical_served
    scheme, host, port, path = canonical_url
    if served_scheme is None and scheme is not None and port == _DEFAULT_PORTS.get(scheme):
        port = None
    if served_scheme is not None and served_scheme != scheme:
        return False
    return (served_host, served_port) == (host, port) and path.startswith(served_path)


def validate_request(message: dict[str, Any]) -> None:
    if not isinstance(message, dict):
        raise ProtocolViolation("request must be an object")
    _check_strings(message)
    if not _is_int(message.get("v")) or message.get("v") != PROTOCOL_VERSION:
        raise ProtocolViolation("request must use negotiated protocol version")
    if not _is_identifier(message.get("kind")):
        raise ProtocolViolation(f"request kind must match {IDENTIFIER_PATTERN}: {message.get('kind')!r}")
    if not isinstance(message.get("registry"), str):
        raise ProtocolViolation("request requires registry string")
    if "scope" in message:
        scope = message["scope"]
        if not isinstance(scope, str) or not _SCOPE.fullmatch(scope):
            raise ProtocolViolation("scope must match ^@[^/]+$; it is absent for an unscoped package")
    for name in ("package", "version", "command", "token"):
        if name in message and not _is_nonempty_string(message[name]):
            raise ProtocolViolation(f"{name} must be a non-empty string")
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
    if kind == "erase":
        if "operation" not in message or "granularity" not in message:
            raise ProtocolViolation("erase requests carry the get's operation and the response's granularity")
    if operation in OPERATIONS_REQUIRING_VERSION and "version" not in message:
        raise ProtocolViolation(f"{operation} requires version")
    # present means present: the schema gives these a type, and null is none
    if "retry" in message and not isinstance(message["retry"], bool):
        raise ProtocolViolation("retry must be boolean")
    if "httpStatus" in message and (
        not _is_int(message["httpStatus"]) or not 100 <= message["httpStatus"] <= 599
    ):
        raise ProtocolViolation("httpStatus must be an HTTP status code")
    if message.get("retry") is True and "httpStatus" not in message:
        raise ProtocolViolation("retry=true requires httpStatus")
    if "authChallenges" in message and (
        not isinstance(message["authChallenges"], list)
        or not all(isinstance(challenge, str) for challenge in message["authChallenges"])
    ):
        raise ProtocolViolation("authChallenges must be string[]")


def validate_auth(auth: Any) -> None:
    if not isinstance(auth, dict):
        raise ProtocolViolation("Ok.auth is required")
    auth_type = auth.get("type")
    if not _is_identifier(auth_type):
        raise ProtocolViolation(f"auth.type must match {IDENTIFIER_PATTERN}: {auth_type!r}")
    if auth_type not in SUPPORTED_AUTH_TYPES:
        # npm has nothing it can send: the request fails as an `other` answer
        raise ProviderFailure(f"other: unknown auth.type {auth_type!r}")
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
    unknown_auth: ProviderFailure | None = None
    if kind == "get" or "auth" in ok:
        try:
            validate_auth(auth)
        except ProviderFailure as failure:
            # a failure of the request, but only once the rest of the message
            # is known to be well formed: a malformed one is a protocol violation
            unknown_auth = failure
    cache = ok.get("cache", DEFAULT_CACHE_POLICY)
    if not _is_identifier(cache):
        raise ProtocolViolation(f"cache must match {IDENTIFIER_PATTERN}: {cache!r}")
    if cache not in SUPPORTED_CACHE:
        cache = UNKNOWN_CACHE
    expires_at = ok.get("expiresAt")
    if "expiresAt" in ok and (not _is_int(expires_at) or expires_at < 0):
        raise ProtocolViolation("expiresAt must be an integer Unix timestamp >= 0")
    if cache == "expires" and "expiresAt" not in ok:
        raise ProtocolViolation("cache=expires requires expiresAt")
    granularity = ok.get("granularity", DEFAULT_GRANULARITY)
    if not _is_identifier(granularity):
        raise ProtocolViolation(f"granularity must match {IDENTIFIER_PATTERN}: {granularity!r}")
    if granularity not in SUPPORTED_GRANULARITY:
        granularity = UNKNOWN_GRANULARITY
    operation_independent = ok.get("operationIndependent", OPERATION_INDEPENDENT_DEFAULT)
    if not isinstance(operation_independent, bool):
        raise ProtocolViolation("operationIndependent must be boolean")
    if operation_independent and isinstance(auth, dict) and auth.get("type") == ANONYMOUS_AUTH_TYPE:
        raise ProtocolViolation("an anonymous answer is never operation independent")
    if unknown_auth is not None:
        raise unknown_auth
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
    `stored-credential` (the credential in `.npmrc`), `anonymous`, or `fail`.
    `message` says why a failure that no provider's answer explains happened."""

    result: str
    entry: int | None = None
    warnings: tuple[str, ...] = ()
    message: str = ""


class ProviderListing(NamedTuple):
    """One provider of a chain, as its hello described it: `registries` is
    the hello's list, or None when it had none."""

    name: str
    registries: list[str] | None = None


def _host(url: str) -> str | None:
    canonical = _canonical(url)
    return canonical[1] if canonical is not None else None


def listed_forms(registries: list[str] | None, registry: str) -> list[str]:
    """The entries of a hello's `registries` that name the host of `registry`,
    in any form: another scheme, port or path on that host."""
    wanted = _host(registry)
    if not registries or wanted is None:
        return []
    return [entry for entry in registries if _host(entry) == wanted]


def global_chain_hello_warning(name: str, registries: list[str] | None) -> str | None:
    """What npm logs at `warn`, once per command, when the hello of a provider
    in the global chain has no `registries`: it serves no registry."""
    if registries is not None:
        return None
    return f"{name} sent no registries: a provider in the global chain must list them, so it serves no registry"


def npm_token_serves(source: str) -> bool:
    """Whether `npm:token`, listed or implicit, serves a credential written in
    a config source: the user and global files, the environment and the command
    line, never a project `.npmrc` (or a user or global file the command line
    or the environment chose from inside a project, which is a `project`)."""
    return source in STORED_CREDENTIAL_SOURCES


PROJECT_CREDENTIAL_WARNING = (
    "a credential in project config is not sent through a credentialProvider chain: "
    "move it to the user's config or the environment, or remove it"
)


def resolve_chain(
    answers: list[str],
    *,
    per_registry: bool,
    stored_credential: bool,
    project_credential: bool = False,
    oidc_token: bool = False,
    registry: str | None = None,
    providers: list[ProviderListing] | None = None,
) -> ChainOutcome:
    """The end of a provider chain. `answers` holds, in chain order, either
    `STORED_CREDENTIAL_ENTRY` (`npm:token`) or one provider's outcome: `ok`,
    `try-next-provider` (url-not-supported), `try-next-provider-not-found`,
    `no-common-version`, or `fail` (any other error, a spawn failure, an
    oversized line, a timeout).

    `stored_credential` says that a credential `npm:token` may serve exists
    (see `npm_token_serves`); `project_credential` that one written in project
    config does, which no chain ever serves and which is warned about, once per
    registry per command, wherever a chain applies.

    A global chain that does not list `npm:token` ends with it implicitly, but
    only while every provider before it declined the registry: after a
    `not-found` the stored credential is used only where the chain lists
    `npm:token`, and a version mismatch fails like any other error. A
    per-registry list never consults a stored credential it does not list,
    and says so.

    `registry` and `providers` (each provider's hello, in chain order) say what
    the hellos list. A global chain every provider of which declined the
    registry does not fall back to a stored credential where some provider's
    hello lists the registry's host in any form: that is a URL form the
    provider declined, so the request fails, naming the provider and the forms
    it lists. On a host no hello lists no provider stands behind it, and the
    fallback is what npm does without providers, restricted to what
    `npm:token` serves, without a warning. A listed `npm:token` follows the
    same rule: where an earlier provider answered url-not-supported for a
    registry whose host its hello lists, the entry sends no stored credential
    and the request fails the same way."""
    if oidc_token:
        # a token from a successful trusted-publishing exchange: no provider is
        # asked, and it is not a stored credential, so nothing is "ignored"
        return ChainOutcome("oidc")
    entries = list(answers)
    listed = STORED_CREDENTIAL_ENTRY in entries

    def done(result: str, entry: int | None = None, *warnings: str) -> ChainOutcome:
        if per_registry and stored_credential and not listed and result != "stored-credential":
            warnings = ("stored credential ignored: the per-registry list does not include npm:token", *warnings)
        if entries and project_credential:
            warnings = (PROJECT_CREDENTIAL_WARNING, *warnings)
        return ChainOutcome(result, entry, tuple(warnings))

    if not entries:
        # no provider configured for the registry: what npm does today, from
        # every source
        return done("stored-credential" if (stored_credential or project_credential) else "anonymous")
    not_found = False
    declined_before: list[ProviderListing] = []
    provider_index = 0
    for index, answer in enumerate(entries):
        if answer == STORED_CREDENTIAL_ENTRY:
            if registry is not None and providers is not None:
                # a stored credential is never sent to a URL form a provider
                # declined on a host its hello lists, listed or implicit
                forms = [(provider.name, listed_forms(provider.registries, registry)) for provider in declined_before]
                forms = [(name, listing) for name, listing in forms if listing]
                if forms:
                    return _listed_host_failure(registry, forms, index)
            if stored_credential:
                return done("stored-credential", index)
            continue
        provider_index += 1
        if answer == "ok":
            return done("ok", index)
        if answer == "try-next-provider":
            if providers is not None and provider_index <= len(providers):
                declined_before.append(providers[provider_index - 1])
            continue
        if answer == "try-next-provider-not-found":
            not_found = True
            continue
        return done("fail", index)
    if not_found:
        return done("fail")
    if per_registry:
        return done("fail")
    if not listed and registry is not None and providers is not None:
        forms = [(provider.name, listed_forms(provider.registries, registry)) for provider in providers]
        forms = [(name, listing) for name, listing in forms if listing]
        if forms:
            return _listed_host_failure(registry, forms, None)
    if stored_credential and not listed:
        # no provider's hello lists this host, so none stands behind it: what
        # `npm:token` serves, with nothing said about it
        return done("stored-credential")
    return done("anonymous")


def _listed_host_failure(registry: str, forms: list[tuple[str, list[str]]], entry: int | None) -> ChainOutcome:
    named = "; ".join(f"{name} lists {', '.join(listing)}" for name, listing in forms)
    return ChainOutcome(
        GLOBAL_CHAIN_LISTED_HOST_OUTCOME, entry, (),
        f"{registry} is a URL form a provider declined on a host its hello lists, "
        f"so npm sends no stored credential: {named}"
        f"; the remedy is a per-registry list for it that holds just {STORED_CREDENTIAL_ENTRY}",
    )


# The checks npm makes before it sends a provider's credential, from the first
# release (the same rules Phase 1a's runner makes for a helper)
_LOOPBACK_HOST_PROVIDER = re.compile(r"^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$")


def provider_route_outcome(
    scheme: str,
    hostname: str,
    project_route_keys: tuple[str, ...] = (),
) -> str:
    """What npm does with a provider's credential before it sends a request:
    `plain-http` for an `http:` URL to a host that is not this machine,
    `project-route` when `ca`, `cafile` or `strict-ssl=false` came from the
    project layer, or when `proxy` or `https-proxy` did and the request is
    `http:` to this machine (a proxy tunnels an `https:` request and cannot
    read it), otherwise `sent`. The checks are made for every request and in
    this order, and a refusal starts no provider."""
    loopback = bool(_LOOPBACK_HOST_PROVIDER.match(hostname))
    if scheme == "http:" and not loopback:
        return "plain-http"
    certificate = {"ca", "cafile", "strict-ssl"}
    proxy = {"proxy", "https-proxy"}
    keys = set(project_route_keys)
    if keys & certificate:
        return "project-route"
    if keys & proxy and scheme == "http:" and loopback:
        return "project-route"
    return "sent"


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
        # npm-registry-fetch splits the header at commas and looks for the whole
        # items `ipaddress` and `otp` (`indexOf` on the array, not on the
        # string): `Basic realm="footprint"` is neither
        challenges = re.split(r",\s*", www_authenticate.lower())
        if "ipaddress" in challenges:
            return "eauthip"
        if "otp" in challenges:
            return "otp"
        return "otp" if asks_otp else "reject"
    return "otp" if asks_otp else "reject"


def rejection_action(status: int, www_authenticate: str | None = None, body: Any = None,
                     retried: bool = False) -> tuple[bool, bool, str]:
    """What npm does when the registry answers a request made with a provider's
    credential: (erase, retry, outcome). A 401 the OTP classification claims
    keeps the credential; any other 401 erases it and retries once, and a 401
    on the retry's credential erases it without retrying again; a 403 retries
    once without erase.""" 
    if status == 401:
        kind = classify_401(www_authenticate, body)
        if kind == "otp":
            return False, False, "otp-prompt"
        if kind == "eauthip":
            return False, False, "eauthip"
        return True, not retried, "rejected"
    if status == 403:
        return False, not retried, "forbidden"
    return False, False, "other"


class StrayLine(ProtocolViolation):
    """A line the provider wrote while no request was outstanding."""


def read_provider_line(raw: bytes, *, first: bool = False, outstanding: bool = True) -> Any | None:
    """What npm makes of one line of a provider's stdout, newline and all.

    `first` is the first line of the stream: a UTF-8 byte order mark before it
    is skipped, as Phase 1a skips one before a helper's output. A line of
    nothing but spaces, tabs and carriage returns is blank and ignored, whether
    or not a request is outstanding: it is no stray line. A carriage return
    before the newline is trailing whitespace. Any other line while no request
    is outstanding is a `StrayLine`, and one that is over the size limit or is
    not JSON, or not UTF-8, is a protocol violation.

    No error quotes the line, which may carry a credential: each says how long
    the line was and nothing else. A line npm reads after it sent the next
    request cannot be told from the answer to it, so the caller passes
    `outstanding` as it stood when the line arrived."""
    import json

    length = len(raw)
    if first and raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    if length > LINE_SIZE_MINIMUM:
        raise ProtocolViolation(f"a line of {length} bytes is over the limit of {LINE_SIZE_MINIMUM}")
    if not raw.strip(b" \t\r\n"):
        return None
    if not outstanding:
        raise StrayLine(f"a line of {length} bytes arrived while no request was outstanding")
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        # `from None`: the decoder's message may quote the text
        raise ProtocolViolation(f"a malformed line of {length} bytes") from None


@dataclass
class ProviderRestarts:
    """One provider across an npm command. What ends a session, what happens to
    the request in flight, what the next request gets and whether the end
    counts toward the limit is `SESSION_ENDS`, a table of the policy. A session
    that ends in a failure that counts is replaced by the next request, until
    FAILED_SESSIONS_BEFORE_NO_RESTART of them have ended in one command; a
    provider whose hello failed is not started again. The requests queued
    behind a failed one fail with it; the cache stays."""

    kills: int = 0
    failed: list[str] = field(default_factory=list)
    skipped: bool = False
    session_open: bool = False
    warnings: list[str] = field(default_factory=list)
    starts: int = 0

    def start(self) -> None:
        """The next request needed a provider and started a process."""
        if not self.may_start():
            raise ProtocolViolation("the provider is not started again")
        self.starts += 1
        self.session_open = True

    def end(self, cause: str, queued: tuple[str, ...] | list[str] = (), name: str = "provider") -> list[str]:
        """A session ends for `cause`, a key of `SESSION_ENDS`; the requests
        waiting on the provider, in order, are the ones that fail when the
        cause fails them. A stray line makes npm warn, naming the provider."""
        row = SESSION_ENDS[cause]
        if row["session"] == "ends":
            self.session_open = False
        if row["counts"]:
            self.kills += 1
        if row["next"] == "skipped":
            self.skipped = True
        if cause == "stray-line":
            self.warnings.append(f"{name} wrote a line while no request was outstanding; it was ended")
        failing = list(queued) if row["request"] == "fails" else []
        self.failed.extend(failing)
        return failing

    def on_timeout(self, queued: list[str]) -> list[str]:
        """The kill: the requests waiting on the provider, in order, are the
        ones that fail (the cache is not touched)."""
        return self.end("timeout", queued)

    def npm_exits(self, outstanding: bool) -> str:
        """npm ends the command. A provider with a request outstanding (after
        Ctrl-C, or a failure elsewhere) is killed, as for a timeout, so that one
        waiting on a prompt is not left behind; an idle one gets its stdin closed
        and exits. Neither counts toward the limit."""
        if not self.session_open:
            return "none"
        self.session_open = False
        return "kill" if outstanding else "close-stdin"

    def next_request(self) -> str:
        """What the next request that needs the provider gets: `same-process`,
        `new-process`, or `none` for a provider that is skipped or has
        failed too often."""
        if self.session_open:
            return "same-process"
        return "new-process" if self.may_start() else "none"

    def may_start(self) -> bool:
        return not self.skipped and self.kills < FAILED_SESSIONS_BEFORE_NO_RESTART


@dataclass
class ProviderPool:
    """The providers of one npm command. A provider is identified by its
    resolved executable path and its arguments (after expansion), nothing else:
    one identity is one process per command, whether it is named by the global
    chain or by several per-registry lists, and two entries that differ in path
    or in an argument are two providers, each with its own limit."""

    providers: dict[tuple[str, tuple[str, ...]], ProviderRestarts] = field(default_factory=dict)

    def provider(self, path: str, arguments: tuple[str, ...] | list[str] = ()) -> ProviderRestarts:
        return self.providers.setdefault((os.path.normcase(path), tuple(arguments)), ProviderRestarts())


@dataclass
class CommandWarnings:
    """The warnings of one npm command. Each is said once per registry per
    command: a credential in project config that a chain never serves, one
    that a per-registry list ignores, and an anonymous answer. A second command is a
    new object and says them again, which is what "on every command, so that it
    gets deleted" means."""

    said: set[tuple[str, str]] = field(default_factory=set)
    lines: list[str] = field(default_factory=list)

    def say(self, registry: str, outcome: ChainOutcome) -> list[str]:
        new = []
        for text in outcome.warnings:
            if (registry, text) not in self.said:
                self.said.add((registry, text))
                new.append(f"{registry}: {text}")
        self.lines.extend(new)
        return new

    def say_anonymous(self, registry: str, provider: str) -> list[str]:
        """An anonymous answer is said at `warn`, once per registry per
        command, naming the provider."""
        text = f"{provider} answered without a credential: requests to {registry} go out anonymously"
        if (registry, text) in self.said:
            return []
        self.said.add((registry, text))
        line = f"{registry}: {text}"
        self.lines.append(line)
        return [line]


class CommandRefused(RuntimeError):
    """npm refuses the command under a provider."""


# the operation each npm command sends (section 4 of the specification); a
# command that writes nothing and has no row sends `read`
_WHOLE_COMMANDS = {
    "install": "read", "ci": "read", "update": "read", "view": "read", "search": "read", "outdated": "read",
    "whoami": "read", "publish": "publish", "deprecate": "deprecate", "undeprecate": "deprecate",
    "unpublish": "unpublish", "access": "access", "team": "access", "org": "access", "trust": "trust",
    "token": "account",
}
_SUBCOMMANDS = {
    ("stage", "publish"): "stage", ("stage", "approve"): "publish", ("stage", "reject"): "stage-reject",
    ("stage", "list"): "stage-read", ("stage", "view"): "stage-read", ("stage", "download"): "stage-read",
    ("dist-tag", "add"): "dist-tag", ("dist-tag", "rm"): "dist-tag", ("dist-tag", "ls"): "read",
    ("owner", "add"): "owner", ("owner", "rm"): "owner", ("owner", "ls"): "read",
    ("profile", "get"): "account", ("profile", "set"): "account", ("profile", "disable-2fa"): "account",
}
# commands whose writes `--dry-run` skips, so every request they make is a read; any other
# command sends its operation whatever `dry-run` says, since a project `.npmrc` can set it
_DRY_RUN_READS = frozenset({"publish", "unpublish", "deprecate"})


def operation_for(command: str, subcommand: str | None = None, dry_run: bool = False) -> str:
    """The operation npm sends in every request of a command. `--dry-run` turns
    a `publish`, `unpublish` or `deprecate` into reads: a publish in a
    pull-request job asks for no write credential. `profile enable-2fa` is
    refused under a provider, since it may replace the stored credential with a
    token a provider's credential cannot take part in."""
    if (command, subcommand) == ("profile", "enable-2fa"):
        raise CommandRefused("profile enable-2fa is refused under a provider")
    operation = _SUBCOMMANDS.get((command, subcommand)) or _WHOLE_COMMANDS.get(command)
    if operation is None:
        raise KeyError(f"no operation for npm {command} {subcommand or ''}".strip())
    if dry_run and command in _DRY_RUN_READS:
        return "read"
    return operation


def loggable(message: dict[str, Any]) -> dict[str, Any]:
    """What npm logs of a request, at any level: the `token` of a `login` is
    left out, since it came from the person and is a credential."""
    return {name: value for name, value in message.items() if name != "token"}


# the lookup of `stage approve` and `reject` comes before the write of its own command
NOT_FOUND_NOT_REMEMBERED_FOR = frozenset({"stage-read"})


@dataclass
class DeclinedRegistries:
    """`url-not-supported` depends on `registry` alone, so the client remembers
    it per provider and registry for the rest of the command, and a provider
    that does not serve a registry is asked about it once. `not-found` is
    remembered the same way, for that provider, registry and scope (an
    unscoped package's being no scope): a provider that holds one scope of many
    is asked about each other scope once. The memory is not keyed by operation,
    because one npm command carries one operation; the one exception is the
    `stage-read` lookup that `stage approve` and `reject` make before their
    write, and a `not-found` answered to it is not remembered, so the write's
    `get` reaches the provider."""

    declined: set[tuple[str, str]] = field(default_factory=set)
    not_found: set[tuple[str, str, str | None]] = field(default_factory=set)

    def should_ask(self, provider: str, registry: str, scope: str | None = None) -> bool:
        return self.remembered(provider, registry, scope) is None

    def remembered(self, provider: str, registry: str, scope: str | None = None) -> str | None:
        """The answer npm gives without asking, or None when it asks."""
        if (provider, registry) in self.declined:
            return "try-next-provider"
        if (provider, registry, scope) in self.not_found:
            return "try-next-provider-not-found"
        return None

    def record(self, provider: str, registry: str, outcome: str, scope: str | None = None,
               operation: str | None = None) -> None:
        if outcome == "try-next-provider":
            self.declined.add((provider, registry))
        elif outcome == "try-next-provider-not-found" and operation not in NOT_FOUND_NOT_REMEMBERED_FOR:
            self.not_found.add((provider, registry, scope))


def validate_transcript(path: str, config: ProviderConfig | None = None) -> CredentialClientModel:
    client = CredentialClientModel(config=config or ProviderConfig())
    last_request: dict[str, Any] | None = None
    # since the last get that was not a retry: whether an erase went out, and
    # whether a retry did; a 403 retry follows no erase, and a request gets one
    erased_since_get = False
    retried_since_get = False
    # a provider process lives for one npm command: every request of a session
    # names the same one, and an `npm ci` and an `npm publish` are two sessions
    session_command: str | None = None
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
            if not client.serves(message["registry"]):
                raise ProtocolViolation(
                    f"npm sends a provider nothing about {message['registry']}: its hello leaves it out"
                )
            if "command" in message:
                if session_command not in (None, message["command"]):
                    raise ProtocolViolation(
                        f"one session serves one npm command: {session_command!r} and {message['command']!r}"
                    )
                session_command = message["command"]
            if message["kind"] == "erase":
                client.evict_rejected(message)
                erased_since_get = True
            elif message["kind"] == "get" and message.get("retry") is True:
                if retried_since_get:
                    raise ProtocolViolation("a registry request gets at most one provider retry")
                if message.get("httpStatus") == 403 and erased_since_get:
                    raise ProtocolViolation("a 403 retry follows no erase")
                retried_since_get = True
            elif message["kind"] == "get":
                erased_since_get = retried_since_get = False
            last_request = message
        elif actor == "provider":
            if last_request is None:
                raise ProtocolViolation("provider response without client request")
            try:
                client.handle_response(last_request, event.get("message"))
            except ProviderFailure:
                # that registry request fails and the session goes on; a
                # protocol violation is never caught
                pass
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


def _is_there(path: str) -> bool:
    """Whether a path is there, as the prototype means it: only a path that is
    not there (ENOENT, ENOTDIR) is told apart; one that cannot be read is left
    to spawn, which reports the real reason."""
    try:
        os.stat(path)
    except (FileNotFoundError, NotADirectoryError):
        return False
    except OSError as error:
        # on Windows libuv, and so Node, reads a name that cannot be one (a
        # control character, `*`, `?`) and a path with no such drive, share or
        # directory as ENOENT, where Python says what Windows did
        return getattr(error, "winerror", None) not in _WINDOWS_NOT_THERE
    return True


# ERROR_FILE_NOT_FOUND, PATH_NOT_FOUND, INVALID_DRIVE, BAD_NETPATH, BAD_NET_NAME,
# INVALID_NAME, BAD_PATHNAME, DIRECTORY
_WINDOWS_NOT_THERE = {2, 3, 15, 53, 67, 123, 161, 267}


def check_token_helper_config(
    value: str,
    config_source: str,
    exists: Callable[[str], bool] = _is_there,
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


# The hosts a helper's credential may be sent to over plain http: this machine,
# as the host of a parsed URL reads (a WHATWG URL has lowercased it, turned
# `127.1` into `127.0.0.1` and kept the brackets of an IPv6 address)
_LOOPBACK_HOST = re.compile(r"^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$")


def token_helper_route_outcome(
    scheme: str,
    hostname: str,
    run_credential: bool = False,
    project_route_keys: tuple[str, ...] = (),
) -> str:
    """What Phase 1a does with a request to a registry that has a helper, before
    any program starts: `run-credential` when the command line or the
    environment gave a credential for the registry's key (the helper is not run,
    that credential is used), `plain-http` for an `http:` URL to a host that is
    not this machine, `project-route` when `proxy`, `https-proxy`, `ca`,
    `cafile` (or `strict-ssl=false`) came from the project layer, otherwise
    `ran`. The checks are made for every request, and in this order."""
    if run_credential:
        return "run-credential"
    if scheme == "http:" and not _LOOPBACK_HOST.match(hostname):
        return "plain-http"
    if project_route_keys:
        return "project-route"
    return "ran"


def credential_in_use(helper: bool, file_credential: bool, run_credential: bool) -> str | None:
    """Which credential a request for a registry key carries when more than one is
    set for that key: one given on the command line or in the environment beats
    the helper (and OIDC lands in that layer, so it wins by the same rule); the
    helper beats one stored in a file."""
    if run_credential:
        return "run"
    if helper:
        return "helper"
    if file_credential:
        return "file"
    return None


PROJECT_MARKERS = ("package.json", ".git")


def containing_project(
    file_directories: list[str],
    home: str | None,
    exists: Callable[[str, str], bool],
) -> tuple[str, str] | None:
    """Phase 1a's location rule for a user or global file whose path the command
    line or the environment chose: the directory, and the mark in it, that makes
    the file a project's, or None. `file_directories` runs from the directory of
    the file's real path up to the filesystem root. The walk stops at home
    without looking at it, and goes on to the root for a file that is not below
    home (`home` is None when it is a filesystem root or not there). A `.git`
    that is a file counts as one that is a directory, and `node_modules` is no
    mark. Nothing here depends on the current directory, `--prefix`, `--global`
    or `location`."""
    for directory in file_directories:
        if home is not None and directory == home:
            return None
        for marker in PROJECT_MARKERS:
            if exists(directory, marker):
                return directory, marker
    return None
