from __future__ import annotations

import unittest

from tests.protocol_model import (
    ResolutionFailure,
    TokenHelperFailure,
    check_token_helper_config,
    token_helper_header,
)


class TokenHelperOutputTests(unittest.TestCase):
    """Phase 1 reads a `tokenHelper`'s stdout exactly as pnpm does, so one
    helper serves both package managers."""

    def test_raw_token_is_sent_as_bearer(self) -> None:
        self.assertEqual(token_helper_header(0, "abc123\n"), "Bearer abc123")

    def test_output_with_a_scheme_is_used_as_the_header_value(self) -> None:
        for output in ("Bearer abc123", "Basic dXNlcjpwYXNz", "Token abc"):
            with self.subTest(output=output):
                self.assertEqual(token_helper_header(0, output + "\r\n"), output)

    def test_token_with_inner_symbols_is_not_mistaken_for_a_scheme(self) -> None:
        self.assertEqual(token_helper_header(0, "npm_x-y z"), "Bearer npm_x-y z")

    def test_empty_output_fails(self) -> None:
        for output in ("", "\n", "  \r\n"):
            with self.subTest(output=output):
                with self.assertRaises(TokenHelperFailure):
                    token_helper_header(0, output)

    def test_non_zero_exit_fails_even_with_output(self) -> None:
        with self.assertRaises(TokenHelperFailure):
            token_helper_header(1, "abc123")


class TokenHelperConfigTests(unittest.TestCase):
    def test_user_and_global_config_may_set_an_absolute_helper(self) -> None:
        for source in ("user", "global"):
            check_token_helper_config("/usr/local/bin/codeartifact-token", source)

    def test_project_and_workspace_config_may_not(self) -> None:
        for source in ("project", "workspace"):
            with self.assertRaises(ResolutionFailure):
                check_token_helper_config("/usr/local/bin/codeartifact-token", source)

    def test_relative_paths_and_arguments_are_rejected(self) -> None:
        for value in ("codeartifact-token", "./token.sh", "/usr/bin/aws codeartifact get-authorization-token"):
            with self.subTest(value=value):
                with self.assertRaises(ResolutionFailure):
                    check_token_helper_config(value, "user")


if __name__ == "__main__":
    unittest.main()
