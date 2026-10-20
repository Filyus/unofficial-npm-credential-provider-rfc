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

    def test_every_page_has_a_copy_or_says_why_not(self) -> None:
        for url, entry in refs.load().items():
            if entry["kind"] != "source":
                with self.subTest(url=url):
                    self.assertTrue("sha256" in entry or entry.get("status"), "no copy, no reason")

    def test_the_copies_that_are_here_are_the_ones_the_list_hashed(self) -> None:
        """.refs/ is not tracked, so this runs where the copies were made; the
        hash is what someone who fetches the page himself compares against."""
        import hashlib
        checked = 0
        for url, entry in refs.load().items():
            path = ROOT / entry.get("file", "")
            if "sha256" in entry and path.is_file():
                checked += 1
                with self.subTest(url=url):
                    self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), entry["sha256"])
        if not checked:
            self.skipTest("no copies in .refs/ on this machine")

    def test_a_branch_link_and_a_commit_link_are_told_apart(self) -> None:
        self.assertTrue(refs.BRANCH_SOURCE.match("https://github.com/o/r/blob/master/a/b.go"))
        self.assertTrue(refs.BRANCH_SOURCE.match("https://github.com/o/r/blob/main/a.md"))
        self.assertFalse(refs.BRANCH_SOURCE.match("https://github.com/o/r/blob/" + "a" * 40 + "/a.md"))
        self.assertTrue(refs.PINNED_SOURCE.match("https://github.com/o/r/blob/" + "a" * 40 + "/a.md"))


if __name__ == "__main__":
    unittest.main()
