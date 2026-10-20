from __future__ import annotations

import json
from pathlib import Path
import unittest

from tests.protocol_model import (
    CredentialClientModel,
    ProtocolViolation,
    ProviderFailure,
    provider_reply_to_unsupported,
    request_timeout_seconds,
)
from tests.generated_policy import ERASE_ERROR_OUTCOMES, TIMEOUT_SECONDS

POLICY = json.loads((Path(__file__).resolve().parents[1] / "spec" / "policy-v1.json").read_text(encoding="utf-8"))

REGISTRY = "https://registry.example.test/"
GET = {"v": 1, "kind": "get", "registry": REGISTRY, "operation": "read", "interactive": False}


class TimeoutBudgetTests(unittest.TestCase):
    def test_non_interactive_get_keeps_the_short_budget(self) -> None:
        self.assertEqual(request_timeout_seconds(GET), TIMEOUT_SECONDS["get"])
        self.assertEqual(request_timeout_seconds(GET), 30)

    def test_interactive_get_gets_the_login_budget(self) -> None:
        budget = request_timeout_seconds({**GET, "interactive": True})

        self.assertEqual(budget, TIMEOUT_SECONDS["getInteractive"])
        self.assertEqual(budget, TIMEOUT_SECONDS["login"])
        self.assertEqual(budget, 300)

    def test_interactive_flag_only_changes_a_get(self) -> None:
        erase = {"v": 1, "kind": "erase", "registry": REGISTRY, "interactive": True}

        self.assertEqual(request_timeout_seconds(erase), TIMEOUT_SECONDS["erase"])

    def test_each_kind_has_its_own_budget(self) -> None:
        for kind in ("login", "logout", "erase"):
            self.assertEqual(request_timeout_seconds({"v": 1, "kind": kind, "registry": REGISTRY}), TIMEOUT_SECONDS[kind])

    def test_a_kind_without_a_budget_is_bounded_like_a_get(self) -> None:
        self.assertEqual(request_timeout_seconds({"v": 1, "kind": "store", "registry": REGISTRY}), TIMEOUT_SECONDS["get"])


class UnknownResponseValueTests(unittest.TestCase):
    """A provider newer than npm: an unknown value of a known response field is
    read as the most cautious known one, and an unknown `auth.type` fails the
    request as an `other` answer (`forwardCompatibility` in the policy)."""

    BEARER = {"type": "bearer", "token": "t"}

    def client(self) -> CredentialClientModel:
        client = CredentialClientModel()
        client.receive_hello({"v": [1]})
        return client

    def get(self, **ok) -> CredentialClientModel:
        client = self.client()
        request = {**GET, "scope": "@s", "package": "p"}
        client.handle_response(request, {"Ok": {"kind": "get", "auth": self.BEARER, **ok}})
        return client

    def test_the_policy_names_the_mapping(self) -> None:
        fc = POLICY["forwardCompatibility"]
        self.assertEqual(
            (fc["unknownErrorKind"], fc["unknownCache"], fc["unknownGranularity"], fc["unknownAuthType"]),
            ("other", "never", "package", "fail-as-other-naming-the-provider"),
        )

    def test_an_unknown_error_kind_is_read_as_other(self) -> None:
        for kind in ("permission-denied", "rate-limited", "x1"):
            with self.subTest(kind=kind), self.assertRaises(ProviderFailure) as raised:
                self.client().handle_response(GET, {"Err": {"kind": kind, "message": "m"}})
            self.assertEqual(str(raised.exception), "other", "it stops the chain like `other`, not like not-found")

    def test_an_unknown_error_kind_answering_erase_is_other_for_erase(self) -> None:
        erase = {"v": 1, "kind": "erase", "registry": REGISTRY, "operation": "read", "granularity": "registry"}
        outcome = self.client().handle_response(erase, {"Err": {"kind": "permission-denied"}})
        self.assertEqual(outcome, ERASE_ERROR_OUTCOMES["other"])
        self.assertEqual(outcome, "warn-and-retry")

    def test_an_unknown_cache_is_read_as_never(self) -> None:
        self.assertEqual(self.get(cache="lease").cache, {}, "nothing is stored")
        self.assertEqual(len(self.get(cache="session").cache), 1, "a known policy is")

    def test_an_unknown_cache_ignores_expires_at_rules(self) -> None:
        # read as `never`, so it needs no expiresAt that `expires` would
        self.assertEqual(self.get(cache="lease").cache, {})

    def test_an_unknown_granularity_is_read_as_package(self) -> None:
        client = self.get(granularity="host", operationIndependent=True)
        self.assertIsNotNone(client.lookup(REGISTRY, "@s", "p", "read"))
        self.assertIsNone(client.lookup(REGISTRY, "@s", "other", "read"), "it serves its package only")
        self.assertIsNone(client.lookup(REGISTRY, "@t", "p", "read"))

    def test_an_unknown_auth_type_fails_the_request_as_other(self) -> None:
        client = self.client()
        with self.assertRaises(ProviderFailure) as raised:
            client.handle_response(GET, {"Ok": {"kind": "get", "auth": {"type": "digest", "realm": "r"}}})
        self.assertTrue(str(raised.exception).startswith("other"))
        self.assertEqual(client.cache, {})
        self.assertEqual(client.issued, {})

    def test_a_malformed_message_is_still_a_violation_before_an_unknown_auth_type_fails_it(self) -> None:
        digest = {"type": "digest"}
        for ok in ({"cache": "Lease"}, {"granularity": "Host"}, {"cache": "expires"}, {"expiresAt": -1},
                   {"operationIndependent": "no"}):
            with self.subTest(ok=ok), self.assertRaises(ProtocolViolation):
                self.client().handle_response(GET, {"Ok": {"kind": "get", "auth": digest, **ok}})

    def test_a_value_that_is_not_a_name_is_not_unknown_but_malformed(self) -> None:
        for response in (
            {"Err": {"kind": "Permission-Denied"}},
            {"Err": {"kind": ""}},
            {"Err": {"kind": 1}},
            {"Ok": {"kind": "get", "auth": self.BEARER, "cache": "Lease"}},
            {"Ok": {"kind": "get", "auth": self.BEARER, "granularity": ""}},
            {"Ok": {"kind": "get", "auth": {"type": "Digest"}}},
            {"Ok": {"kind": "get", "auth": {"type": None}}},
        ):
            with self.subTest(response=response), self.assertRaises(ProtocolViolation):
                self.client().handle_response(GET, response)


class ForwardCompatibilityTests(unittest.TestCase):
    def test_provider_answers_an_unknown_kind_with_operation_not_supported(self) -> None:
        reply = provider_reply_to_unsupported({"v": 1, "kind": "store", "registry": REGISTRY})

        self.assertEqual(reply["Err"]["kind"], "operation-not-supported")

    def test_provider_answers_an_unknown_operation_instead_of_serving_it_as_read(self) -> None:
        reply = provider_reply_to_unsupported({**GET, "operation": "yank"})

        self.assertEqual(reply["Err"]["kind"], "operation-not-supported")

    def test_known_requests_are_left_to_the_provider(self) -> None:
        self.assertIsNone(provider_reply_to_unsupported(GET))
        self.assertIsNone(provider_reply_to_unsupported(
            {"v": 1, "kind": "erase", "registry": REGISTRY, "operation": "read", "granularity": "registry"}))

    def test_provider_keeps_serving_after_an_unsupported_request(self) -> None:
        refused = provider_reply_to_unsupported({"v": 1, "kind": "store", "registry": REGISTRY})
        served = provider_reply_to_unsupported(GET)

        self.assertIsNotNone(refused)
        self.assertIsNone(served)

    def test_client_fails_the_request_on_operation_not_supported(self) -> None:
        client = CredentialClientModel()
        client.receive_hello({"v": [1]})
        reply = provider_reply_to_unsupported({**GET, "operation": "yank"})

        with self.assertRaises(ProviderFailure):
            client.handle_response({**GET, "operation": "yank"}, reply)


if __name__ == "__main__":
    unittest.main()
