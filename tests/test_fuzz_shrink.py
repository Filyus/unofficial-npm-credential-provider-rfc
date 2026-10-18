"""The shrinker of tests/provider_harness.py, on a fake: no provider runs."""

from __future__ import annotations

from pathlib import Path
import unittest
from unittest import mock

from tests import provider_harness
from tests.provider_harness import Violation, all_indices, shrink


def fake_runs(rule):
    """A run_session whose result is `rule(indices)`: None, or an invariant."""
    def run(name, transcript, seed, indices, *, hostile, deadline=10):
        invariant = rule(indices)
        return (Violation(invariant, "fake") if invariant else None), None
    return run


class ShrinkTests(unittest.TestCase):
    def shrunk(self, rule, first="a") -> list:
        with mock.patch.object(provider_harness, "run_session", fake_runs(rule)):
            steps, violation = shrink("p", Path("t.jsonl"), 1, all_indices(), Violation(first, "fake"), hostile=True)
        self.assertEqual(violation.invariant, first)
        return steps

    def test_it_keeps_the_steps_that_must_all_be_there_in_order(self) -> None:
        self.assertEqual(self.shrunk(lambda s: "a" if 3 in s and 11 in s else None), [3, 11])

    def test_one_step_is_enough_when_it_is(self) -> None:
        self.assertEqual(self.shrunk(lambda s: "a" if 7 in s else None), [7])
        self.assertEqual(self.shrunk(lambda s: "a" if "learn" in s else None), ["learn"])

    def test_a_failure_that_needs_no_step_shrinks_to_none(self) -> None:
        self.assertEqual(self.shrunk(lambda s: "a"), [])

    def test_it_does_not_trade_one_invariant_for_another(self) -> None:
        # without step 5 the run breaks a different invariant: step 5 stays
        rule = lambda s: "a" if 5 in s and 9 in s else ("b" if 9 in s else None)
        self.assertEqual(self.shrunk(rule), [5, 9])

    def test_it_runs_far_fewer_sessions_than_there_are_subsets(self) -> None:
        count = []
        base = fake_runs(lambda s: "a" if 4 in s and 15 in s else None)

        def counted(*args, **kwargs):
            count.append(1)
            return base(*args, **kwargs)

        with mock.patch.object(provider_harness, "run_session", counted):
            shrink("p", Path("t.jsonl"), 1, all_indices(), Violation("a", "fake"), hostile=True)
        self.assertLess(len(count), 80)


if __name__ == "__main__":
    unittest.main()
