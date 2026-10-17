from __future__ import annotations

import unittest

from tests.protocol_model import (
    CredentialClientModel,
    ProviderFailure,
    provider_reply_to_unsupported,
    request_timeout_seconds,
)
from tests.generated_policy import TIMEOUT_SECONDS

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
