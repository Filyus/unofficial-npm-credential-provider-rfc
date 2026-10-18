"""The schema, the Python model, the Rust crate and the JavaScript providers
agree on which messages are acceptable.

A few thousand messages made from the transcripts' with fields dropped,
retyped, added and respelled and bytes mangled, with fixed seeds, in the
normal suite; tests/fuzz_messages.py runs the same for as long as asked.
Needs `cargo` and `node`.
"""

from __future__ import annotations

import collections
import shutil
import unittest
from unittest import mock

from tests import differential as d


@unittest.skipUnless(shutil.which("cargo") and shutil.which("node"), "cargo and node are needed")
class DifferentialTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.pool = d.bases()

    def test_the_readers_agree_on_every_message(self) -> None:
        cases = d.generate(2026, 2500, self.pool)
        found = d.judge(cases)
        report = "\n".join(
            f"{entry['case'].role} {entry['verdicts']}\n   {entry['case'].text[:240]!r}" for entry in found[:6]
        )
        self.assertEqual(found, [], f"{len(found)} disagreements:\n{report}")

    def test_the_messages_are_not_all_refused_or_all_accepted(self) -> None:
        """Agreement on nothing but errors would prove nothing."""
        counts: collections.Counter[tuple[str, str]] = collections.Counter()
        validators = d.schema_validators()
        for case in d.generate(7, 1500, self.pool):
            message = d.parse_for_python(case.text)
            if message is d.DUPLICATE:
                continue
            if message is None and not d._parses(case.text):
                counts[(case.role, "unparseable")] += 1
            else:
                counts[(case.role, d.verdict_schema(validators, case.role, message))] += 1
        for role in d.ROLES:
            for verdict in ("ok", "err", "unparseable"):
                self.assertGreater(counts[(role, verdict)], 50, f"{role} {verdict}: {dict(counts)}")

    def test_a_reader_that_says_otherwise_is_found(self) -> None:
        cases = d.generate(2026, 600, self.pool)
        with mock.patch.object(d, "verdict_python", lambda role, message: "ok"):
            self.assertGreater(len(d.judge(cases)), 20)

    def test_a_crash_is_a_disagreement_even_when_everyone_says_the_same(self) -> None:
        cases = [d.Case("response", self.pool["response"][0], [["set", [], 1]])]
        with mock.patch.object(d, "verdict_python", lambda role, message: "crash TypeError: x"):
            found = d.judge(cases)
        self.assertEqual(len(found), 1)

    def test_shrinking_keeps_only_the_operations_that_matter(self) -> None:
        base = self.pool["hello"][0]
        case = d.Case("hello", base, [["add", [], "x", 1], ["set", ["v"], []], ["add", [], "y", 2]])
        small = d.shrink_case(case, lambda trial: b'"v": []' in trial.text)
        self.assertEqual(small.ops, [["set", ["v"], []]])


if __name__ == "__main__":
    unittest.main()
