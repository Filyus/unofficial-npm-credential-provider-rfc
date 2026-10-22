"""The harness that sets the Phase 1a prototype beside the Python model
(tests/fuzz_helper.py), on stand-ins for the runner, and, if NPM_CLI names a
checkout with the prototype, on the runner itself.

The runner lives in a checkout of npm/cli that the `prototype` workflow builds
from poc/patches; a path to it is not something this repository carries, so
that part is skipped without the variable.
"""

from __future__ import annotations

import os
from pathlib import Path
import random
import shutil
import tempfile
import unittest

from tests import fuzz_helper
from tests.tools_required import needs

HONEST = r"""
const path = require('node:path')
const fs = require('node:fs')
const spawn = require('@npmcli/promise-spawn')
const refusal = (helper) => {
  if (typeof helper !== 'string' || !path.isAbsolute(helper)) return 'must be an absolute path with no arguments'
  if (!/\s/.test(helper)) return null
  try { fs.statSync(helper); return null } catch (er) { if (er.code !== 'ENOENT' && er.code !== 'ENOTDIR') return null }
  for (const space of helper.matchAll(/\s/g)) {
    try { if (fs.statSync(helper.slice(0, space.index)).isFile()) return 'must be an absolute path with no arguments' } catch {}
  }
  return 'was not found'
}
module.exports = (config) => async (regKey) => {
  const helper = config.flat.tokenHelpers[regKey]
  const refused = refusal(helper)
  if (refused) throw new Error(`Token helper ${JSON.stringify(helper)} ${refused}`)
  const result = await spawn(helper, [], {})
  const token = result.stdout.trim()
  let header, failure
  if (!token) failure = 'printed an empty token'
  else if (/[^\t\x20-\x7e]/.test(token)) failure = 'not a valid header value'
  else header = /^[A-Za-z]+ /.test(token) ? token : `Bearer ${token}`
  let text = result.stderr
  for (const secret of [token, token.replace(/^[A-Za-z]+\s+/, '')].filter(Boolean)) text = text.split(secret).join('***')
  for (const line of text.split(/\r?\n/)) {
    const shown = line.replace(/[^\t\x20-\x7e\xa0-\uffff]/g, '')
    if (shown.trim()) process.emit('log', failure ? 'warn' : 'verbose', 'token-helper', shown)
  }
  if (failure) throw new Error(`Token helper ${JSON.stringify(helper)} ${failure}`)
  return header
}
"""


def prototype(source: str) -> Path:
    root = Path(tempfile.mkdtemp(prefix="prototype-"))
    (root / "lib" / "utils").mkdir(parents=True)
    (root / "lib" / "utils" / "token-helper.js").write_text(source, encoding="utf-8")
    return root


@needs(bool(shutil.which("node")), "node is not installed")
class HarnessTests(unittest.TestCase):
    def found(self, source: str) -> set[str]:
        root = prototype(source)
        self.addCleanup(shutil.rmtree, root, True)
        cases = [fuzz_helper.Case(seed) for seed in range(1500)]
        return {finding["kind"] for finding in fuzz_helper.judge(root, cases)}

    def test_a_stand_in_that_does_what_the_model_does_and_hides_the_exact_token_has_no_finding(self) -> None:
        self.assertEqual(self.found(HONEST), set())

    def test_a_stand_in_that_hides_nothing_is_found(self) -> None:
        source = HONEST.replace("text = text.split(secret).join('***')", "text = text")
        self.assertIn("secret in the log", self.found(source))

    def test_a_different_header_is_found(self) -> None:
        source = HONEST.replace("header = /^[A-Za-z]+ /.test(token) ? token : `Bearer ${token}`", "header = `Bearer ${token}`")
        self.assertIn("header", self.found(source))

    def test_a_refusal_that_quotes_the_output_is_found(self) -> None:
        source = HONEST.replace("failure = 'not a valid header value'", "failure = 'printed ' + token")
        self.assertIn("refusal quotes the output", self.found(source))

    def test_a_runner_that_takes_every_setting_is_found(self) -> None:
        root = prototype(HONEST.replace("const refused = refusal(helper)", "const refused = null"))
        self.addCleanup(shutil.rmtree, root, True)
        with tempfile.TemporaryDirectory() as scratch:
            existing = fuzz_helper.path_fixture(Path(scratch))
            values = fuzz_helper.path_cases(random.Random(1), existing, 1500)
            found = fuzz_helper.judge_paths(root, values)
        self.assertGreater(len(found), 10)
        self.assertEqual({finding["kind"] for finding in found}, {"setting"})

    def test_the_model_says_what_the_runner_means_by_a_setting(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            tool = Path(scratch) / "bin dir" / "tool"
            tool.parent.mkdir()
            tool.write_text("#!/bin/sh\n", encoding="utf-8")
            expected = {
                str(tool): "ok",  # a path with a space in it that is there
                f"{tool} --flag": "abs",  # arguments after a file that is there
                f"{tool.parent / 'nope'} x": "notfound",
                "tool": "abs",
                "./tool": "abs",
            }
            for value, verdict in expected.items():
                with self.subTest(value=value):
                    self.assertEqual(fuzz_helper.model_refusal(value), verdict)

    def test_a_log_that_keeps_a_control_character_is_found(self) -> None:
        source = HONEST.replace("const shown = line.replace(", "const shown = '\\x1b' + line.replace(")
        self.assertIn("control character in the log", self.found(source))


@unittest.skipUnless(os.environ.get("NPM_CLI") and shutil.which("node"),
                     "NPM_CLI names no checkout with the prototype")
class RunnerTests(unittest.TestCase):
    def test_the_runner_and_the_model_agree_and_nothing_leaks(self) -> None:
        cases = [fuzz_helper.Case(seed) for seed in range(4000)]
        found = fuzz_helper.judge(Path(os.environ["NPM_CLI"]), cases)
        report = "\n".join(f"{item['kind']} seed {item['case'].seed}: {item['case'].stdout[:80]!r}" for item in found[:5])
        self.assertEqual(found, [], report)


if __name__ == "__main__":
    unittest.main()
