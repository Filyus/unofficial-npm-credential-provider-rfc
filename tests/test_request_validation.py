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

    def test_unknown_command_is_rejected(self) -> None:
        with self.assertRaises(ProtocolViolation):
            validate_request({**BASE_GET, "command": "unknown"})

    def test_get_batch_requires_packages(self) -> None:
        with self.assertRaises(ProtocolViolation):
            validate_request({**BASE_GET, "kind": "get-batch"})

    def test_get_batch_accepts_package_list(self) -> None:
        validate_request(
            {
                **BASE_GET,
                "kind": "get-batch",
                "packages": [{"scope": "@scope", "package": "pkg"}],
            }
        )

    def test_refresh_requires_refresh_state(self) -> None:
        with self.assertRaises(ProtocolViolation):
            validate_request(
                {
                    "v": 1,
                    "kind": "refresh",
                    "registry": "https://registry.example.test/",
                }
            )

    def test_publish_operation_requires_version(self) -> None:
        with self.assertRaises(ProtocolViolation):
            validate_request({**BASE_GET, "operation": "publish"})

    def test_publish_operation_accepts_version(self) -> None:
        validate_request({**BASE_GET, "operation": "publish", "version": "1.2.3"})

    def test_unknown_request_fields_are_ignored(self) -> None:
        validate_request({**BASE_GET, "futureField": {"nested": True}})


if __name__ == "__main__":
    unittest.main()
