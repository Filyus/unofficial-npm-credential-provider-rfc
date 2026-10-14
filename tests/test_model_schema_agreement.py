"""The Python model must accept and reject exactly what spec/protocol-v1.schema.json
does. Every vector in tests/generated_protocol_vectors.json goes through the
model, and targeted cases pin each schema rule for every message kind; when
`jsonschema` is installed each targeted case is also checked against the schema
itself, so a case cannot drift from the reference."""

from __future__ import annotations

import copy
import json
from pathlib import Path
import unittest

from tests.protocol_model import (
    CredentialClientModel,
    ProtocolViolation,
    ProviderFailure,
    validate_auth,
    validate_request,
)

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / "spec" / "protocol-v1.schema.json").read_text(encoding="utf-8"))
VECTORS = json.loads((ROOT / "tests" / "generated_protocol_vectors.json").read_text(encoding="utf-8"))

REGISTRY = "https://registry.example.test/"
GET = {"v": 1, "kind": "get", "registry": REGISTRY, "operation": "read", "interactive": False}
BEARER = {"type": "bearer", "token": "t"}
KINDS = ("login", "logout", "get", "erase")

try:
    import jsonschema

    _VALIDATOR = jsonschema.Draft202012Validator(SCHEMA)
except ModuleNotFoundError:  # the schema cross-check is skipped, the model check is not
    _VALIDATOR = None


def run_model(message: object) -> None:
    """Feed a message to whichever model entry point handles its shape."""
    if isinstance(message, dict) and ("Ok" in message or "Err" in message or not message):
        client = CredentialClientModel()
        client.receive_hello({"v": [1]})
        ok = message.get("Ok")
        kind = ok.get("kind") if isinstance(ok, dict) and isinstance(ok.get("kind"), str) else "get"
        request = {**GET, "kind": kind}
        if kind not in KINDS:
            request["kind"] = "get"
        try:
            client.handle_response(request, message)
        except ProviderFailure:
            pass  # a protocol-valid error that stops npm: the message was accepted
    elif isinstance(message, dict) and "kind" in message:
        validate_request(message)
    else:
        CredentialClientModel().receive_hello(message)


def ok_response(kind: str, **changes: object) -> dict:
    ok = {"kind": kind, "auth": copy.deepcopy(BEARER)}
    ok.update(changes)
    return {"Ok": ok}


class VectorsThroughModelTests(unittest.TestCase):
    def test_every_valid_vector_is_accepted(self) -> None:
        for vector in VECTORS["validMessages"]:
            with self.subTest(vector["name"]):
                run_model(copy.deepcopy(vector["message"]))

    def test_every_invalid_vector_is_rejected(self) -> None:
        for vector in VECTORS["invalidMessages"]:
            with self.subTest(vector["name"]):
                with self.assertRaises(ProtocolViolation):
                    run_model(copy.deepcopy(vector["message"]))


def rejected_cases() -> list[tuple[str, object]]:
    cases: list[tuple[str, object]] = []
    # hello
    for name, v in (
        ("zero", [0]),
        ("negative", [-1]),
        ("bool", [True]),
        ("string", ["1"]),
        ("duplicate", [1, 1]),
        ("empty", []),
        ("not-array", 1),
    ):
        cases.append((f"hello-v-{name}", {"v": v}))
    cases.append(("hello-capability-empty", {"v": [1], "capabilities": [""]}))
    cases.append(("hello-capability-duplicate", {"v": [1], "capabilities": ["login", "login"]}))
    cases.append(("hello-capability-not-string", {"v": [1], "capabilities": [1]}))
    # request fields, on every kind
    for kind in KINDS:
        base = {**GET, "kind": kind}
        cases.append((f"request-{kind}-operation-unknown", {**base, "operation": "write"}))
        cases.append((f"request-{kind}-operation-not-string", {**base, "operation": ["read"]}))
        cases.append((f"request-{kind}-package-empty", {**base, "package": ""}))
        cases.append((f"request-{kind}-version-empty", {**base, "version": ""}))
        cases.append((f"request-{kind}-version-not-string", {**base, "version": 1}))
        cases.append((f"request-{kind}-interactive-string", {**base, "interactive": "yes"}))
        cases.append((f"request-{kind}-interactive-null", {**base, "interactive": None}))
        cases.append((f"request-{kind}-token-empty", {**base, "token": ""}))
        cases.append((f"request-{kind}-login-url-not-string", {**base, "loginUrl": 1}))
        for scope in ("@", "scope", "@a/b", "@scope\n/x", 1):
            cases.append((f"request-{kind}-scope-{scope!r}", {**base, "scope": scope}))
    cases.append(("request-version-bool", {**GET, "v": True}))
    cases.append(("request-publish-version-empty", {**GET, "operation": "publish", "version": ""}))
    # Ok, on every kind (the cache/expiresAt rules carry no kind condition)
    for kind in KINDS:
        cases.append((f"ok-{kind}-cache-unknown", ok_response(kind, cache="forever")))
        cases.append((f"ok-{kind}-expires-without-expires-at", ok_response(kind, cache="expires")))
        for value in (-1, True, 1.5, "1"):
            cases.append((f"ok-{kind}-expires-at-{value!r}", ok_response(kind, cache="expires", expiresAt=value)))
        cases.append((f"ok-{kind}-granularity-unknown", ok_response(kind, granularity="host")))
        cases.append((f"ok-{kind}-operation-independent-string", ok_response(kind, operationIndependent="no")))
        cases.append((f"ok-{kind}-bearer-token-empty", ok_response(kind, auth={"type": "bearer", "token": ""})))
        cases.append((f"ok-{kind}-auth-type-unknown", ok_response(kind, auth={"type": "digest"})))
    cases.append(("ok-get-missing-auth", {"Ok": {"kind": "get"}}))
    cases.append(("ok-unknown-kind", {"Ok": {"kind": "refresh"}}))
    for name, auth in (
        ("basic-username-empty", {"type": "basic", "username": "", "password": "p"}),
        ("basic-password-empty", {"type": "basic", "username": "u", "password": ""}),
        ("basic-password-missing", {"type": "basic", "username": "u"}),
        ("bearer-token-not-string", {"type": "bearer", "token": 1}),
    ):
        cases.append((f"ok-get-{name}", ok_response("get", auth=auth)))
    cases.append(("err-message-not-string", {"Err": {"kind": "other", "message": 1}}))
    cases.append(("err-caused-by-not-strings", {"Err": {"kind": "other", "causedBy": [1]}}))
    return cases


def accepted_cases() -> list[tuple[str, object]]:
    cases: list[tuple[str, object]] = [
        ("hello-v-many", {"v": [1, 2, 7]}),
        ("request-login-token-and-login-url", {
            "v": 1, "kind": "login", "registry": REGISTRY, "token": "t", "loginUrl": "https://x.test/login",
        }),
        ("request-scope-null", {**GET, "scope": None}),
        ("request-scope-ok", {**GET, "scope": "@scope"}),
        ("request-logout-with-operation", {**GET, "kind": "logout", "operation": "publish", "version": "1.0.0"}),
        ("err-full", {"Err": {"kind": "other", "message": "m", "causedBy": ["a"]}}),
    ]
    for kind in KINDS:
        cases.append((f"ok-{kind}-expires", ok_response(kind, cache="expires", expiresAt=0)))
        cases.append((f"ok-{kind}-basic", ok_response(kind, auth={"type": "basic", "username": "u", "password": "p"})))
    cases.append(("ok-logout-no-auth", {"Ok": {"kind": "logout"}}))
    return cases


class TargetedRuleTests(unittest.TestCase):
    def test_schema_and_model_agree_on_rejected_cases(self) -> None:
        for name, message in rejected_cases():
            with self.subTest(name):
                if _VALIDATOR is not None:
                    self.assertFalse(_VALIDATOR.is_valid(message), "the schema accepts this case")
                with self.assertRaises(ProtocolViolation):
                    run_model(copy.deepcopy(message))

    def test_schema_and_model_agree_on_accepted_cases(self) -> None:
        for name, message in accepted_cases():
            with self.subTest(name):
                if _VALIDATOR is not None:
                    self.assertTrue(_VALIDATOR.is_valid(message), "the schema rejects this case")
                run_model(copy.deepcopy(message))

    def test_failed_hello_leaves_client_failed(self) -> None:
        client = CredentialClientModel()
        with self.assertRaises(ProtocolViolation):
            client.receive_hello({"v": [1, 1]})
        self.assertEqual(client.state.value, "failed")

    def test_validate_auth_directly(self) -> None:
        for auth in ({"type": "bearer", "token": ""}, {"type": "basic", "username": "", "password": "p"}):
            with self.assertRaises(ProtocolViolation):
                validate_auth(auth)

    def test_rejected_ok_does_not_populate_the_cache(self) -> None:
        client = CredentialClientModel()
        client.receive_hello({"v": [1]})
        with self.assertRaises(ProtocolViolation):
            client.handle_response(GET, ok_response("get", cache="session", expiresAt=-1))
        self.assertEqual(client.cache, {})


if __name__ == "__main__":
    unittest.main()
