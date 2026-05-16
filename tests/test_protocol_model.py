from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import unittest

from tests.protocol_model import (
    CredentialClientModel,
    ProviderConfig,
    ProviderFailure,
    ProviderLocation,
    RequestContext,
    ResolutionFailure,
    ProtocolViolation,
    resolve_provider,
    validate_transcript,
)


TESTS_DIR = Path(__file__).resolve().parent
TRANSCRIPTS = TESTS_DIR / "transcripts"


class TranscriptTests(unittest.TestCase):
    def test_get_success_transcript_caches_scope_token(self) -> None:
        client = validate_transcript(str(TRANSCRIPTS / "get-success.jsonl"))

        self.assertEqual(client.state.value, "closed")
        self.assertIn(("https://registry.example.test/", "@scope"), client.cache)
        self.assertEqual(
            client.cache[("https://registry.example.test/", "@scope")].auth["token"],
            "token-1",
        )

    def test_provider_chain_transcript_allows_try_next(self) -> None:
        client = validate_transcript(str(TRANSCRIPTS / "provider-chain.jsonl"))

        self.assertEqual(client.state.value, "closed")
        self.assertEqual(client.cache, {})

    def test_refresh_transcript_validates_refresh_token(self) -> None:
        client = validate_transcript(str(TRANSCRIPTS / "refresh-success.jsonl"))

        self.assertIn(("https://registry.example.test/", None), client.cache)

    def test_version_mismatch_fails_closed(self) -> None:
        with self.assertRaises(ProtocolViolation):
            validate_transcript(str(TRANSCRIPTS / "version-mismatch.jsonl"))

    def test_not_found_fails_without_explicit_legacy_fallback(self) -> None:
        with self.assertRaises(ProviderFailure):
            validate_transcript(str(TRANSCRIPTS / "not-found.jsonl"))

    def test_not_found_can_use_explicit_legacy_fallback(self) -> None:
        client = validate_transcript(
            str(TRANSCRIPTS / "not-found.jsonl"),
            config=ProviderConfig(configured=True, legacy_fallback=True),
        )

        self.assertEqual(client.state.value, "ready")


class ProviderResolutionTests(unittest.TestCase):
    def test_project_config_cannot_enable_provider(self) -> None:
        with self.assertRaises(ResolutionFailure):
            resolve_provider(
                "npm-credential-provider-gitlab",
                "project",
                [
                    ProviderLocation(
                        "npm-credential-provider-gitlab",
                        "global-bin",
                        "/usr/local/bin/npm-credential-provider-gitlab",
                    )
                ],
            )

    def test_project_node_modules_cannot_shadow_global_provider(self) -> None:
        resolved = resolve_provider(
            "npm-credential-provider-gitlab",
            "user",
            [
                ProviderLocation(
                    "npm-credential-provider-gitlab",
                    "project-node_modules",
                    "./node_modules/.bin/npm-credential-provider-gitlab",
                ),
                ProviderLocation(
                    "npm-credential-provider-gitlab",
                    "global-bin",
                    "/usr/local/bin/npm-credential-provider-gitlab",
                ),
            ],
        )

        self.assertEqual(resolved.kind, "global-bin")

    def test_ambiguous_trusted_provider_fails_closed(self) -> None:
        with self.assertRaises(ResolutionFailure):
            resolve_provider(
                "npm-credential-provider-gitlab",
                "user",
                [
                    ProviderLocation(
                        "npm-credential-provider-gitlab",
                        "global-bin",
                        "/usr/local/bin/npm-credential-provider-gitlab",
                    ),
                    ProviderLocation(
                        "npm-credential-provider-gitlab",
                        "enterprise",
                        "/opt/company/bin/npm-credential-provider-gitlab",
                    ),
                ],
            )


class MockProviderSubprocessTests(unittest.TestCase):
    def test_mock_provider_get_success(self) -> None:
        client = CredentialClientModel()
        proc = self._start_provider("get-success")
        try:
            hello = json.loads(proc.stdout.readline())
            client.receive_hello(hello)
            request = client.build_request(
                RequestContext(
                    registry="https://registry.example.test/",
                    scope="@scope",
                    package="pkg",
                )
            )
            proc.stdin.write(json.dumps(request) + "\n")
            proc.stdin.flush()
            response = json.loads(proc.stdout.readline())

            self.assertEqual(client.handle_response(request, response), "ok")
            self.assertIn(("https://registry.example.test/", "@scope"), client.cache)
        finally:
            self._stop_provider(proc)

    def test_mock_provider_version_mismatch_fails_closed(self) -> None:
        client = CredentialClientModel()
        proc = self._start_provider("version-mismatch")
        try:
            hello = json.loads(proc.stdout.readline())
            with self.assertRaises(ProtocolViolation):
                client.receive_hello(hello)
        finally:
            self._stop_provider(proc)

    def _start_provider(self, scenario: str) -> subprocess.Popen:
        return subprocess.Popen(
            [sys.executable, str(TESTS_DIR / "mock_provider.py"), "--scenario", scenario],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

    def _stop_provider(self, proc: subprocess.Popen) -> None:
        if proc.stdin and not proc.stdin.closed:
            proc.stdin.close()
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
        self.assertEqual(proc.returncode, 0, stderr)


if __name__ == "__main__":
    unittest.main()
