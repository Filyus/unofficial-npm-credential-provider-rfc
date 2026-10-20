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
from tests.tools_required import needs


@needs(bool(shutil.which("cargo") and shutil.which("node")), "cargo and node are needed")
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

    def test_a_kind_or_an_operation_that_is_not_a_name_is_refused_by_every_reader_and_an_unknown_name_is_not(self) -> None:
        """"Get", "login\\n" and "9x" are not names (the schema's pattern, with nothing after
        the last character); "refresh" and "x-y" are names this build has no
        variant for, which a provider answers `operation-not-supported`."""
        expected = {"refresh": "ok", "x-y": "ok", "Get": "err", "login\n": "err", "9x": "err", "": "err", "x_y": "err"}
        cases, wanted = [], []
        for text, verdict in expected.items():
            cases.append(d.Case("request", {"v": 1, "kind": "logout", "registry": "https://r.test/"}, [["set", ["kind"], text]]))
            cases.append(d.Case("request", {**d.GET}, [["set", ["operation"], text]]))
            wanted.append(verdict)
            wanted.append(verdict)
        lines = [case.line() for case in cases]
        validators = d.schema_validators()
        rust, js = d.rust_verdicts(lines), d.js_verdicts(lines)
        for case, verdict, rust_verdict, js_verdict in zip(cases, wanted, rust, js):
            message = json.loads(case.text)
            with self.subTest(message=case.text):
                self.assertEqual(d.verdict_schema(validators, "request", message), verdict)
                self.assertEqual(d.verdict_python("request", message), verdict)
                self.assertEqual(d.short(rust_verdict), verdict, rust_verdict)
                self.assertEqual(d.short(js_verdict), verdict, js_verdict)
        self.assertEqual(d.judge(cases), [])

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


class ShrinkRoundsTests(unittest.TestCase):
    """Shrinking on a fake `still`: no reader runs."""

    BASE = {"v": [1], "kind": "get", "registry": "r"}
    OPS = [["add", [], "a", 1], ["add", [], "b", 2], ["add", [], "c", 3], ["add", [], "d", 4]]

    def case(self) -> "d.Case":
        return d.Case("request", self.BASE, [list(op) for op in self.OPS])

    def test_a_round_asks_about_all_its_candidates_in_one_call(self) -> None:
        asked = []

        def many(cases):
            asked.append(len(cases))
            return [b'"b": 2' in each.text and b'"d": 4' in each.text for each in cases]

        small = d.shrink_case(self.case(), lambda each: self.fail("one at a time"), many)
        self.assertEqual([op[2] for op in small.ops], ["b", "d"])
        self.assertEqual(asked, [4, 1, 2])  # the round; the two that keep the case, together; the round that finds none

    def test_batched_and_one_at_a_time_leave_the_same_operations(self) -> None:
        import itertools
        names = ["a", "b", "c", "d"]
        for need in itertools.chain.from_iterable(itertools.combinations(names, n) for n in range(0, 5)):
            def still(each, need=need):
                return all(f'"{name}": '.encode() in each.text for name in need)
            with self.subTest(need=need):
                single = d.shrink_case(self.case(), still)
                batched = d.shrink_case(self.case(), still, lambda cases: [still(each) for each in cases])
                self.assertEqual(single.ops, batched.ops)
                self.assertEqual([op[2] for op in single.ops], list(need) or [single.ops[0][2]])

    def test_omissions_that_keep_the_case_only_one_at_a_time_are_not_all_taken(self) -> None:
        """Leaving out `a` keeps the case and so does leaving out `b`, but not both."""
        def still(each):
            return b'"a": 1' in each.text or b'"b": 2' in each.text

        small = d.shrink_case(self.case(), still, lambda cases: [still(each) for each in cases])
        self.assertTrue(still(small))
        self.assertEqual(len(small.ops), 1)


if __name__ == "__main__":
    unittest.main()
