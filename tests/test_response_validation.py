from __future__ import annotations

import unittest

from tests.protocol_model import CredentialClientModel, ProtocolViolation


REQUEST = {
    "v": 1,
    "kind": "get",
    "registry": "https://registry.example.test/",
    "operation": "read",
    "command": "install",
    "interactive": False,
}


class ResponseValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = CredentialClientModel()
        self.client.receive_hello({"v": [1]})

    def test_response_must_contain_exactly_one_ok_or_err(self) -> None:
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(REQUEST, {})
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(REQUEST, {"Ok": {"kind": "get"}, "Err": {"kind": "other"}})

    def test_ok_must_be_object(self) -> None:
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(REQUEST, {"Ok": "ok"})

    def test_ok_kind_is_required(self) -> None:
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(REQUEST, {"Ok": {"auth": {"type": "bearer", "token": "token"}}})

    def test_bearer_auth_requires_token(self) -> None:
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(REQUEST, {"Ok": {"kind": "get", "auth": {"type": "bearer"}}})

    def test_basic_auth_requires_username_and_password(self) -> None:
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(REQUEST, {"Ok": {"kind": "get", "auth": {"type": "basic", "username": "u"}}})

    def test_basic_auth_success(self) -> None:
        outcome = self.client.handle_response(
            REQUEST,
            {
                "Ok": {
                    "kind": "get",
                    "auth": {
                        "type": "basic",
                        "username": "deploy-token",
                        "password": "secret",
                    },
                    "granularity": "registry",
                }
            },
        )

        self.assertEqual(outcome, "ok")

    def test_unknown_auth_type_is_rejected(self) -> None:
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(REQUEST, {"Ok": {"kind": "get", "auth": {"type": "digest", "token": "x"}}})

    def test_login_logout_and_erase_ok_do_not_require_auth(self) -> None:
        for kind in ("login", "logout", "erase"):
            with self.subTest(kind=kind):
                request = {"v": 1, "kind": kind, "registry": "https://registry.example.test/"}
                self.assertEqual(self.client.handle_response(request, {"Ok": {"kind": kind}}), kind)

    def test_unknown_ok_fields_are_ignored(self) -> None:
        outcome = self.client.handle_response(
            REQUEST,
            {
                "Ok": {
                    "kind": "get",
                    "auth": {"type": "bearer", "token": "token"},
                    "futureField": {"nested": True},
                }
            },
        )

        self.assertEqual(outcome, "ok")

    def test_get_batch_requires_matching_result_count(self) -> None:
        request = {
            **REQUEST,
            "kind": "get-batch",
            "packages": [
                {"scope": "@scope", "package": "api-client"},
                {"scope": "@scope", "package": "ui"},
            ],
        }

        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(
                request,
                {
                    "Ok": {
                        "kind": "get-batch",
                        "cache": "session",
                        "results": [{"auth": {"type": "bearer", "token": "only-one"}}],
                    }
                },
            )

    def test_get_batch_caches_each_result(self) -> None:
        request = {
            **REQUEST,
            "kind": "get-batch",
            "packages": [
                {"scope": "@scope", "package": "api-client"},
                {"scope": "@scope", "package": "ui"},
            ],
        }

        self.client.handle_response(
            request,
            {
                "Ok": {
                    "kind": "get-batch",
                    "cache": "session",
                    "results": [
                        {
                            "auth": {"type": "bearer", "token": "api"},
                            "granularity": "package",
                        },
                        {
                            "auth": {"type": "bearer", "token": "ui"},
                            "granularity": "package",
                        },
                    ],
                }
            },
        )

        self.assertIn(("https://registry.example.test/", "@scope", "api-client"), self.client.cache)
        self.assertIn(("https://registry.example.test/", "@scope", "ui"), self.client.cache)


if __name__ == "__main__":
    unittest.main()
