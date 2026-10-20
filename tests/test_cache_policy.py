from __future__ import annotations

import unittest

from tests.generated_policy import EXPIRY_MARGIN_SECONDS
from tests.protocol_model import CacheKey, CredentialClientModel, ProtocolViolation, RequestContext


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

        # a non-read answer is also bound to the package the request names
        self.assertIn(CacheKey("package", REGISTRY, "@scope", "pkg", operation="publish"), self.client.cache)

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

    def test_a_cache_policy_that_is_not_a_name_is_rejected(self) -> None:
        # an unknown name is read as `never` (test_forward_compat_and_timeouts)
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(request(), ok("scope", cache="Forever"))

    def test_cache_expires_requires_expires_at(self) -> None:
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(request(), ok("scope", cache="expires"))

    def test_expires_at_must_be_an_integer_not_a_boolean(self) -> None:
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(request(), ok("scope", cache="expires", expiresAt=True))

    def test_a_granularity_that_is_not_a_name_is_rejected(self) -> None:
        # an unknown name is read as `package` (test_forward_compat_and_timeouts)
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(request(), ok("User"))

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

    def test_stage_token_does_not_serve_publish(self) -> None:
        # npmjs.com stage-only tokens can `npm stage publish` but not `npm publish`,
        # so a provider binds the token it returns for `stage` to that operation.
        self.client.handle_response(
            {**request("publish"), "operation": "stage", "command": "stage"},
            ok("scope", token="stage-only", operationIndependent=False),
        )

        self.assertEqual(self.token_for(scope="@scope", package="pkg", operation="stage"), "stage-only")
        self.assertIsNone(self.token_for(scope="@scope", package="pkg", operation="publish"))


class RejectedCredentialTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = CredentialClientModel()
        self.client.receive_hello({"v": [1], "capabilities": ["erase"]})

    def context(self, **changes: object) -> RequestContext:
        return RequestContext(registry=REGISTRY, scope="@scope", package="pkg", **changes)

    def test_every_entry_that_served_the_credential_is_evicted_at_every_level(self) -> None:
        self.client.handle_response(request(), ok("package", token="rejected"))
        self.client.handle_response(request(package="other"), ok("scope", token="rejected"))
        self.client.handle_response(request(scope=None, package=None), ok("registry", token="rejected"))
        self.client.handle_response(
            request("publish"), ok("scope", token="rejected", operationIndependent=False)
        )
        self.client.handle_response(request(scope="@else"), ok("scope", token="unrelated"))

        self.client.reject_credential(self.context())

        self.assertEqual([entry.auth["token"] for entry in self.client.cache.values()], ["unrelated"])

    def test_erase_request_carries_the_context_of_the_get(self) -> None:
        self.client.handle_response(request(), ok("scope", token="rejected"))

        erase = self.client.reject_credential(
            self.context(operation="read"), auth_challenges=['Bearer realm="r"']
        )

        self.assertEqual(
            erase,
            {
                "v": 1,
                "kind": "erase",
                "registry": REGISTRY,
                "scope": "@scope",
                "package": "pkg",
                "operation": "read",
                "granularity": "scope",
                "authChallenges": ['Bearer realm="r"'],
            },
        )

    def test_unscoped_registry_level_erase_omits_scope_and_package(self) -> None:
        self.client.handle_response(request(scope=None, package=None), ok("registry", token="rejected"))

        erase = self.client.reject_credential(RequestContext(registry=REGISTRY))

        self.assertNotIn("scope", erase)
        self.assertNotIn("package", erase)
        self.assertEqual(erase["granularity"], "registry")

    def test_retry_returning_a_coarser_token_is_what_later_lookups_find(self) -> None:
        self.client.handle_response(request(), ok("scope", token="scope-rejected"))
        self.client.reject_credential(self.context())
        self.client.handle_response(request(), ok("registry", token="registry-new"))

        self.assertEqual(self.client.lookup(REGISTRY, "@scope", "pkg").auth["token"], "registry-new")
        self.assertEqual(self.client.lookup(REGISTRY, "@scope").auth["token"], "registry-new")

    def test_without_the_erase_capability_the_entries_go_but_no_request_is_built(self) -> None:
        client = CredentialClientModel()
        client.receive_hello({"v": [1]})
        client.handle_response(request(), ok("scope", token="rejected"))

        self.assertIsNone(client.reject_credential(self.context()))
        self.assertEqual(client.cache, {})

    def test_a_credential_that_was_never_cached_still_yields_an_erase(self) -> None:
        self.client.handle_response(request(), ok("scope", cache="never", token="rejected"))

        erase = self.client.reject_credential(self.context())

        self.assertEqual(erase["kind"], "erase")
        self.assertEqual(erase["granularity"], "scope", "kept with the answer although it was never cached")


if __name__ == "__main__":
    unittest.main()
