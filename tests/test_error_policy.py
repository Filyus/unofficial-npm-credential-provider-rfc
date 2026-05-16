from __future__ import annotations

import unittest

from tests.protocol_model import CredentialClientModel, ProviderConfig, ProviderFailure, ProtocolViolation


REQUEST = {
    "v": 1,
    "action": "get",
    "registry": "https://registry.example.test/",
    "operation": "install",
    "interactive": False,
}


class ErrorPolicyTests(unittest.TestCase):
    def client(self, *, configured: bool = True, legacy_fallback: bool = False) -> CredentialClientModel:
        client = CredentialClientModel(ProviderConfig(configured=configured, legacy_fallback=legacy_fallback))
        client.receive_hello({"v": [1]})
        return client

    def test_url_not_supported_tries_next_provider(self) -> None:
        outcome = self.client().handle_response(REQUEST, {"Err": {"kind": "url-not-supported"}})

        self.assertEqual(outcome, "try-next-provider")

    def test_not_found_fails_closed_by_default(self) -> None:
        with self.assertRaises(ProviderFailure):
            self.client().handle_response(REQUEST, {"Err": {"kind": "not-found"}})

    def test_not_found_uses_legacy_when_provider_not_configured(self) -> None:
        outcome = self.client(configured=False).handle_response(REQUEST, {"Err": {"kind": "not-found"}})

        self.assertEqual(outcome, "legacy-auth")

    def test_not_found_uses_legacy_when_explicitly_enabled(self) -> None:
        outcome = self.client(legacy_fallback=True).handle_response(REQUEST, {"Err": {"kind": "not-found"}})

        self.assertEqual(outcome, "legacy-auth")

    def test_refresh_operation_not_supported_retries_get(self) -> None:
        refresh_request = {
            "v": 1,
            "action": "refresh",
            "registry": "https://registry.example.test/",
            "refreshToken": "opaque-refresh-token",
        }

        outcome = self.client().handle_response(
            refresh_request,
            {"Err": {"kind": "operation-not-supported"}},
        )

        self.assertEqual(outcome, "retry-get")

    def test_get_operation_not_supported_fails(self) -> None:
        with self.assertRaises(ProviderFailure):
            self.client().handle_response(REQUEST, {"Err": {"kind": "operation-not-supported"}})

    def test_other_error_fails(self) -> None:
        with self.assertRaises(ProviderFailure):
            self.client().handle_response(REQUEST, {"Err": {"kind": "other", "message": "boom"}})

    def test_unsupported_error_kind_is_protocol_violation(self) -> None:
        with self.assertRaises(ProtocolViolation):
            self.client().handle_response(REQUEST, {"Err": {"kind": "permission-denied"}})

    def test_err_must_be_object(self) -> None:
        with self.assertRaises(ProtocolViolation):
            self.client().handle_response(REQUEST, {"Err": "not-found"})


if __name__ == "__main__":
    unittest.main()
