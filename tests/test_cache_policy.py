from __future__ import annotations

import unittest

from tests.protocol_model import CredentialClientModel, ProtocolViolation


REGISTRY = "https://registry.example.test/"


def request(
    operation: str = "read",
    scope: str | None = "@scope",
    package: str | None = "pkg",
) -> dict:
    message = {
        "v": 1,
        "kind": "get",
        "registry": REGISTRY,
        "operation": operation,
        "command": "install",
        "interactive": False,
    }
    if scope is not None:
        message["scope"] = scope
    if package is not None:
        message["package"] = package
    if operation == "publish":
        message["version"] = "1.2.3"
        message["command"] = "publish"
    return message


def ok(
    granularity: str = "registry",
    cache: str = "session",
    **extra: object,
) -> dict:
    payload = {
        "kind": "get",
        "auth": {"type": "bearer", "token": "token"},
        "cache": cache,
        "granularity": granularity,
    }
    payload.update(extra)
    return {"Ok": payload}


class CachePolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = CredentialClientModel()
        self.client.receive_hello({"v": [1]})

    def test_registry_granularity_uses_registry_key(self) -> None:
        self.client.handle_response(request(), ok("registry"))

        self.assertIn((REGISTRY,), self.client.cache)

    def test_scope_granularity_uses_registry_and_scope_key(self) -> None:
        self.client.handle_response(request(), ok("scope"))

        self.assertIn((REGISTRY, "@scope"), self.client.cache)

    def test_package_granularity_uses_registry_scope_and_package_key(self) -> None:
        self.client.handle_response(request(), ok("package"))

        self.assertIn((REGISTRY, "@scope", "pkg"), self.client.cache)

    def test_operation_dependent_token_includes_operation_in_key(self) -> None:
        self.client.handle_response(request("publish"), ok("scope", operationIndependent=False))

        self.assertIn((REGISTRY, "@scope", "publish"), self.client.cache)

    def test_cache_never_does_not_store_token(self) -> None:
        self.client.handle_response(request(), ok("scope", cache="never"))

        self.assertEqual(self.client.cache, {})

    def test_cache_expires_stores_expiration(self) -> None:
        self.client.handle_response(request(), ok("scope", cache="expires", expiresAt=1893456000))

        self.assertEqual(self.client.cache[(REGISTRY, "@scope")].expires_at, 1893456000)

    def test_default_cache_is_session_and_default_granularity_is_registry(self) -> None:
        self.client.handle_response(
            request(),
            {"Ok": {"kind": "get", "auth": {"type": "bearer", "token": "token"}}},
        )

        entry = self.client.cache[(REGISTRY,)]
        self.assertEqual(entry.cache, "session")
        self.assertEqual(entry.granularity, "registry")

    def test_invalid_cache_policy_is_rejected(self) -> None:
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(request(), ok("scope", cache="forever"))

    def test_cache_expires_requires_expires_at(self) -> None:
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(request(), ok("scope", cache="expires"))

    def test_invalid_granularity_is_rejected(self) -> None:
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(request(), ok("user"))

    def test_operation_independent_must_be_boolean(self) -> None:
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(request(), ok("scope", operationIndependent="yes"))


if __name__ == "__main__":
    unittest.main()
