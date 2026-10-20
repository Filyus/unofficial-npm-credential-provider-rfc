"""The harness that drives the reference providers (tests/provider_harness.py):
what it does when a provider misbehaves before the first request, with a node
script standing in for the scenario's helper and one for the provider."""

from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from tests import provider_harness as harness
from tests.tools_required import needs

ROOT = Path(__file__).resolve().parents[1]
TRANSCRIPT = ROOT / "examples" / "npmjs" / "install.jsonl"

# what examples/providers/scenario.js prints for --sessions: where the provider is, and what is secret
HELPER = """
const { readFileSync } = require('node:fs')
const setup = { provider: process.env.TEST_PROVIDER, cwd: process.cwd(), configFile: 'none', env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT }, askedFile: 'none', secrets: [] }
console.log(JSON.stringify(setup))
process.stdin.resume()
process.stdin.on('end', () => console.log(JSON.stringify({ secrets: [] })))
"""


@needs(harness.node_available(), "node is not installed")
class HarnessStartTests(unittest.TestCase):
    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.dir = Path(scratch.name)
        (self.dir / "helper.js").write_text(HELPER, encoding="utf-8")
        patcher = mock.patch.object(harness, "SCENARIO", self.dir / "helper.js")
        patcher.start()
        self.addCleanup(patcher.stop)

    def provider(self, source: str) -> None:
        (self.dir / "provider.js").write_text(source, encoding="utf-8")
        patcher = mock.patch.dict("os.environ", {"TEST_PROVIDER": str(self.dir / "provider.js")})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_provider_that_never_says_hello_is_a_violation_and_leaves_nothing_running(self) -> None:
        self.provider("setInterval(() => {}, 1000)")
        session = harness.Session("fake", TRANSCRIPT, 1, deadline=0.5, start=False)
        with self.assertRaises(harness.Violation) as caught:
            session.start()
        self.assertEqual(caught.exception.invariant, "in-time")
        self.assertIsNotNone(session.provider.poll(), "the provider is still running")
        self.assertIsNotNone(session.helper.poll(), "the helper is still running")

    def test_run_session_reports_it_with_the_session_and_does_not_raise(self) -> None:
        self.provider("setInterval(() => {}, 1000)")
        violation, session = harness.run_session("fake", TRANSCRIPT, 1, [], hostile=False, deadline=0.5)
        self.assertEqual(violation.invariant, "in-time")
        self.assertEqual(session.sent, [])
        self.assertIsNotNone(session.provider.poll())

    def test_a_hello_that_leaves_every_recorded_registry_out_gets_a_request_of_its_own(self) -> None:
        # `https://registry.npmjs.o` is a prefix of the transcript's registry, as a string and not as a path
        hello = {"v": [1], "registries": ["https://registry.npmjs.o"]}
        self.provider(f"console.log({json.dumps(json.dumps(hello))}); process.stdin.resume()")
        session = harness.Session("fake", TRANSCRIPT, 1, deadline=0.5)
        try:
            self.assertEqual([request["registry"] for request in session.pool], ["https://registry.npmjs.o"])
            self.assertEqual(session.fresh_get()["registry"], "https://registry.npmjs.o")
            self.assertTrue(session.model.serves(session.fresh_get()["registry"]))
        finally:
            session.kill()


if __name__ == "__main__":
    unittest.main()
