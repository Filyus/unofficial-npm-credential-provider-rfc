from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import re
import unittest

from tests.protocol_model import load_transcript, validate_transcript
from tests.tools_required import skip_or_fail

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "examples"
_spec = importlib.util.spec_from_file_location("example_coverage", ROOT / "tools" / "example_coverage.py")
coverage = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(coverage)
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
        return sorted(page for page in EXAMPLES.glob("*.md") if page.name not in ("README.md", "COVERAGE.md"))

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
            skip_or_fail(self, f"jsonschema is not installed: {exc}")
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


class CoverageTests(unittest.TestCase):
    """examples/COVERAGE.md says which situations the examples show, computed
    from the transcripts. A gap is allowed only when examples/coverage.json says
    why (`n/a: reason`) or which task fills it (`task N: what`), and an
    explanation may not outlive the gap it explained, so the page cannot differ
    from the files in either direction."""

    def test_every_empty_cell_is_explained_and_no_explanation_is_stale(self) -> None:
        table, notes = coverage.matrix(), coverage.explanations()
        for registry, cells in table.items():
            for feature, cell in cells.items():
                note = notes.get(registry, {}).get(feature)
                with self.subTest(registry=registry, feature=feature):
                    if cell:
                        self.assertIsNone(note, "the cell is filled; delete its explanation from coverage.json")
                    else:
                        self.assertIsNotNone(note, "an empty cell needs `n/a: reason` or `task N: what` in coverage.json")
                        self.assertRegex(note, r"^(n/a: .{10,}|task \d+: .{5,})$")
        for registry in table:
            note = notes.get(registry, {}).get("provider")
            with self.subTest(registry=registry, feature="provider"):
                if coverage.has_provider(registry):
                    self.assertIsNone(note, "the registry has a provider; delete its explanation from coverage.json")
                else:
                    self.assertRegex(note or "", r"^(n/a: .{10,}|task \d+: .{5,})$", "no provider: say why or name the task")
        for registry, cells in notes.items():
            self.assertIn(registry, table, "coverage.json names a registry that has no example")
            for feature in cells:
                self.assertTrue(feature in coverage.FEATURES or feature == "provider", f"{registry}: no such situation")

    def test_the_page_is_what_the_transcripts_say(self) -> None:
        page = (EXAMPLES / "COVERAGE.md").read_text(encoding="utf-8")
        self.assertEqual(page, coverage.render(), "run: python tools/example_coverage.py")

    def test_a_registry_with_a_directory_is_in_the_matrix(self) -> None:
        directories = {path.name for path in EXAMPLES.iterdir() if path.is_dir() and path.name != "providers"}
        self.assertEqual(directories, set(coverage.REGISTRIES))

    def test_the_features_are_read_from_what_a_transcript_holds(self) -> None:
        got = coverage.features_of(EXAMPLES / "github-packages" / "rejection-403.jsonl")
        self.assertEqual(got, {"install", "403-retry"})
        self.assertIn("401-dead", coverage.features_of(EXAMPLES / "npmjs" / "rejection-dead-token.jsonl"))
        self.assertIn("login", coverage.features_of(EXAMPLES / "aws-codeartifact" / "login.jsonl"))
        self.assertIn("logout", coverage.features_of(EXAMPLES / "aws-codeartifact" / "login.jsonl"))


if __name__ == "__main__":
    unittest.main()
