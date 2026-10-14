from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import os
import re
from typing import Any, Callable, NamedTuple

from tests.generated_policy import (
    ALLOWED_CONFIG_SOURCES,
    DEFAULT_CACHE_POLICY,
    DEFAULT_GRANULARITY,
    ERROR_KINDS,
    EXPIRY_MARGIN_SECONDS,
    OPERATION_INDEPENDENT_DEFAULT,
    OPERATIONS_REQUIRING_VERSION,
    PROTOCOL_VERSION,
    SUPPORTED_AUTH_TYPES,
    SUPPORTED_CACHE,
    SUPPORTED_CAPABILITIES,
    SUPPORTED_GRANULARITY,
    SUPPORTED_OPERATIONS,
    SUPPORTED_REQUEST_KINDS,
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
        if kind == "not-found" and (not self.config.configured or self.config.legacy_fallback):
            return "legacy-auth"
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


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_enum(value: Any, allowed: frozenset[str]) -> bool:
    return isinstance(value, str) and value in allowed


def _is_nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and value != ""


# the schema's `scope` pattern, anchored the way ECMA-262 `$` is (no trailing newline)
_SCOPE = re.compile(r"@[^/]+")


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
    return versions, capabilities


def validate_request(message: dict[str, Any]) -> None:
    if not isinstance(message, dict):
        raise ProtocolViolation("request must be an object")
    if not _is_int(message.get("v")) or message.get("v") != PROTOCOL_VERSION:
        raise ProtocolViolation("request must use negotiated protocol version")
    if not _is_enum(message.get("kind"), SUPPORTED_REQUEST_KINDS):
        raise ProtocolViolation(f"unsupported request kind: {message.get('kind')!r}")
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
    if "operation" in message and not _is_enum(operation, SUPPORTED_OPERATIONS):
        raise ProtocolViolation("operation must be a supported operation")
    if kind == "get":
        if "operation" not in message:
            raise ProtocolViolation("get requests require a supported operation")
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
