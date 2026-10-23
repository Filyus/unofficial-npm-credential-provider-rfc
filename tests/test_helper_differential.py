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
module.exports = (config) => async ({ regKey }) => {
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
    if (line.trim()) process.emit('log', failure ? 'warn' : 'verbose', 'token-helper', line)
  }
  if (failure) throw new Error(`Token helper ${JSON.stringify(helper)} ${failure}`)
  return header
}
"""


# the same stand-in with the route checks the runner makes before it starts anything
ROUTES = HONEST.replace(
    "module.exports = (config) => async ({ regKey }) => {",
    r"""module.exports = (config) => async ({ regKey, uri }) => {
  if (config.credentialKeysFromCliOrEnv(regKey).length) return undefined
  const { protocol, hostname } = uri ? new URL(uri) : {}
  if (protocol === 'http:' && !/^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(hostname)) throw new Error('was not run: its credential is not sent over plain http')
  if (config.tokenHelperProjectTransport.filter(({ key }) => protocol !== 'https:' || !/^(https-)?proxy$/.test(key)).length) throw new Error('was not run: its credential is not sent over a route that a project chose')""",
)
assert ROUTES != HONEST


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

    def found_routes(self, source: str) -> set[str]:
        root = prototype(source)
        self.addCleanup(shutil.rmtree, root, True)
        cases = fuzz_helper.route_cases(random.Random(1), 1500)
        return {finding["kind"] for finding in fuzz_helper.judge_routes(root, cases)}

    def test_a_stand_in_that_refuses_what_the_model_refuses_has_no_route_finding(self) -> None:
        self.assertEqual(self.found_routes(ROUTES), set())

    def test_a_runner_that_sends_over_any_http_is_found(self) -> None:
        self.assertEqual(self.found_routes(ROUTES.replace("protocol === 'http:' &&", "false &&")), {"route"})

    def test_a_runner_that_calls_a_longer_host_loopback_is_found(self) -> None:
        self.assertEqual(self.found_routes(ROUTES.replace("^(localhost|", "^(localhost\\.?|")), {"route"})

    def test_a_runner_that_ignores_the_route_a_project_chose_is_found(self) -> None:
        self.assertEqual(self.found_routes(ROUTES.replace("config.tokenHelperProjectTransport.filter", "[].filter")), {"route"})

    def test_a_runner_that_refuses_a_project_proxy_over_https_is_found(self) -> None:
        self.assertEqual(self.found_routes(ROUTES.replace("protocol !== 'https:' || !/^(https-)?proxy$/.test(key)", "true")), {"route"})

    def test_a_runner_that_lets_a_project_proxy_through_over_http_is_found(self) -> None:
        self.assertEqual(self.found_routes(ROUTES.replace("protocol !== 'https:' ||", "false &&")), {"route"})

    def test_a_runner_that_runs_the_helper_beside_a_credential_for_the_run_is_found(self) -> None:
        self.assertEqual(self.found_routes(ROUTES.replace("config.credentialKeysFromCliOrEnv(regKey).length", "false")), {"route"})

    def test_a_runner_with_no_route_checks_at_all_is_found(self) -> None:
        # the stand-in that has the checks of the header and the log only: the bridge gives it a config with the route answers
        self.assertEqual(self.found_routes(HONEST), {"route"})


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
