from __future__ import annotations

import unittest

from tests.generated_policy import EXPIRY_MARGIN_SECONDS
from tests.protocol_model import CacheKey, CredentialClientModel, ProtocolViolation


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
    token: str = "token",
    **extra: object,
) -> dict:
    payload = {
        "kind": "get",
        "auth": {"type": "bearer", "token": token},
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

        self.assertIn(CacheKey("registry", REGISTRY), self.client.cache)

    def test_scope_granularity_uses_registry_and_scope_key(self) -> None:
        self.client.handle_response(request(), ok("scope"))

        self.assertIn(CacheKey("scope", REGISTRY, "@scope"), self.client.cache)

    def test_package_granularity_uses_registry_scope_and_package_key(self) -> None:
        self.client.handle_response(request(), ok("package"))

        self.assertIn(CacheKey("package", REGISTRY, "@scope", "pkg"), self.client.cache)

    def test_operation_dependent_token_includes_operation_in_key(self) -> None:
        self.client.handle_response(request("publish"), ok("scope", operationIndependent=False))

        self.assertIn(CacheKey("scope", REGISTRY, "@scope", operation="publish"), self.client.cache)

    def test_cache_never_does_not_store_token(self) -> None:
        self.client.handle_response(request(), ok("scope", cache="never"))

        self.assertEqual(self.client.cache, {})

    def test_cache_expires_stores_expiration(self) -> None:
        self.client.handle_response(request(), ok("scope", cache="expires", expiresAt=1893456000))

        self.assertEqual(self.client.cache[CacheKey("scope", REGISTRY, "@scope")].expires_at, 1893456000)

    def test_default_cache_is_session_and_default_granularity_is_registry(self) -> None:
        self.client.handle_response(
            request(),
            {"Ok": {"kind": "get", "auth": {"type": "bearer", "token": "token"}}},
        )

        entry = self.client.cache[CacheKey("registry", REGISTRY)]
        self.assertEqual(entry.cache, "session")
        self.assertEqual(entry.granularity, "registry")

    def test_invalid_cache_policy_is_rejected(self) -> None:
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(request(), ok("scope", cache="forever"))

    def test_cache_expires_requires_expires_at(self) -> None:
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(request(), ok("scope", cache="expires"))

    def test_expires_at_must_be_an_integer_not_a_boolean(self) -> None:
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(request(), ok("scope", cache="expires", expiresAt=True))

    def test_invalid_granularity_is_rejected(self) -> None:
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(request(), ok("user"))

    def test_operation_independent_must_be_boolean(self) -> None:
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(request(), ok("scope", operationIndependent="yes"))


class CacheLookupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = CredentialClientModel()
        self.client.receive_hello({"v": [1]})

    def token_for(self, **kwargs: object) -> str | None:
        entry = self.client.lookup(REGISTRY, **kwargs)
        return None if entry is None else entry.auth["token"]

    def test_miss_on_empty_cache(self) -> None:
        self.assertIsNone(self.token_for(scope="@scope", package="pkg"))

    def test_most_specific_entry_wins(self) -> None:
        self.client.handle_response(request(), ok("registry", token="registry"))
        self.client.handle_response(request(), ok("scope", token="scope"))
        self.client.handle_response(request(package="special"), ok("package", token="package"))

        self.assertEqual(self.token_for(scope="@scope", package="special"), "package")
        self.assertEqual(self.token_for(scope="@scope", package="pkg"), "scope")
        self.assertEqual(self.token_for(scope="@other", package="pkg"), "registry")

    def test_scope_token_does_not_serve_another_scope(self) -> None:
        self.client.handle_response(request(), ok("scope", token="scope"))

        self.assertIsNone(self.token_for(scope="@other", package="pkg"))

    def test_operation_bound_token_serves_only_its_operation(self) -> None:
        self.client.handle_response(request("publish"), ok("scope", token="write", operationIndependent=False))

        self.assertEqual(self.token_for(scope="@scope", package="pkg", operation="publish"), "write")
        self.assertIsNone(self.token_for(scope="@scope", package="pkg", operation="read"))

    def test_operation_bound_token_wins_over_independent_one_at_the_same_level(self) -> None:
        self.client.handle_response(request(), ok("scope", token="any"))
        self.client.handle_response(request("publish"), ok("scope", token="write", operationIndependent=False))

        self.assertEqual(self.token_for(scope="@scope", package="pkg", operation="publish"), "write")
        self.assertEqual(self.token_for(scope="@scope", package="pkg", operation="read"), "any")

    def test_package_named_like_an_operation_does_not_collide(self) -> None:
        # `read` is a real unscoped npm package. A package-level token for it must
        # not be mistaken for a scope-level token bound to operation `read`.
        self.client.handle_response(request(scope=None, package="read"), ok("package", token="pkg-read"))

        self.assertEqual(self.token_for(scope=None, package="read"), "pkg-read")
        self.assertIsNone(self.token_for(scope=None, package="other"))

    def test_expiring_token_stops_matching_inside_the_margin(self) -> None:
        expires_at = 1_000_000
        self.client.handle_response(request(), ok("scope", cache="expires", token="short", expiresAt=expires_at))

        self.assertEqual(
            self.token_for(scope="@scope", package="pkg", now=expires_at - EXPIRY_MARGIN_SECONDS - 1),
            "short",
        )
        self.assertIsNone(self.token_for(scope="@scope", package="pkg", now=expires_at - EXPIRY_MARGIN_SECONDS))
        self.assertEqual(self.client.cache, {})

    def test_expired_specific_token_falls_back_to_a_live_broader_one(self) -> None:
        self.client.handle_response(request(), ok("registry", token="session"))
        self.client.handle_response(request(), ok("scope", cache="expires", token="short", expiresAt=100))

        self.assertEqual(self.token_for(scope="@scope", package="pkg", now=1_000), "session")

    def test_batch_results_cannot_override_batch_cache_fields(self) -> None:
        batch = {
            "v": 1,
            "kind": "get-batch",
            "registry": REGISTRY,
            "operation": "read",
            "interactive": False,
            "packages": [{"scope": "@scope", "package": "pkg"}],
        }
        self.client.handle_response(
            batch,
            {
                "Ok": {
                    "kind": "get-batch",
                    "cache": "session",
                    "results": [
                        {
                            "auth": {"type": "bearer", "token": "token"},
                            "granularity": "scope",
                            "cache": "never",
                        }
                    ],
                }
            },
        )

        self.assertEqual(self.client.cache[CacheKey("scope", REGISTRY, "@scope")].cache, "session")


if __name__ == "__main__":
    unittest.main()
