from __future__ import annotations

import unittest

from tests.protocol_model import (
    ClientState,
    CredentialClientModel,
    ProviderConfig,
    ProviderFailure,
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

    def test_malformed_hello_is_rejected(self) -> None:
        client = CredentialClientModel()

        with self.assertRaises(ProtocolViolation):
            client.receive_hello({"v": "1"})

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
        self.assertIn(("https://registry.example.test/", "@scope"), client.cache)
        self.assertEqual(
            client.cache[("https://registry.example.test/", "@scope")].auth["token"],
            "token-1",
        )

    def test_provider_chain_transcript_allows_try_next(self) -> None:
        client = validate_transcript(str(TRANSCRIPTS / "provider-chain.jsonl"))

        self.assertEqual(client.state.value, "closed")
        self.assertEqual(client.cache, {})

    def test_refresh_transcript_validates_refresh_state(self) -> None:
        client = validate_transcript(str(TRANSCRIPTS / "refresh-success.jsonl"))

        self.assertIn(("https://registry.example.test/", None), client.cache)

    def test_not_found_fails_without_explicit_legacy_fallback(self) -> None:
        with self.assertRaises(ProviderFailure):
            validate_transcript(str(TRANSCRIPTS / "not-found.jsonl"))

    def test_not_found_can_use_explicit_legacy_fallback(self) -> None:
        client = validate_transcript(
            str(TRANSCRIPTS / "not-found.jsonl"),
            config=ProviderConfig(configured=True, legacy_fallback=True),
        )

        self.assertEqual(client.state.value, "ready")


if __name__ == "__main__":
    unittest.main()
