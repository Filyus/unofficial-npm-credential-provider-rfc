from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("prose", ROOT / "tools" / "prose.py")
prose = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(prose)


class ProseTests(unittest.TestCase):
    """No paragraph, list item or table cell in the documents is so long that a
    reader skims past the rule in it. A block over the limit is split by
    structure (paragraphs, a list, a table) or cut; reflowing it changes
    nothing."""

    def test_no_block_in_the_documents_is_over_the_limits(self) -> None:
        found = prose.problems()
        self.assertEqual(found, [], "split these by structure or cut them:\n" + "\n".join(found))

    def test_what_counts_as_a_block(self) -> None:
        text = "\n".join([
            "one two three",
            "four",
            "",
            "- an item",
            "  that goes on",
            "- another",
            "",
            "| a b | c |",
            "",
            "```",
            "code " * 500,
            "```",
            "[link](https://example.test/a/very/long/target/that/is/not/prose)",
        ])
        found = [(kind, prose.words(body)) for kind, _, body in prose.blocks(text)]
        self.assertEqual(found, [
            ("paragraph", 4), ("list item", 6), ("list item", 2),
            ("table cell", 2), ("table cell", 1), ("paragraph", 1),
        ])

    def test_a_long_paragraph_is_reported_with_where_it_starts(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT) as scratch:
            path = Path(scratch) / "long.md"
            path.write_text("# Title\n\n" + "word " * (prose.LIMIT_BLOCK + 1) + "\n", encoding="utf-8")
            found = prose.too_long(path)
        self.assertEqual(len(found), 1)
        self.assertIn("long.md:3: a paragraph of 121 words", found[0])


if __name__ == "__main__":
    unittest.main()
