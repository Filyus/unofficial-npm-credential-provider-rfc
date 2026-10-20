from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("refs", ROOT / "tools" / "refs.py")
refs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(refs)


class RefsTests(unittest.TestCase):
    """refs.json is the list of what the documents cite: nothing cited is
    missing from it, nothing in it is cited by no one, and a link to source code
    names a commit, since a branch moves while the file we read stays put."""

    def test_the_documents_and_the_list_of_sources_agree(self) -> None:
        self.assertEqual(refs.problems(), [])

    def test_every_entry_says_what_kind_of_source_it_is_and_since_when(self) -> None:
        for url, entry in refs.load().items():
            with self.subTest(url=url):
                self.assertIn(entry.get("kind"), {"page", "source", "discussion", "standard"})
                self.assertRegex(entry.get("cited", ""), r"^\d{4}-\d\d-\d\d$")

    def test_a_branch_link_and_a_commit_link_are_told_apart(self) -> None:
        self.assertTrue(refs.BRANCH_SOURCE.match("https://github.com/o/r/blob/master/a/b.go"))
        self.assertTrue(refs.BRANCH_SOURCE.match("https://github.com/o/r/blob/main/a.md"))
        self.assertFalse(refs.BRANCH_SOURCE.match("https://github.com/o/r/blob/" + "a" * 40 + "/a.md"))
        self.assertTrue(refs.PINNED_SOURCE.match("https://github.com/o/r/blob/" + "a" * 40 + "/a.md"))


if __name__ == "__main__":
    unittest.main()
