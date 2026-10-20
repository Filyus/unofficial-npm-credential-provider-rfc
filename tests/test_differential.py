"""The schema, the Python model, the Rust crate and the JavaScript providers
agree on which messages are acceptable.

A few thousand messages made from the transcripts' with fields dropped,
retyped, added and respelled and bytes mangled, with fixed seeds, in the
normal suite; tests/fuzz_messages.py runs the same for as long as asked.
Needs `cargo` and `node`.
"""

from __future__ import annotations

import collections
import json
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

    def test_every_reader_takes_a_message_nested_as_deep_as_the_rfc_lets_a_sender_go(self) -> None:
        """Phase 2: a sender stays within 64 levels of nesting and a reader may
        refuse more, so at exactly 64 no reader may refuse (the object counts as
        the first level; the deep value sits in a member nobody reads)."""
        nested = []
        for _ in range(62):
            nested = [nested]
        cases = []
        for role in d.ROLES:
            base = json.loads(json.dumps(self.pool[role][0]))
            base["x-depth"] = nested
            cases.append(d.Case(role, base, []))
        self.assertTrue(all(json.loads(case.text)["x-depth"] is not None for case in cases))
        depth = 0
        probe = json.loads(cases[0].text)["x-depth"]
        while probe:
            probe, depth = probe[0], depth + 1
        self.assertEqual(depth + 2, 64, "the probe is 64 levels deep")
        lines = [case.line() for case in cases]
        validators = d.schema_validators()
        rust, js = d.rust_verdicts(lines), d.js_verdicts(lines)
        for case, rust_verdict, js_verdict in zip(cases, rust, js):
            message = json.loads(case.text)
            with self.subTest(role=case.role):
                self.assertEqual(d.verdict_schema(validators, case.role, message), "ok")
                self.assertEqual(d.verdict_python(case.role, message), "ok")
                self.assertEqual(d.short(rust_verdict), "ok", rust_verdict)
                if case.role == "request":
                    self.assertEqual(d.short(js_verdict), "ok", js_verdict)

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
        """With every reader saying `crash`, the verdicts agree, and only the clause
        that treats a crash as a finding can report the case."""
        cases = [d.Case("response", self.pool["response"][0], [["set", [], 1]])]
        crash = lambda *_: "crash TypeError: x"  # noqa: E731
        with (
            mock.patch.object(d, "verdict_python", crash),
            mock.patch.object(d, "verdict_schema", crash),
            mock.patch.object(d, "rust_verdicts", lambda lines: ["crash x"] * len(lines)),
            mock.patch.object(d, "js_verdicts", lambda lines: ["crash x"] * len(lines)),
        ):
            found = d.judge(cases)
        self.assertEqual(len(found), 1)
        self.assertEqual({d.short(verdict) for verdict in found[0]["verdicts"].values()}, {"crash"})

    def test_an_operation_that_did_nothing_is_not_kept(self) -> None:
        """A drop of a member the message has not, or an add into something that is
        not an object, changes nothing, and a shrunk case must not name it."""
        base = {"v": [1]}
        case = d.Case("hello", base, [["drop", ["capabilities"]], ["add", [], "x", 1], ["add", ["v"], "y", 2]])
        self.assertEqual(case.ops, [["add", [], "x", 1]])
        self.assertEqual(json.loads(case.text), {"v": [1], "x": 1})

    def test_shrinking_keeps_only_the_operations_that_matter(self) -> None:
        base = self.pool["hello"][0]
        case = d.Case("hello", base, [["add", [], "x", 1], ["set", ["v"], []], ["add", [], "y", 2]])
        small = d.shrink_case(case, lambda trial: b'"v": []' in trial.text)
        self.assertEqual(small.ops, [["set", ["v"], []]])


if __name__ == "__main__":
    unittest.main()
