from __future__ import annotations

import unittest

from tests.protocol_model import registry_matches


class RegistryMatchingTests(unittest.TestCase):
    """The comparison of Registry matching, for `//host/path/` keys (no
    scheme) and hello `registries` entries (scheme compared)."""

    CASES = [
        # served, url, matches
        ("//gitlab.example.com/api/v4/packages/npm/", "https://gitlab.example.com/api/v4/packages/npm/@s%2fp", True),
        ("//gitlab.example.com/api/v4/packages/npm", "https://gitlab.example.com/api/v4/packages/npm/@s%2fp", True),
        ("//gitlab.example.com/api/v4/packages/npm/", "https://gitlab.example.com/api/v4/packages/npm", True),
        ("//gitlab.example.com/npm/", "https://gitlab.example.com/npmx/p", False),
        ("//gitlab.example.com/npm", "https://gitlab.example.com/npmx/p", False),
        ("//gitlab.example.com/", "https://GITLAB.Example.com/p", True),
        ("//gitlab.example.com/", "https://gitlab.example.com:443/p", True),
        ("//gitlab.example.com/", "https://gitlab.example.com:8443/p", False),
        ("//gitlab.example.com:8443/", "https://gitlab.example.com:8443/p", True),
        ("//gitlab.example.com/api/", "https://gitlab.example.com/API/p", False),
        ("//gitlab.example.com/a%2Fb/", "https://gitlab.example.com/a/b/p", False),
        ("//gitlab.example.com/npm/", "https://gitlab.example.com/x/../npm/p", True),
        ("//gitlab.example.com/", "http://gitlab.example.com/p", True),
        ("https://gitlab.example.com/", "http://gitlab.example.com/p", False),
        ("https://gitlab.example.com/", "https://gitlab.example.com/p", True),
        ("http://gitlab.example.com:80/", "http://gitlab.example.com/p", True),
        ("https://xn--bcher-kva.example/", "https://bücher.example/p", True),
        ("https://gitlab.example.com/", "https://gitlab.example.com.evil.test/p", False),
        ("https://gitlab.example.com/", "https://evil.test/gitlab.example.com/p", False),
        # an empty segment is part of the path: npm's key walk never yields `//host//`
        ("//gitlab.example.com//", "https://gitlab.example.com/@s%2fp", False),
        ("//gitlab.example.com//", "https://gitlab.example.com//@s%2fp", True),
        ("https://gitlab.example.com//", "https://gitlab.example.com/", False),
    ]

    def test_cases(self) -> None:
        for served, url, expected in self.CASES:
            with self.subTest(served=served, url=url):
                self.assertEqual(registry_matches(served, url), expected)


if __name__ == "__main__":
    unittest.main()
