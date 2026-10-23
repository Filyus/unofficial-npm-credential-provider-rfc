"""What ends a provider session, and what npm makes of a line the provider
writes (Phase 2, Session lifecycle). The table is the policy's
(`credentialProvider.sessionEnds`); the values below are written out here so that
an edit of the policy cannot move them unseen, and the spec's own table is
compared with the policy's."""

from __future__ import annotations

from pathlib import Path
import re
import unittest

from tests.generated_policy import FAILED_SESSIONS_BEFORE_NO_RESTART, SESSION_ENDS
from tests.protocol_model import (
    ProtocolViolation,
    ProviderPool,
    ProviderRestarts,
    StrayLine,
    read_provider_line,
)

ROOT = Path(__file__).resolve().parents[1]

# cause: (request in flight, session, next request, counts toward the limit)
DECIDED = {
    "timeout": ("fails", "ends", "new-process", True),
    "exit-outstanding": ("fails", "ends", "new-process", True),
    "oversized-line": ("fails", "ends", "new-process", True),
    "malformed-message": ("fails", "ends", "new-process", True),
    "stray-line": ("none", "ends", "new-process", True),
    "exit-idle": ("none", "ends", "new-process", False),
    "hello-failed": ("fails", "ends", "skipped", False),
    "error-answer": ("fails", "continues", "same-process", False),
}

COUNTING = [cause for cause, row in DECIDED.items() if row[3]]


class SessionEndTableTests(unittest.TestCase):
    def test_the_policys_table_is_the_decided_one(self) -> None:
        self.assertEqual(
            {cause: (row["request"], row["session"], row["next"], row["counts"]) for cause, row in SESSION_ENDS.items()},
            DECIDED,
        )

    def test_the_specs_table_is_the_policys(self) -> None:
        """The table in "Session lifecycle" names each cause by its id in
        parentheses, and its cells say what the policy says."""
        text = (ROOT / "phase-2-credential-provider.md").read_text(encoding="utf-8")
        words = {
            "request": {"fails": "fails", "none": "none"},
            "session": {"ends": "ends", "continues": "goes on"},
            "next": {"new-process": "new process", "same-process": "same process", "skipped": "skipped"},
            "counts": {True: "yes", False: "no"},
        }
        found = {}
        for line in text.splitlines():
            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            named = re.search(r"\(`([a-z-]+)`\)$", cells[0]) if len(cells) == 5 else None
            if named:
                found[named.group(1)] = tuple(cells[1:])
        self.assertEqual(set(found), set(SESSION_ENDS), "every cause of the policy is a row, and no more")
        for cause, row in SESSION_ENDS.items():
            expected = (
                words["request"][row["request"]],
                words["session"][row["session"]],
                words["next"][row["next"]],
                words["counts"][row["counts"]],
            )
            for cell, word in zip(found[cause], expected):
                with self.subTest(cause=cause, word=word):
                    self.assertTrue(cell.startswith(word), f"{cause}: {cell!r} does not start with {word!r}")


class ProviderSessionStateTests(unittest.TestCase):
    def provider(self) -> ProviderRestarts:
        restarts = ProviderRestarts()
        restarts.start()
        return restarts

    def test_a_cause_that_counts_fails_the_request_ends_the_session_and_the_next_request_starts_a_new_one(self) -> None:
        for cause in ("timeout", "exit-outstanding", "oversized-line", "malformed-message"):
            with self.subTest(cause=cause):
                restarts = self.provider()
                self.assertEqual(restarts.end(cause, queued=["a", "b"]), ["a", "b"], "the queued requests fail with it")
                self.assertEqual(restarts.next_request(), "new-process")
                self.assertEqual(restarts.kills, 1)
                restarts.start()
                self.assertEqual(restarts.starts, 2)

    def test_twice_is_enough_whatever_the_causes(self) -> None:
        """The two are of any counting causes together, not two timeouts."""
        for first in COUNTING:
            for second in COUNTING:
                with self.subTest(first=first, second=second):
                    restarts = self.provider()
                    restarts.end(first)
                    self.assertEqual(restarts.next_request(), "new-process")
                    restarts.start()
                    restarts.end(second)
                    self.assertEqual(restarts.next_request(), "none")
                    with self.assertRaises(ProtocolViolation):
                        restarts.start()
        self.assertEqual(FAILED_SESSIONS_BEFORE_NO_RESTART, 2)

    def test_a_stray_line_is_warned_about_by_name_counted_and_replaced(self) -> None:
        restarts = self.provider()

        self.assertEqual(restarts.end("stray-line", queued=[], name="npm-credential-provider-x"), [])

        self.assertEqual(restarts.kills, 1)
        self.assertEqual(restarts.next_request(), "new-process")
        self.assertEqual(len(restarts.warnings), 1)
        self.assertIn("npm-credential-provider-x", restarts.warnings[0])
        # no other cause warns
        for cause in DECIDED:
            if cause != "stray-line":
                other = self.provider()
                other.end(cause)
                self.assertEqual(other.warnings, [], cause)

    def test_a_provider_that_exits_while_idle_is_no_failure_however_often(self) -> None:
        restarts = self.provider()
        for _ in range(5):
            self.assertEqual(restarts.end("exit-idle"), [])
            self.assertEqual(restarts.next_request(), "new-process")
            restarts.start()
        self.assertEqual((restarts.kills, restarts.starts), (0, 6))
        # and it does not use up a count a failure then needs
        restarts.end("timeout")
        self.assertEqual(restarts.next_request(), "new-process")

    def test_a_failed_hello_skips_the_provider_for_the_rest_of_the_command(self) -> None:
        restarts = ProviderRestarts()
        restarts.start()

        self.assertEqual(restarts.end("hello-failed", queued=["a"]), ["a"])

        self.assertEqual(restarts.kills, 0)
        self.assertEqual(restarts.next_request(), "none")
        with self.assertRaises(ProtocolViolation):
            restarts.start()
        self.assertEqual(restarts.starts, 1)

    def test_an_error_answer_fails_its_request_and_leaves_the_session_alone(self) -> None:
        restarts = self.provider()

        self.assertEqual(restarts.end("error-answer", queued=["a"]), ["a"])

        self.assertEqual(restarts.next_request(), "same-process")
        self.assertEqual(restarts.kills, 0)

    def test_a_timeout_at_hello_still_counts_and_starts_again(self) -> None:
        """A hello that never comes is a timeout like any other; only a hello
        that came and was refused skips the provider."""
        restarts = ProviderRestarts()
        restarts.start()
        restarts.end("timeout")
        self.assertEqual(restarts.next_request(), "new-process")


class ProviderIdentityTests(unittest.TestCase):
    PATH = "/usr/local/bin/npm-credential-provider-gitlab"

    def test_one_identity_is_one_process_whichever_lists_name_it(self) -> None:
        pool = ProviderPool()
        # the global chain, then two per-registry lists, each naming the same path and arguments
        for _ in range(3):
            provider = pool.provider(self.PATH, ["--instance", "https://gitlab.example.com"])
            if not provider.session_open:
                provider.start()
        self.assertEqual(len(pool.providers), 1)
        self.assertEqual(provider.starts, 1)

    def test_a_different_path_or_argument_is_another_provider(self) -> None:
        pool = ProviderPool()
        pool.provider(self.PATH, ["--instance", "https://a.example.com"])
        pool.provider(self.PATH, ["--instance", "https://b.example.com"])
        pool.provider(self.PATH + "-other", ["--instance", "https://a.example.com"])
        pool.provider(self.PATH)
        self.assertEqual(len(pool.providers), 4)

    def test_each_identity_has_its_own_limit(self) -> None:
        pool = ProviderPool()
        failing = pool.provider(self.PATH, ["--a"])
        failing.start()
        failing.end("timeout")
        failing.start()
        failing.end("timeout")
        self.assertEqual(failing.next_request(), "none")
        self.assertEqual(pool.provider(self.PATH, ["--b"]).next_request(), "new-process")


class ProviderLineTests(unittest.TestCase):
    HELLO = b'{"v":[1]}\n'

    def test_a_line_is_read_as_json(self) -> None:
        self.assertEqual(read_provider_line(self.HELLO), {"v": [1]})

    def test_a_byte_order_mark_before_the_first_line_is_skipped(self) -> None:
        self.assertEqual(read_provider_line(b"\xef\xbb\xbf" + self.HELLO, first=True), {"v": [1]})
        # a line of its own is a blank line, skipped like one
        self.assertIsNone(read_provider_line(b"\xef\xbb\xbf\n", first=True))

    def test_a_byte_order_mark_anywhere_else_is_not_json(self) -> None:
        with self.assertRaisesRegex(ProtocolViolation, "malformed line of"):
            read_provider_line(b"\xef\xbb\xbf" + self.HELLO, first=False)

    def test_a_blank_line_is_ignored_and_is_no_stray_line(self) -> None:
        for blank in (b"\n", b"  \t\r\n", b"\r\n"):
            for outstanding in (True, False):
                with self.subTest(blank=blank, outstanding=outstanding):
                    self.assertIsNone(read_provider_line(blank, outstanding=outstanding))

    def test_a_carriage_return_before_the_newline_is_trailing_whitespace(self) -> None:
        self.assertEqual(read_provider_line(b'{"v":[1]}\r\n'), {"v": [1]})
        self.assertEqual(read_provider_line(b'{"v":[1]} \t\r\n'), {"v": [1]})

    def test_a_line_while_no_request_is_outstanding_is_a_stray_line(self) -> None:
        with self.assertRaises(StrayLine):
            read_provider_line(b'{"Ok":{"kind":"get"}}\n', outstanding=False)
        with self.assertRaises(StrayLine):
            read_provider_line(b"not json at all\n", outstanding=False)

    def test_no_diagnostic_quotes_the_line(self) -> None:
        secret = b"super-secret-token"
        lines = {
            "stray": (b'{"Ok":{"auth":{"token":"' + secret + b'"}}}\n', {"outstanding": False}),
            "not json": (b"token=" + secret + b"\n", {}),
            "not utf-8": (b"\xff\xfe" + secret + b"\n", {}),
            "oversized": (secret * 100_000 + b"\n", {}),
            "a bom and not json": (b"\xef\xbb\xbftoken=" + secret + b"\n", {"first": True}),
        }
        for name, (raw, options) in lines.items():
            with self.subTest(line=name):
                with self.assertRaises(ProtocolViolation) as caught:
                    read_provider_line(raw, **options)
                text = f"{caught.exception}{caught.exception!r}"
                self.assertNotIn("secret", text)
                self.assertIn(str(len(raw)), text, "it says how long the line was")


if __name__ == "__main__":
    unittest.main()
