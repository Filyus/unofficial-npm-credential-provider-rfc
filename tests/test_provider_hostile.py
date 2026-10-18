"""Lines that are not valid requests, sent to the reference providers.

The same seeded sessions as tests/test_provider_sessions.py, with about a
third of the steps replaced by a hostile line: a valid request with a field
dropped, retyped or added, one mangled byte by byte, text that is not an
object, a request nested 200 000 deep, a line near the 1 MiB floor that must
still be served, a line of megabytes that must be rejected whole, a kind or
operation called `constructor`, a key called `__proto__`, bytes that are not
UTF-8. What Phase 2 requires, and the harness checks, is that every such line
is answered with exactly one line, an error for a line that is not a valid
request and never `Ok`, that a valid one is served, and that the session goes
on and ends cleanly.

Needs `node`; a few seconds. tests/fuzz_providers.py runs it for as long as
asked, with seeds of its own.
"""

from __future__ import annotations

import unittest

from tests.provider_harness import all_indices, node_available, run_session, scenarios


@unittest.skipUnless(node_available(), "node is not installed")
class HostileInputTests(unittest.TestCase):
    def test_hostile_lines_get_an_error_and_the_session_goes_on(self) -> None:
        listed = scenarios()
        for seed, (name, transcript) in enumerate(listed, 1000):
            with self.subTest(scenario=f"{name}/{transcript.name}"):
                violation, _ = run_session(name, transcript, seed, all_indices(), hostile=True, deadline=15)
                if violation:
                    raise violation


if __name__ == "__main__":
    unittest.main()
