from __future__ import annotations

import unittest

from tests.protocol_model import CredentialClientModel, ProtocolViolation, RequestContext, validate_request


BASE_GET = {
    "v": 1,
    "kind": "get",
    "registry": "https://registry.example.test/",
    "operation": "read",
    "command": "install",
    "interactive": False,
}


class RequestValidationTests(unittest.TestCase):
    def test_client_builds_install_get_request(self) -> None:
        client = CredentialClientModel()
        client.receive_hello({"v": [1]})

        request = client.build_request(
            RequestContext(
                registry="https://registry.example.test/",
                scope="@scope",
                package="pkg",
            )
        )

        self.assertEqual(request["v"], 1)
        self.assertEqual(request["kind"], "get")
        self.assertEqual(request["scope"], "@scope")

    def test_request_must_be_object(self) -> None:
        with self.assertRaises(ProtocolViolation):
            validate_request("not-object")

    def test_request_must_use_negotiated_version(self) -> None:
        with self.assertRaises(ProtocolViolation):
            validate_request({**BASE_GET, "v": 2})

    def test_unknown_kind_is_rejected(self) -> None:
        with self.assertRaises(ProtocolViolation):
            validate_request({**BASE_GET, "kind": "store"})

    def test_registry_is_required(self) -> None:
        with self.assertRaises(ProtocolViolation):
            validate_request({**BASE_GET, "registry": None})

    def test_get_requires_operation(self) -> None:
        message = dict(BASE_GET)
        message.pop("operation")

        with self.assertRaises(ProtocolViolation):
            validate_request(message)

    def test_get_requires_interactive_boolean(self) -> None:
        with self.assertRaises(ProtocolViolation):
            validate_request({**BASE_GET, "interactive": "false"})

    def test_get_supports_search_and_view_commands(self) -> None:
        validate_request({**BASE_GET, "command": "search"})
        validate_request({**BASE_GET, "command": "view"})

    def test_unlisted_command_is_accepted_because_command_is_informational(self) -> None:
        validate_request({**BASE_GET, "command": "outdated"})

    def test_command_must_be_a_non_empty_string(self) -> None:
        for command in ("", 7):
            with self.assertRaises(ProtocolViolation):
                validate_request({**BASE_GET, "command": command})

    def test_removed_request_kinds_are_rejected(self) -> None:
        for kind in ("get-batch", "refresh"):
            with self.assertRaises(ProtocolViolation):
                validate_request({**BASE_GET, "kind": kind})

    def test_every_npm_write_action_is_an_operation(self) -> None:
        for operation in ("deprecate", "dist-tag", "unpublish", "owner", "access"):
            with self.subTest(operation=operation):
                validate_request({**BASE_GET, "operation": operation})

    def test_coarse_or_unknown_operation_is_rejected(self) -> None:
        for operation in ("write", "admin", "yank"):
            with self.assertRaises(ProtocolViolation):
                validate_request({**BASE_GET, "operation": operation})

    def test_publish_and_stage_require_version(self) -> None:
        for operation in ("publish", "stage"):
            with self.subTest(operation=operation):
                with self.assertRaises(ProtocolViolation):
                    validate_request({**BASE_GET, "operation": operation})
                validate_request({**BASE_GET, "operation": operation, "version": "1.2.3"})

    def test_retry_requires_http_status(self) -> None:
        with self.assertRaises(ProtocolViolation):
            validate_request({**BASE_GET, "retry": True})

    def test_http_status_must_be_valid_http_status(self) -> None:
        with self.assertRaises(ProtocolViolation):
            validate_request({**BASE_GET, "retry": True, "httpStatus": 99})
        with self.assertRaises(ProtocolViolation):
            validate_request({**BASE_GET, "httpStatus": 600})

    def test_retry_accepts_auth_challenges(self) -> None:
        validate_request(
            {
                **BASE_GET,
                "retry": True,
                "httpStatus": 401,
                "authChallenges": ['Bearer realm="https://registry.example.test/"'],
            }
        )

    def test_auth_challenges_must_be_strings(self) -> None:
        with self.assertRaises(ProtocolViolation):
            validate_request({**BASE_GET, "authChallenges": ["challenge", 401]})

    def test_unknown_request_fields_are_ignored(self) -> None:
        validate_request({**BASE_GET, "futureField": {"nested": True}})


if __name__ == "__main__":
    unittest.main()
