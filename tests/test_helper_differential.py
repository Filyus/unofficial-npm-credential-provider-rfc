"""The harness that sets the Phase 1 prototype beside the Python model
(tests/fuzz_helper.py), on stand-ins for the prototype, and, if
NPM_REGISTRY_FETCH names a checkout with the prototype, on the prototype.

The prototype itself lives in a checkout of npm/npm-registry-fetch that the
`prototype` workflow builds from poc/patches; a path to it is not something
this repository carries, so that part is skipped without the variable.
"""

from __future__ import annotations

import os
from pathlib import Path
import random
import shutil
import tempfile
import unittest

from tests import fuzz_helper

HONEST = r"""
const { toHeader: real } = { toHeader: (helper, stdout) => {
  const token = stdout.trim()
  if (!token) throw new Error('printed an empty token')
  if (/[^\t\x20-\x7e]/.test(token)) throw new Error('not a valid header value')
  return /^[A-Za-z]+ /.test(token) ? token : `Bearer ${token}`
} }
module.exports = { toHeader: real, scrub: (text, stdout) => text.split(stdout.trim()).join('***'), mask: (line) => line }
"""


def prototype(source: str) -> Path:
    root = Path(tempfile.mkdtemp(prefix="prototype-"))
    (root / "lib").mkdir()
    (root / "lib" / "token-helper.js").write_text(source, encoding="utf-8")
    return root


@unittest.skipUnless(shutil.which("node"), "node is not installed")
class HarnessTests(unittest.TestCase):
    def found(self, source: str) -> set[str]:
        root = prototype(source)
        self.addCleanup(shutil.rmtree, root, True)
        cases = [fuzz_helper.Case(seed) for seed in range(1500)]
        return {finding["kind"] for finding in fuzz_helper.judge(root, cases)}

    def test_a_stand_in_that_does_what_the_model_does_and_hides_the_raw_token_has_one_kind_of_finding(self) -> None:
        # it hides the token only as it is: the forms a helper may echo it in leak
        self.assertEqual(self.found(HONEST), {"secret in the log"})

    def test_a_different_header_is_found(self) -> None:
        source = HONEST.replace("return /^[A-Za-z]+ /.test(token) ? token : `Bearer ${token}`", "return `Bearer ${token}`")
        self.assertIn("header", self.found(source))

    def test_a_refusal_that_quotes_the_output_is_found(self) -> None:
        source = HONEST.replace("throw new Error('not a valid header value')", "throw new Error('printed ' + token)")
        self.assertIn("refusal quotes the output", self.found(source))

    def test_a_prototype_that_takes_every_setting_is_found(self) -> None:
        root = prototype(HONEST.replace("module.exports = {", "module.exports = { refusal: () => null,"))
        self.addCleanup(shutil.rmtree, root, True)
        with tempfile.TemporaryDirectory() as scratch:
            existing = fuzz_helper.path_fixture(Path(scratch))
            values = fuzz_helper.path_cases(random.Random(1), existing, 1500)
            found = fuzz_helper.judge_paths(root, values)
        self.assertGreater(len(found), 10)
        self.assertEqual({finding["kind"] for finding in found}, {"setting"})

    def test_the_model_says_what_the_prototype_means_by_a_setting(self) -> None:
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
        source = HONEST.replace("mask: (line) => line", "mask: (line) => line + '\\x1b'")
        self.assertIn("control character in the log", self.found(source))


@unittest.skipUnless(os.environ.get("NPM_REGISTRY_FETCH") and shutil.which("node"),
                     "NPM_REGISTRY_FETCH names no checkout with the prototype")
class PrototypeTests(unittest.TestCase):
    def test_the_prototype_and_the_model_agree_and_nothing_leaks(self) -> None:
        cases = [fuzz_helper.Case(seed) for seed in range(4000)]
        found = fuzz_helper.judge(Path(os.environ["NPM_REGISTRY_FETCH"]), cases)
        report = "\n".join(f"{item['kind']} seed {item['case'].seed}: {item['case'].stdout[:80]!r}" for item in found[:5])
        self.assertEqual(found, [], report)


if __name__ == "__main__":
    unittest.main()
