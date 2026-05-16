from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import unittest

from tests.protocol_model import CredentialClientModel, ProtocolViolation, ProviderFailure, RequestContext


TESTS_DIR = Path(__file__).resolve().parent


class MockProviderSubprocessTests(unittest.TestCase):
    def test_mock_provider_get_success(self) -> None:
        client, request, response = self.exchange("get-success")

        self.assertEqual(client.handle_response(request, response), "ok")
        self.assertIn(("https://registry.example.test/", "@scope"), client.cache)

    def test_mock_provider_refresh_success(self) -> None:
        client, request, response = self.exchange(
            "refresh-success",
            request={
                "v": 1,
                "action": "refresh",
                "registry": "https://registry.example.test/",
                "refreshToken": "opaque-refresh-token",
            },
        )

        self.assertEqual(client.handle_response(request, response), "ok")

    def test_mock_provider_batch_success(self) -> None:
        client, request, response = self.exchange(
            "batch-success",
            request={
                "v": 1,
                "action": "get-batch",
                "registry": "https://registry.example.test/",
                "operation": "install",
                "interactive": False,
                "packages": [
                    {"scope": "@scope", "package": "api-client"},
                    {"scope": "@scope", "package": "ui"},
                ],
            },
        )

        self.assertEqual(client.handle_response(request, response), "ok")
        self.assertIn(("https://registry.example.test/", "@scope", "api-client"), client.cache)
        self.assertIn(("https://registry.example.test/", "@scope", "ui"), client.cache)

    def test_mock_provider_login_logout_erase_success(self) -> None:
        for scenario, action in (
            ("login-success", "login"),
            ("logout-success", "logout"),
            ("erase-success", "erase"),
        ):
            with self.subTest(action=action):
                client, request, response = self.exchange(
                    scenario,
                    request={"v": 1, "action": action, "registry": "https://registry.example.test/"},
                )
                self.assertEqual(client.handle_response(request, response), action)

    def test_mock_provider_not_found_fails_closed(self) -> None:
        client, request, response = self.exchange("not-found")

        with self.assertRaises(ProviderFailure):
            client.handle_response(request, response)

    def test_mock_provider_version_mismatch_fails_closed(self) -> None:
        proc = self.start_provider("version-mismatch")
        try:
            hello = json.loads(proc.stdout.readline())
            with self.assertRaises(ProtocolViolation):
                CredentialClientModel().receive_hello(hello)
        finally:
            self.stop_provider(proc)

    def test_mock_provider_invalid_json_response_is_rejected(self) -> None:
        proc = self.start_provider("invalid-json")
        try:
            client = CredentialClientModel()
            client.receive_hello(json.loads(proc.stdout.readline()))
            request = self.default_request(client)
            proc.stdin.write(json.dumps(request) + "\n")
            proc.stdin.flush()
            with self.assertRaises(json.JSONDecodeError):
                json.loads(proc.stdout.readline())
        finally:
            self.stop_provider(proc)

    def test_mock_provider_no_hello_is_detected(self) -> None:
        proc = self.start_provider("no-hello")
        try:
            self.assertEqual(proc.stdout.readline(), "")
        finally:
            self.stop_provider(proc)

    def test_mock_provider_both_ok_and_err_is_rejected(self) -> None:
        client, request, response = self.exchange("both-ok-err")

        with self.assertRaises(ProtocolViolation):
            client.handle_response(request, response)

    def test_mock_provider_malformed_auth_is_rejected(self) -> None:
        client, request, response = self.exchange("malformed-auth")

        with self.assertRaises(ProtocolViolation):
            client.handle_response(request, response)

    def test_mock_provider_missing_expiration_is_rejected(self) -> None:
        client, request, response = self.exchange("expires-missing-expiration")

        with self.assertRaises(ProtocolViolation):
            client.handle_response(request, response)

    def test_mock_provider_batch_count_mismatch_is_rejected(self) -> None:
        client, request, response = self.exchange(
            "batch-count-mismatch",
            request={
                "v": 1,
                "action": "get-batch",
                "registry": "https://registry.example.test/",
                "operation": "install",
                "interactive": False,
                "packages": [
                    {"scope": "@scope", "package": "api-client"},
                    {"scope": "@scope", "package": "ui"},
                ],
            },
        )

        with self.assertRaises(ProtocolViolation):
            client.handle_response(request, response)

    def test_provider_timeout_can_be_enforced_by_client(self) -> None:
        proc = self.start_provider("slow-hello")
        try:
            with self.assertRaises(subprocess.TimeoutExpired):
                proc.wait(timeout=0.1)
        finally:
            proc.kill()
            self.stop_provider(proc, expect_returncode=None)

    def exchange(self, scenario: str, request: dict | None = None) -> tuple[CredentialClientModel, dict, dict]:
        proc = self.start_provider(scenario)
        try:
            client = CredentialClientModel()
            client.receive_hello(json.loads(proc.stdout.readline()))
            request = request or self.default_request(client)
            proc.stdin.write(json.dumps(request) + "\n")
            proc.stdin.flush()
            response = json.loads(proc.stdout.readline())
            return client, request, response
        finally:
            self.stop_provider(proc)

    def default_request(self, client: CredentialClientModel) -> dict:
        return client.build_request(
            RequestContext(
                registry="https://registry.example.test/",
                scope="@scope",
                package="pkg",
            )
        )

    def start_provider(self, scenario: str) -> subprocess.Popen:
        return subprocess.Popen(
            [sys.executable, str(TESTS_DIR / "mock_provider.py"), "--scenario", scenario],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def stop_provider(self, proc: subprocess.Popen, expect_returncode: int | None = 0) -> None:
        if proc.stdin and not proc.stdin.closed:
            proc.stdin.close()
        if proc.poll() is None:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
                raise
        stderr = proc.stderr.read() if proc.stderr else ""
        if proc.stdout:
            proc.stdout.close()
        if proc.stderr:
            proc.stderr.close()
        if expect_returncode is not None:
            self.assertEqual(proc.returncode, expect_returncode, stderr)


if __name__ == "__main__":
    unittest.main()
