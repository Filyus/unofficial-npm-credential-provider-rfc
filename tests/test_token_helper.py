from __future__ import annotations

import unittest

from tests.protocol_model import (
    ResolutionFailure,
    TokenHelperFailure,
    check_token_helper_config,
    token_helper_header,
)


class TokenHelperOutputTests(unittest.TestCase):
    """Phase 1 reads a `tokenHelper`'s stdout as the Phase 1 table says (pnpm trims the end only, npm trims the start too), so one
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

    def test_whitespace_around_the_output_is_trimmed(self) -> None:
        self.assertEqual(token_helper_header(0, "  \t abc123 \r\n"), "Bearer abc123")
        self.assertEqual(token_helper_header(0, "  Bearer abc123  "), "Bearer abc123")

    def test_leading_bom_is_trimmed_as_javascript_does(self) -> None:
        # Windows PowerShell 5.1 puts one in front of UTF-8 output
        self.assertEqual(token_helper_header(0, "\ufeffabc123\r\n"), "Bearer abc123")
        with self.assertRaises(TokenHelperFailure):
            token_helper_header(0, "\ufeff\n")

    def test_header_padding_and_jwt_pass(self) -> None:
        for output in ("dXNlcjpwYXNz==", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln-_x"):
            with self.subTest(output=output):
                self.assertEqual(token_helper_header(0, output + "\n"), f"Bearer {output}")

    def test_output_that_is_not_a_header_value_is_refused_without_quoting_it(self) -> None:
        for secret in ("hunter2", "s3cr\u00e9t", "\u0442\u043e\u043a\u0435\u043d"):
            for output in (f"{secret}\nline2", f"{secret}\x7f", f"{secret}\x00", f"x{secret}" if not secret.isascii() else f"{secret}\u00f6"):
                with self.subTest(output=output):
                    with self.assertRaises(TokenHelperFailure) as raised:
                        token_helper_header(0, output)
                    self.assertNotIn(secret, str(raised.exception))

    def test_tab_inside_the_output_is_allowed(self) -> None:
        self.assertEqual(token_helper_header(0, "ab\tcd"), "Bearer ab\tcd")

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

    def test_relative_paths_and_arguments_are_rejected_as_arguments(self) -> None:
        import os
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".sh", delete=False) as helper:
            pass
        try:
            # a file that exists, followed by arguments: refused for the arguments, not for being missing
            values = ["codeartifact-token", "./token.sh", f"{helper.name} codeartifact get-authorization-token"]
            for value in values:
                with self.subTest(value=value):
                    with self.assertRaisesRegex(ResolutionFailure, "arguments are not supported"):
                        check_token_helper_config(value, "user")
            check_token_helper_config(helper.name, "user")
        finally:
            os.unlink(helper.name)

    def test_windows_absolute_paths_are_accepted(self) -> None:
        for value in ("C:\\tools\\token.cmd", "C:/tools/token.cmd", "\\\\server\\share\\token.cmd"):
            with self.subTest(value=value):
                check_token_helper_config(value, "user")


class TokenHelperSpacedPathTests(unittest.TestCase):
    """A path with whitespace in it is told apart from a command with arguments
    by the filesystem, modelled here by injected predicates."""

    FILES = {"/opt/my tools/token.sh", "/usr/bin/aws"}

    def check(self, value: str) -> None:
        check_token_helper_config(
            value, "user", exists=lambda path: path in self.FILES, is_file=lambda path: path in self.FILES
        )

    def test_spaced_path_that_exists_as_given_is_accepted(self) -> None:
        self.check("/opt/my tools/token.sh")

    def test_path_with_arguments_is_refused_as_arguments(self) -> None:
        for value in ("/usr/bin/aws codeartifact get-authorization-token", "/opt/my tools/token.sh --flag"):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ResolutionFailure, "arguments are not supported"):
                    self.check(value)

    def test_missing_spaced_path_is_refused_as_not_found(self) -> None:
        with self.assertRaisesRegex(ResolutionFailure, "was not found"):
            self.check("/opt/other tools/token.sh")

    def test_relative_path_is_refused_as_arguments_not_supported(self) -> None:
        with self.assertRaisesRegex(ResolutionFailure, "arguments are not supported"):
            self.check("token.sh")


if __name__ == "__main__":
    unittest.main()
