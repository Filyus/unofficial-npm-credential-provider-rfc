from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import os
from typing import Any

from tests.generated_policy import (
    ALLOWED_CONFIG_SOURCES,
    DEFAULT_CACHE_POLICY,
    DEFAULT_GRANULARITY,
    ERROR_KINDS,
    OPERATION_INDEPENDENT_DEFAULT,
    PROTOCOL_VERSION,
    SUPPORTED_AUTH_TYPES,
    SUPPORTED_CACHE,
    SUPPORTED_CAPABILITIES,
    SUPPORTED_COMMANDS,
    SUPPORTED_GRANULARITY,
    SUPPORTED_OPERATIONS,
    SUPPORTED_REQUEST_KINDS,
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


@dataclass
class CredentialClientModel:
    config: ProviderConfig = field(default_factory=ProviderConfig)
    state: ClientState = ClientState.SPAWNED
    version: int | None = None
    capabilities: frozenset[str] = field(default_factory=frozenset)
    cache: dict[tuple[Any, ...], CacheEntry] = field(default_factory=dict)

    def receive_hello(self, message: dict[str, Any]) -> int:
        self._require_state(ClientState.SPAWNED)
        versions = message.get("v")
        if not isinstance(versions, list) or not all(isinstance(v, int) for v in versions):
            self.state = ClientState.FAILED
            raise ProtocolViolation("provider hello must contain v: number[]")
        capabilities = message.get("capabilities", [])
        if not isinstance(capabilities, list) or not all(isinstance(capability, str) for capability in capabilities):
            self.state = ClientState.FAILED
            raise ProtocolViolation("provider hello capabilities must be string[]")
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
        if kind != request.get("kind"):
            raise ProtocolViolation("Ok.kind must match request kind")
        if kind in {"login", "logout", "erase"}:
            return kind
        if kind == "get-batch":
            self._handle_batch_response(request, ok)
            return "ok"
        if kind not in {"get", "refresh"}:
            raise ProtocolViolation(f"unsupported Ok kind: {kind!r}")
        self._handle_token_response(request, ok)
        return "ok"

    def close(self) -> None:
        self._require_state(ClientState.READY)
        self.state = ClientState.CLOSED

    def _handle_error(self, request: dict[str, Any], err: Any) -> str:
        if not isinstance(err, dict):
            raise ProtocolViolation("Err response must be an object")
        kind = err.get("kind")
        if kind not in ERROR_KINDS:
            raise ProtocolViolation(f"unsupported error kind: {kind!r}")
        if kind == "url-not-supported":
            return "try-next-provider"
        if kind == "operation-not-supported" and request.get("kind") == "refresh":
            return "retry-get"
        if kind == "not-found" and (not self.config.configured or self.config.legacy_fallback):
            return "legacy-auth"
        raise ProviderFailure(kind)

    def _handle_batch_response(self, request: dict[str, Any], ok: dict[str, Any]) -> None:
        packages = request.get("packages")
        results = ok.get("results")
        if not isinstance(packages, list) or not isinstance(results, list):
            raise ProtocolViolation("get-batch requires packages[] and results[]")
        if len(packages) != len(results):
            raise ProtocolViolation("get-batch result count must match request count")
        shared = {
            "cache": ok.get("cache", DEFAULT_CACHE_POLICY),
            "expiresAt": ok.get("expiresAt"),
            "operationIndependent": ok.get("operationIndependent", OPERATION_INDEPENDENT_DEFAULT),
        }
        for package, result in zip(packages, results):
            merged = {**shared, **result}
            package_request = {
                **request,
                "scope": package.get("scope"),
                "package": package.get("package"),
            }
            self._handle_token_response(package_request, merged)

    def _handle_token_response(self, request: dict[str, Any], ok: dict[str, Any]) -> None:
        auth = ok.get("auth")
        validate_auth(auth)
        cache = ok.get("cache", DEFAULT_CACHE_POLICY)
        if cache not in SUPPORTED_CACHE:
            raise ProtocolViolation(f"unsupported cache policy: {cache!r}")
        expires_at = ok.get("expiresAt")
        if cache == "expires" and not isinstance(expires_at, int):
            raise ProtocolViolation("cache=expires requires expiresAt")
        granularity = ok.get("granularity", DEFAULT_GRANULARITY)
        if granularity not in SUPPORTED_GRANULARITY:
            raise ProtocolViolation(f"unsupported granularity: {granularity!r}")
        operation_independent = ok.get("operationIndependent", OPERATION_INDEPENDENT_DEFAULT)
        if not isinstance(operation_independent, bool):
            raise ProtocolViolation("operationIndependent must be boolean")
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


def cache_key(entry: CacheEntry) -> tuple[Any, ...]:
    key: list[Any] = [entry.registry]
    if entry.granularity in {"scope", "package"}:
        key.append(entry.scope)
    if entry.granularity == "package":
        key.append(entry.package)
    if not entry.operation_independent:
        key.append(entry.operation)
    return tuple(key)


def validate_request(message: dict[str, Any]) -> None:
    if not isinstance(message, dict):
        raise ProtocolViolation("request must be an object")
    if message.get("v") != PROTOCOL_VERSION:
        raise ProtocolViolation("request must use negotiated protocol version")
    if message.get("kind") not in SUPPORTED_REQUEST_KINDS:
        raise ProtocolViolation(f"unsupported request kind: {message.get('kind')!r}")
    if not isinstance(message.get("registry"), str):
        raise ProtocolViolation("request requires registry string")
    command = message.get("command")
    if command is not None and command not in SUPPORTED_COMMANDS:
        raise ProtocolViolation(f"unsupported npm command: {command!r}")
    kind = message["kind"]
    if kind in {"get", "get-batch"}:
        if message.get("operation") not in SUPPORTED_OPERATIONS:
            raise ProtocolViolation("get requests require a supported operation")
        if not isinstance(message.get("interactive"), bool):
            raise ProtocolViolation("get requests require interactive boolean")
    if kind == "get-batch" and not isinstance(message.get("packages"), list):
        raise ProtocolViolation("get-batch requires packages[]")
    if kind == "refresh" and not isinstance(message.get("refreshState"), str):
        raise ProtocolViolation("refresh requires refreshState")
    if message.get("operation") == "publish" and not isinstance(message.get("version"), str):
        raise ProtocolViolation("publish requires version")
    retry = message.get("retry")
    if retry is not None and not isinstance(retry, bool):
        raise ProtocolViolation("retry must be boolean")
    http_status = message.get("httpStatus")
    if http_status is not None and (
        not isinstance(http_status, int) or isinstance(http_status, bool) or not 100 <= http_status <= 599
    ):
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
    if auth_type not in SUPPORTED_AUTH_TYPES:
        raise ProtocolViolation(f"unsupported auth type: {auth_type!r}")
    if auth_type == "bearer" and not isinstance(auth.get("token"), str):
        raise ProtocolViolation("bearer auth requires token")
    if auth_type == "basic":
        if not isinstance(auth.get("username"), str) or not isinstance(auth.get("password"), str):
            raise ProtocolViolation("basic auth requires username and password")


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
