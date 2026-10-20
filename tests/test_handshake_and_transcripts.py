from __future__ import annotations

import json
import tempfile
import unittest

from tests.protocol_model import (
    CacheKey,
    ClientState,
    CredentialClientModel,
    ProviderConfig,
    ProtocolViolation,
    validate_transcript,
)

from pathlib import Path


TRANSCRIPTS = Path(__file__).resolve().parent / "transcripts"


class HandshakeTests(unittest.TestCase):
    def test_valid_hello_moves_client_to_ready(self) -> None:
        client = CredentialClientModel()

        selected = client.receive_hello({"v": [1, 2]})

        self.assertEqual(selected, 1)
        self.assertEqual(client.state, ClientState.READY)

    def test_a_hello_follows_the_schema_in_what_fuzzing_found_unclear(self) -> None:
        client = CredentialClientModel()
        self.assertEqual(client.receive_hello({"v": [1.0, 2e0]}), 1)
        for hello in (
            {"v": [2**53]},
            {"v": [1.5]},
            {"v": [1e400]},
            {"v": [1], "x": "\ud800"},
            {"v": [1], "capabilities": None},
            {"v": [1], "registries": None},
        ):
            with self.subTest(hello=hello), self.assertRaises(ProtocolViolation):
                CredentialClientModel().receive_hello(hello)

    def test_malformed_hello_is_rejected(self) -> None:
        client = CredentialClientModel()

        with self.assertRaises(ProtocolViolation):
            client.receive_hello({"v": "1"})

        self.assertEqual(client.state, ClientState.FAILED)

    def test_hello_capabilities_are_recorded(self) -> None:
        client = CredentialClientModel()

        client.receive_hello({"v": [1], "capabilities": ["login", "erase", "future"]})

        self.assertEqual(client.capabilities, frozenset({"login", "erase"}))

    def test_malformed_hello_capabilities_are_rejected(self) -> None:
        client = CredentialClientModel()

        with self.assertRaises(ProtocolViolation):
            client.receive_hello({"v": [1], "capabilities": "erase"})

        self.assertEqual(client.state, ClientState.FAILED)

    def test_version_mismatch_fails_closed_when_provider_configured(self) -> None:
        with self.assertRaises(ProtocolViolation):
            validate_transcript(str(TRANSCRIPTS / "version-mismatch.jsonl"))

    def test_version_mismatch_can_fall_back_when_no_provider_was_configured(self) -> None:
        client = validate_transcript(
            str(TRANSCRIPTS / "version-mismatch.jsonl"),
            config=ProviderConfig(configured=False),
        )

        self.assertEqual(client.state, ClientState.FAILED)

    def test_close_before_ready_is_rejected(self) -> None:
        with self.assertRaises(ProtocolViolation):
            CredentialClientModel().close()


class TranscriptTests(unittest.TestCase):
    def test_get_success_transcript_caches_scope_token(self) -> None:
        client = validate_transcript(str(TRANSCRIPTS / "get-success.jsonl"))

        self.assertEqual(client.state.value, "closed")
        self.assertIn(CacheKey("scope", "https://registry.example.test/", "@scope"), client.cache)
        self.assertEqual(
            client.cache[CacheKey("scope", "https://registry.example.test/", "@scope")].auth["token"],
            "token-1",
        )

    def test_provider_chain_transcript_allows_try_next(self) -> None:
        client = validate_transcript(str(TRANSCRIPTS / "provider-chain.jsonl"))

        self.assertEqual(client.state.value, "closed")
        self.assertEqual(client.cache, {})

    def test_erase_then_retry_transcript_replaces_the_rejected_token(self) -> None:
        client = validate_transcript(str(TRANSCRIPTS / "erase-retry.jsonl"))

        self.assertEqual(
            client.cache[CacheKey("scope", "https://registry.example.test/", "@scope")].auth["token"],
            "token-2",
        )

    def test_retry_returning_a_coarser_granularity_leaves_no_trace_of_the_rejected_token(self) -> None:
        client = validate_transcript(str(TRANSCRIPTS / "erase-retry-coarser.jsonl"))
        registry = "https://registry.example.test/"

        self.assertEqual(set(client.cache), {CacheKey("registry", registry)})
        for package in ("pkg", "other"):
            entry = client.lookup(registry, "@scope", package)
            self.assertEqual(entry.auth["token"], "registry-token-2")
        self.assertEqual(client.lookup(registry, "@scope").auth["token"], "registry-token-2")

    def test_a_retry_answered_other_fails_that_request_and_the_session_goes_on(self) -> None:
        client = validate_transcript(str(TRANSCRIPTS / "retry-after-403-nothing-else.jsonl"))

        self.assertEqual(client.state, ClientState.CLOSED)

    def test_an_erase_answered_other_is_followed_by_the_retry(self) -> None:
        client = validate_transcript(str(TRANSCRIPTS / "erase-other-then-retry.jsonl"))

        self.assertEqual(
            client.cache[CacheKey("scope", "https://registry.example.test/", "@scope")].auth["token"],
            "token-2",
        )

    def test_a_malformed_error_answer_is_still_a_protocol_violation(self) -> None:
        lines = (TRANSCRIPTS / "retry-after-403-nothing-else.jsonl").read_text(encoding="utf-8").splitlines()
        for bad in ('{"kind":"permission-denied"}', '{"kind":"other","message":7}'):
            with self.subTest(err=bad), tempfile.TemporaryDirectory() as scratch:
                path = Path(scratch) / "t.jsonl"
                path.write_text(
                    "\n".join(lines[:4] + ['{"from":"provider","message":{"Err":' + bad + "}}"] + lines[5:]) + "\n",
                    encoding="utf-8",
                )
                with self.assertRaises(ProtocolViolation):
                    validate_transcript(str(path))

    def test_a_session_serves_one_npm_command(self) -> None:
        """A provider process lives for one npm command, so an `npm ci` and an
        `npm publish` are two sessions and cannot be one transcript."""
        registry = "https://registry.example.test/"
        ok = {"Ok": {"kind": "get", "auth": {"type": "bearer", "token": "t"}, "cache": "session"}}

        def transcript(*commands: str) -> list[dict]:
            events = [{"from": "provider", "message": {"v": [1]}}]
            for command in commands:
                events.append({"from": "client", "message": {
                    "v": 1, "kind": "get", "registry": registry, "operation": "read", "command": command,
                    "interactive": False}})
                events.append({"from": "provider", "message": ok})
            events.append({"from": "client", "event": "close"})
            return events

        def validate(events: list[dict]) -> None:
            with tempfile.TemporaryDirectory() as scratch:
                path = Path(scratch) / "t.jsonl"
                path.write_text("\n".join(json.dumps(event) for event in events) + "\n", encoding="utf-8")
                validate_transcript(str(path))

        validate(transcript("ci", "ci"))
        with self.assertRaises(ProtocolViolation):
            validate(transcript("ci", "publish"))

    def test_not_found_leaves_the_session_usable_for_the_chain(self) -> None:
        client = validate_transcript(str(TRANSCRIPTS / "not-found.jsonl"))

        self.assertEqual(client.state.value, "ready")

    def test_not_found_can_use_explicit_legacy_fallback(self) -> None:
        client = validate_transcript(
            str(TRANSCRIPTS / "not-found.jsonl"),
            config=ProviderConfig(configured=True, legacy_fallback=True),
        )

        self.assertEqual(client.state.value, "ready")


if __name__ == "__main__":
    unittest.main()
