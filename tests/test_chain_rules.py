from __future__ import annotations

import unittest

from tests.protocol_model import (
    CredentialClientModel,
    RequestContext,
    STORED_CREDENTIAL_ENTRY,
    classify_401,
    resolve_chain,
    resolve_login_chain,
)

DECLINE = "try-next-provider"
NOT_FOUND = "try-next-provider-not-found"
TOKEN = STORED_CREDENTIAL_ENTRY
REGISTRY = "https://registry.example.test/"


class LoginRoutingTests(unittest.TestCase):
    def test_login_ends_the_way_get_ends(self) -> None:
        cases = [
            # answers, per_registry, result, entry, warns
            (["ok"], False, "ok", 0, False),
            ([DECLINE, "ok"], True, "ok", 1, False),
            ([NOT_FOUND, "ok"], False, "ok", 1, False),
            ([DECLINE, DECLINE], False, "npm-login", None, True),
            ([NOT_FOUND], False, "fail", None, False),
            ([NOT_FOUND, TOKEN], False, "npm-login", 1, False),
            ([NOT_FOUND, TOKEN], True, "npm-login", 1, False),
            ([DECLINE, DECLINE], True, "fail", None, False),
            ([DECLINE, "fail", "ok"], False, "fail", 1, False),
            ([TOKEN, "ok"], True, "npm-login", 0, False),
        ]
        for answers, per_registry, result, entry, warns in cases:
            with self.subTest(answers=answers, per_registry=per_registry):
                outcome = resolve_login_chain(answers, per_registry=per_registry)
                self.assertEqual((outcome.result, outcome.entry, bool(outcome.warnings)), (result, entry, warns))

    def test_login_never_stores_a_token_get_would_not_send(self) -> None:
        for answers in ([NOT_FOUND], [DECLINE, NOT_FOUND]):
            login = resolve_login_chain(answers, per_registry=False)
            get = resolve_chain(answers, per_registry=False, stored_credential=True)
            self.assertEqual((login.result, get.result), ("fail", "fail"))


class OidcTests(unittest.TestCase):
    def test_an_exchanged_token_asks_no_provider_and_warns_about_nothing(self) -> None:
        for per_registry in (False, True):
            with self.subTest(per_registry=per_registry):
                outcome = resolve_chain(["fail"], per_registry=per_registry, stored_credential=True, oidc_token=True)
                self.assertEqual(outcome, ("oidc", None, ()))

    def test_without_the_exchanged_token_the_chain_decides(self) -> None:
        self.assertEqual(resolve_chain(["fail"], per_registry=True, stored_credential=False).result, "fail")


class OtpClassificationTests(unittest.TestCase):
    def test_cases(self) -> None:
        cases = [
            ('Bearer realm="x", ipaddress', "x", "eauthip"),
            ("otp", "", "otp"),
            ("OTP", "", "otp"),
            ("ipaddress otp", "", "eauthip"),
            (None, "This operation requires a one-time password", "otp"),
            (None, "Unauthorized", "reject"),
            ('Bearer realm="x"', "You must provide a one-time pass to continue", "otp"),
            ('Bearer realm="x"', {"error": "a one-time pass is required"}, "reject"),
            ('Bearer realm="x"', "Unauthorized", "reject"),
            (None, {"error": "one-time pass"}, "reject"),
        ]
        for header, body, expected in cases:
            with self.subTest(header=header, body=body):
                self.assertEqual(classify_401(header, body), expected)


class StageReadCacheTests(unittest.TestCase):
    def test_a_stage_read_answer_never_serves_the_write(self) -> None:
        client = CredentialClientModel()
        client.receive_hello({"v": [1]})
        request = client.build_request(RequestContext(registry=REGISTRY, operation="stage-read", command="stage"))
        client.handle_response(request, {"Ok": {
            "kind": "get", "auth": {"type": "bearer", "token": "lookup"}, "operationIndependent": True,
        }})
        self.assertEqual(client.lookup(REGISTRY, operation="stage-read").auth["token"], "lookup")
        self.assertIsNone(client.lookup(REGISTRY, "@s", "p", operation="publish"))
        self.assertIsNone(client.lookup(REGISTRY, "@s", "p", operation="stage-reject"))

    def test_other_operations_keep_operation_independence(self) -> None:
        client = CredentialClientModel()
        client.receive_hello({"v": [1]})
        request = client.build_request(RequestContext(registry=REGISTRY, operation="read"))
        client.handle_response(request, {"Ok": {"kind": "get", "auth": {"type": "bearer", "token": "any"}}})
        self.assertEqual(client.lookup(REGISTRY, operation="dist-tag").auth["token"], "any")


if __name__ == "__main__":
    unittest.main()
