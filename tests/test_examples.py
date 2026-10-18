from __future__ import annotations

import json
from pathlib import Path
import unittest

from tests.protocol_model import load_transcript, validate_transcript

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "examples"
SCHEMA = json.loads((ROOT / "spec" / "protocol-v1.schema.json").read_text(encoding="utf-8"))


class ExampleTranscriptTests(unittest.TestCase):
    """Every exchange an example shows is a transcript the model accepts, so
    the examples cannot drift from the protocol."""

    def test_every_example_transcript_is_valid(self) -> None:
        transcripts = sorted(EXAMPLES.glob("*/*.jsonl"))
        self.assertTrue(transcripts, "the examples carry transcripts")
        for path in transcripts:
            with self.subTest(transcript=str(path.relative_to(EXAMPLES))):
                validate_transcript(str(path))


class TranscriptSchemaTests(unittest.TestCase):
    """Every message of every transcript, the examples' and the model's own,
    against the JSON schema for its role. The reference providers must print
    their examples' transcripts exactly, so this is also their answers
    checked against the schema, independently of the Python model."""

    def test_every_transcript_message_matches_the_schema(self) -> None:
        try:
            import jsonschema
        except ModuleNotFoundError as exc:
            self.skipTest(f"jsonschema is not installed: {exc}")
        validators = {
            role: jsonschema.Draft202012Validator(
                {**{k: v for k, v in SCHEMA.items() if k != "oneOf"}, "$ref": f"#/$defs/{role}"}
            )
            for role in ("hello", "request", "providerResponse")
        }
        transcripts = sorted(EXAMPLES.glob("*/*.jsonl")) + sorted((ROOT / "tests" / "transcripts").glob("*.jsonl"))
        self.assertGreater(len(transcripts), 60)
        for path in transcripts:
            hello_seen = False
            for number, event in enumerate(load_transcript(str(path)), 1):
                if event.get("event") == "close":
                    continue
                if event["from"] == "client":
                    role = "request"
                elif not hello_seen:
                    role, hello_seen = "hello", True
                else:
                    role = "providerResponse"
                with self.subTest(transcript=str(path.relative_to(ROOT)), line=number, role=role):
                    errors = sorted(validators[role].iter_errors(event["message"]), key=str)
                    self.assertEqual([e.message for e in errors], [])


if __name__ == "__main__":
    unittest.main()
