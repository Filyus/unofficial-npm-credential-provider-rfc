"""Random sessions against the reference providers in examples/providers.

The transcripts check what someone thought to record. Here a seeded
generator sends each reference provider sessions of its own, from every
scenario's starting state: any operation (now and then one no version
knows), either `interactive`, a 401 retry after an erase or a 403 retry
without one, a registry the provider does not serve, a kind no version
knows, login and logout. The answers are not known in advance, so what is
checked is what the RFC requires of every provider; the invariants are listed
in tests/provider_harness.py (`INVARIANTS`).

Needs `node`. A few seconds: one session per scenario, a fixed seed each.
tests/test_provider_hostile.py sends the same sessions lines that are not
valid requests, and tests/fuzz_providers.py runs both for as long as asked.
"""

from __future__ import annotations

from pathlib import Path
import unittest

from tests.provider_harness import UNKNOWN_OPERATIONS, Session, all_indices, node_available, run_session, scenarios


@unittest.skipUnless(node_available(), "node is not installed")
class ProviderSessionTests(unittest.TestCase):
    def test_random_sessions_keep_the_rfc_invariants(self) -> None:
        listed = scenarios()
        self.assertGreater(len(listed), 30)
        requests = 0
        for seed, (name, transcript) in enumerate(listed, 1):
            with self.subTest(scenario=f"{name}/{transcript.name}"):
                violation, session = run_session(name, transcript, seed, all_indices(), hostile=False)
                if violation:
                    raise violation
                requests += sum(1 for event in session.events if event.get("from") == "client" and "message" in event)
        self.assertGreater(requests, len(listed) * 5)

    def test_an_operation_no_version_knows_is_unsupported_not_served_as_a_read(self) -> None:
        """`constructor` is a name every JavaScript object has, so a provider that
        looks an operation up in a plain object finds a tier; `prototype` is not,
        and is here as one more operation nobody knows."""
        first = {}
        for name, transcript in scenarios():
            first.setdefault(name, transcript)
        providers = {path.parent.name for path in (Path(__file__).resolve().parents[1] / "examples" / "providers").glob("*/provider.js")}
        self.assertEqual(set(first), providers, "every reference provider is tried with the unknown operations")
        for name, transcript in first.items():
            session = Session(name, transcript, 1)
            try:
                registry = session.pool[0]["registry"]
                for operation in UNKNOWN_OPERATIONS:
                    for interactive in (True, False):
                        with self.subTest(provider=name, operation=operation, interactive=interactive):
                            answer = session.send({"v": 1, "kind": "get", "registry": registry, "operation": operation,
                                                   "command": "install", "interactive": interactive})
                            self.assertEqual(answer.get("Err", {}).get("kind"), "operation-not-supported", answer)
                    with self.subTest(provider=name, kind=operation):
                        answer = session.send({"v": 1, "kind": operation, "registry": registry})
                        self.assertEqual(answer.get("Err", {}).get("kind"), "operation-not-supported", answer)
                session.close()
            finally:
                session.kill()


if __name__ == "__main__":
    unittest.main()
