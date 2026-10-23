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
const setup = { provider: process.env.TEST_PROVIDER, cwd: process.cwd(), configFile: 'none', env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT }, askedFile: process.env.TEST_ASKED || 'none', secrets: [] }
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

    def ask_on_every_request(self, log: str) -> None:
        asked = self.dir / "asked.log"
        patcher = mock.patch.dict("os.environ", {"TEST_ASKED": str(asked)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.provider(
            "const fs = require('node:fs'); const readline = require('node:readline')\n"
            "console.log(JSON.stringify({ v: [1] }))\n"
            "readline.createInterface({ input: process.stdin }).on('line', () => {\n"
            f"  fs.appendFileSync({json.dumps(str(self.dir / log))}, 'asked\\n')\n"
            "  console.log(JSON.stringify({ Err: { kind: 'other', message: 'x' } }))\n"
            "})"
        )

    def test_a_read_that_asks_the_person_or_shows_a_sign_in_is_a_violation_whatever_interactive_says(self) -> None:
        read = {"v": 1, "kind": "get", "registry": "https://registry.npmjs.org/", "operation": "read", "command": "install"}
        for log in ("asked.log", "shown.log"):
            for interactive in (True, False):
                with self.subTest(log=log, interactive=interactive):
                    self.ask_on_every_request(log)
                    session = harness.Session("fake", TRANSCRIPT, 1, deadline=2)
                    try:
                        with self.assertRaises(harness.Violation) as caught:
                            session.send({**read, "interactive": interactive})
                        # a request that is not interactive is caught by the older rule first
                        expected = "no-prompt-unattended" if (log == "asked.log" and not interactive) else "read-starts-no-login"
                        self.assertEqual(caught.exception.invariant, expected)
                    finally:
                        session.kill()

    def test_a_write_may_ask_the_person_at_a_terminal(self) -> None:
        self.ask_on_every_request("asked.log")
        session = harness.Session("fake", TRANSCRIPT, 1, deadline=2)
        try:
            session.send({"v": 1, "kind": "get", "registry": "https://registry.npmjs.org/", "operation": "publish",
                          "version": "1.0.0", "command": "publish", "interactive": True})
        finally:
            session.kill()


if __name__ == "__main__":
    unittest.main()
