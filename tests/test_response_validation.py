from __future__ import annotations

import unittest

from tests.protocol_model import CacheKey, CredentialClientModel, ProtocolViolation, ProviderFailure


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

    def test_an_unknown_auth_type_fails_the_request_and_a_malformed_one_is_a_violation(self) -> None:
        with self.assertRaises(ProviderFailure):
            self.client.handle_response(REQUEST, {"Ok": {"kind": "get", "auth": {"type": "digest", "token": "x"}}})
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(REQUEST, {"Ok": {"kind": "get", "auth": {"type": "Digest", "token": "x"}}})

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

    def test_ok_kind_must_match_the_request(self) -> None:
        # Ok.kind is open (a newer client may add kinds), so the pairing rejects a bogus answer
        with self.assertRaises(ProtocolViolation):
            self.client.handle_response(
                REQUEST,
                {"Ok": {"kind": "refresh", "auth": {"type": "bearer", "token": "token"}}},
            )
        self.assertEqual(self.client.handle_response({**REQUEST, "kind": "refresh"}, {"Ok": {"kind": "refresh"}}), "refresh")

    def test_package_granularity_is_keyed_per_package(self) -> None:
        for package in ("api-client", "ui"):
            self.client.handle_response(
                {**REQUEST, "scope": "@scope", "package": package},
                {"Ok": {"kind": "get", "auth": {"type": "bearer", "token": package}, "granularity": "package"}},
            )

        self.assertIn(CacheKey("package", "https://registry.example.test/", "@scope", "api-client", "read"), self.client.cache)
        self.assertIn(CacheKey("package", "https://registry.example.test/", "@scope", "ui", "read"), self.client.cache)

    # Found by fuzzing the readers of the protocol against each other
    # (tests/differential.py), each where the model said otherwise than the
    # schema, the Rust crate and the JavaScript providers.

    def test_a_response_that_is_not_an_object_is_a_violation_not_a_crash(self) -> None:
        for response in (1, "Ok", None, [], [{"Ok": {}}], True):
            with self.subTest(response=response), self.assertRaises(ProtocolViolation):
                self.client.handle_response(REQUEST, response)

    def test_an_err_member_that_is_there_has_its_type_even_when_it_is_null(self) -> None:
        for member in ("message", "causedBy"):
            with self.subTest(member=member), self.assertRaises(ProtocolViolation):
                self.client.handle_response(REQUEST, {"Err": {"kind": "other", member: None}})

    def test_an_integer_may_be_written_with_a_fraction_but_not_beyond_2_pow_53(self) -> None:
        ok = {"kind": "get", "auth": {"type": "bearer", "token": "t"}, "cache": "expires"}
        for spelled in (1700000000, 1700000000.0, 1.7e9):
            self.client.handle_response(REQUEST, {"Ok": {**ok, "expiresAt": spelled}})
        for refused in (2**53, 1.5, 1e400, float("inf"), -1):
            with self.subTest(expires_at=refused), self.assertRaises(ProtocolViolation):
                self.client.handle_response(REQUEST, {"Ok": {**ok, "expiresAt": refused}})

    def test_a_lone_surrogate_or_a_number_beyond_a_double_is_refused_anywhere(self) -> None:
        for extra in ({"x": "\ud800"}, {"\udc00": 1}, {"x": [{"y": "\ud800"}]}, {"x": float("inf")}):
            with self.subTest(extra=extra), self.assertRaises(ProtocolViolation):
                self.client.handle_response(REQUEST, {"Err": {"kind": "other"}, **extra})
        with self.assertRaises(ProviderFailure):  # a well-formed answer: the provider failed
            self.client.handle_response(REQUEST, {"Err": {"kind": "other"}, "x": "\U0001f600"})


if __name__ == "__main__":
    unittest.main()
