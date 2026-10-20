from __future__ import annotations

import json
from pathlib import Path
import unittest

from tests.protocol_model import registry_matches


# shared with the Rust crate, whose `Hello::serves` is tested on the same file
CASES_PATH = Path(__file__).with_name("registry_matching_cases.json")


class RegistryMatchingTests(unittest.TestCase):
    """The comparison of Registry matching, for `//host/path/` keys (no
    scheme) and hello `registries` entries (scheme compared)."""

    def test_cases(self) -> None:
        listed = json.loads(CASES_PATH.read_text(encoding="utf-8"))
        for served, url, expected in listed["cases"] + listed["pythonOnly"]:
            with self.subTest(served=served, url=url):
                self.assertEqual(registry_matches(served, url), expected)


if __name__ == "__main__":
    unittest.main()
