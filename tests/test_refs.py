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

    def test_a_redirect_to_another_host_is_not_followed(self) -> None:
        import urllib.error
        import urllib.request
        handler = refs.SameHost()
        request = urllib.request.Request("https://docs.example.test/a")
        self.assertIsNotNone(handler.redirect_request(request, None, 301, "", {}, "https://docs.example.test/b"))
        with self.assertRaises(urllib.error.HTTPError):
            handler.redirect_request(request, None, 301, "", {}, "https://elsewhere.example.test/a")

    def test_a_branch_link_and_a_commit_link_are_told_apart(self) -> None:
        self.assertTrue(refs.BRANCH_SOURCE.match("https://github.com/o/r/blob/master/a/b.go"))
        self.assertTrue(refs.BRANCH_SOURCE.match("https://github.com/o/r/blob/main/a.md"))
        self.assertFalse(refs.BRANCH_SOURCE.match("https://github.com/o/r/blob/" + "a" * 40 + "/a.md"))
        self.assertTrue(refs.PINNED_SOURCE.match("https://github.com/o/r/blob/" + "a" * 40 + "/a.md"))

    def test_a_branch_other_than_master_and_main_and_a_tag_are_not_commits(self) -> None:
        """A tag can be deleted and made again, so only a 40-hex id is a commit."""
        for ref in ("develop", "v1.2.3", "release-1.x", "a" * 7, "a" * 39, "a" * 41, "A" * 40):
            with self.subTest(ref=ref):
                self.assertTrue(refs.BRANCH_SOURCE.match(f"https://github.com/o/r/blob/{ref}/a.go"))
        self.assertFalse(refs.BRANCH_SOURCE.match("https://github.com/o/r/blob/" + "a" * 40 + "/a.go"))

    def test_a_fenced_block_cites_nothing(self) -> None:
        """A pull request text in a fence links the main branch of this repository, as it must where it is pasted."""
        text = ("[a](https://example.test/a)\n\n```markdown\nsee [b](https://example.test/b) and <https://example.test/c>\n```\n\n"
                "~~~\n[d](https://example.test/d)\n~~~\n[e](https://example.test/e) and <https://example.test/f>\n")
        self.assertEqual(refs.links_in(text), ["https://example.test/a", "https://example.test/e", "https://example.test/f"])

    def test_pinning_rewrites_whole_link_targets_only(self) -> None:
        old, new = "https://github.com/o/r/blob/main/a.go", "https://github.com/o/r/blob/" + "a" * 40 + "/a.go"
        text = (f"[a]({old}) [b]({old}2) <{old}> [c]({old}#L10) text {old} in prose\n"
                "[d](https://github.com/o/r/blob/main/b.go)\n")
        self.assertEqual(
            refs.pin_text(text, {old: new}),
            f"[a]({new}) [b]({old}2) <{new}> [c]({new}#L10) text {old} in prose\n"
            "[d](https://github.com/o/r/blob/main/b.go)\n")

    @staticmethod
    def _robots(answer):
        """An opener whose answer is a status code, an exception, or the body."""
        import io
        import urllib.error

        class Opener:
            def open(self, request, timeout=None):
                if isinstance(answer, int):
                    raise urllib.error.HTTPError(request.full_url, answer, "x", {}, io.BytesIO())
                if isinstance(answer, Exception):
                    raise answer
                return io.BytesIO(answer)
        return Opener()

    def test_robots_txt_that_denies_or_cannot_be_read_is_not_permission(self) -> None:
        url = "https://docs.example.test/a"
        for code in (401, 403):
            with self.subTest(code=code):
                parser, why = refs.robots_of("docs.example.test", self._robots(code))
                self.assertFalse(parser.can_fetch(refs.USER_AGENT, url))
                self.assertIn("disallows", why)
        for answer in (500, 503, 429, 301, ConnectionResetError("reset"), TimeoutError("slow")):
            with self.subTest(answer=answer):
                parser, why = refs.robots_of("docs.example.test", self._robots(answer))
                self.assertIsNone(parser)
                self.assertTrue(why.startswith(refs.UNREACHABLE), why)

    def test_robots_txt_that_is_absent_or_read_is_obeyed_as_written(self) -> None:
        url = "https://docs.example.test/a"
        parser, why = refs.robots_of("docs.example.test", self._robots(404))
        self.assertEqual((parser.can_fetch(refs.USER_AGENT, url), why), (True, ""))
        parser, why = refs.robots_of("docs.example.test", self._robots(b"User-agent: *\nDisallow: /a\n"))
        self.assertFalse(parser.can_fetch(refs.USER_AGENT, url))
        self.assertTrue(parser.can_fetch(refs.USER_AGENT, "https://docs.example.test/b"))

    def test_robots_txt_is_read_through_the_opener_that_refuses_other_hosts(self) -> None:
        import inspect
        self.assertIs(inspect.signature(refs.robots_of).parameters["opener"].default, refs.OPENER)


if __name__ == "__main__":
    unittest.main()
