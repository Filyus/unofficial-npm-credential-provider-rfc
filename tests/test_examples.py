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


class PagesAndTranscriptsTests(unittest.TestCase):
    """A page and its transcripts say the same: every transcript is linked from
    the page of its example, and every JSON line a page shows is a message of one
    of them, so that a page cannot describe an exchange no file has."""

    def pages(self):
        return sorted(page for page in EXAMPLES.glob("*.md") if page.name != "README.md")

    def test_every_transcript_is_linked_from_its_page(self) -> None:
        for page in self.pages():
            text = page.read_text(encoding="utf-8")
            for transcript in sorted((EXAMPLES / page.stem).glob("*.jsonl")):
                with self.subTest(page=page.name, transcript=transcript.name):
                    self.assertIn(f"{page.stem}/{transcript.name}", text, "no link to it")

    def test_every_json_block_a_page_shows_is_part_of_a_transcript_linked_in_its_section(self) -> None:
        """The lines of a block are messages of one transcript that the section of the
        page links, in its order (a block may leave some out). Taken one by one, or
        against any transcript of the example, a line would match the same message in
        another file, and a changed token in the one it is shown for would pass. A
        hello, which every transcript of an example starts with, is not tied to one."""
        import re

        for page in self.pages():
            text = page.read_text(encoding="utf-8")
            transcripts = {
                transcript.name: [event["message"] for event in load_transcript(str(transcript)) if "message" in event]
                for transcript in (EXAMPLES / page.stem).glob("*.jsonl")
            }
            self.assertTrue(transcripts, page.name)
            for block in re.finditer(r"```json\n(.*?)```", text, re.S):
                lines = [json.loads(line) for line in block.group(1).splitlines() if line.strip().startswith("{")]
                if not lines or (isinstance(lines[0].get("v"), list) and len(lines) == 1):
                    continue
                start = max(text.rfind("\n## ", 0, block.start()), 0)
                end = text.find("\n## ", block.end())
                section = text[start:len(text) if end == -1 else end]
                linked = set(re.findall(re.escape(page.stem) + r"/([\w.-]+\.jsonl)", section))
                with self.subTest(page=page.name, block=block.group(1)[:90]):
                    self.assertTrue(
                        any(self.in_order(lines, transcripts[name]) for name in linked if name in transcripts),
                        f"no transcript linked in this section has these messages in this order ({sorted(linked)})",
                    )

    @staticmethod
    def in_order(lines: list, messages: list) -> bool:
        remaining = iter(messages)
        return all(any(message == line for message in remaining) for line in lines)


class TranscriptSchemaTests(unittest.TestCase):
    """Every message of every transcript, the examples' and the model's own,
    against the JSON schema for its role, independently of the Python model.
    (examples/providers/run.js makes the reference providers print their examples'
    transcripts exactly, which is what ties these answers to the providers.)"""

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
