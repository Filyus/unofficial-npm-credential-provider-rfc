from __future__ import annotations

import unittest

from tests.protocol_model import (
    ResolutionFailure,
    TokenHelperFailure,
    check_token_helper_config,
    containing_project,
    credential_in_use,
    token_helper_header,
    token_helper_route_outcome,
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


class TokenHelperRouteTests(unittest.TestCase):
    """A helper's credential is held to a stricter rule than a stored token's on its route, and the
    checks come before the program is started: Phase 1a "Which requests get the credential"."""

    def test_plain_http_to_a_host_that_is_not_this_machine_is_refused(self) -> None:
        # as a parsed URL reads the host: `127.1` is already `127.0.0.1` there, and the mapped IPv6 form is not `[::1]`
        for hostname in ("registry.corp.example", "10.0.0.1", "localhost.", "0.0.0.0", "127.0.0.1.example.com", "[::ffff:7f00:1]", "localhost.example.com"):
            with self.subTest(hostname=hostname):
                self.assertEqual(token_helper_route_outcome("http:", hostname), "plain-http")

    def test_loopback_is_allowed_over_http(self) -> None:
        for hostname in ("localhost", "127.0.0.1", "127.255.255.254", "[::1]"):
            with self.subTest(hostname=hostname):
                self.assertEqual(token_helper_route_outcome("http:", hostname), "ran")

    def test_https_is_not_refused_for_its_host(self) -> None:
        self.assertEqual(token_helper_route_outcome("https:", "registry.corp.example"), "ran")

    def test_a_route_a_project_chose_is_refused_and_the_same_from_the_user_is_not(self) -> None:
        for key in ("ca", "cafile", "strict-ssl"):
            with self.subTest(key=key):
                self.assertEqual(token_helper_route_outcome("https:", "registry.corp.example", project_route_keys=(key,)), "project-route")
        self.assertEqual(token_helper_route_outcome("https:", "registry.corp.example", project_route_keys=()), "ran")

    def test_a_project_proxy_refuses_an_http_request_not_an_https_one(self) -> None:
        # over https a proxy sees a CONNECT tunnel, and the credential travels inside it
        for key in ("proxy", "https-proxy"):
            with self.subTest(key=key):
                self.assertEqual(token_helper_route_outcome("http:", "localhost", project_route_keys=(key,)), "project-route")
                self.assertEqual(token_helper_route_outcome("https:", "registry.corp.example", project_route_keys=(key,)), "ran")
        # a CA beside the proxy still refuses the https request
        self.assertEqual(token_helper_route_outcome("https:", "registry.corp.example", project_route_keys=("https-proxy", "ca")), "project-route")

    def test_the_http_refusal_comes_before_the_route_refusal(self) -> None:
        self.assertEqual(token_helper_route_outcome("http:", "10.0.0.1", project_route_keys=("proxy",)), "plain-http")

    def test_a_credential_given_for_the_run_is_used_whatever_the_route(self) -> None:
        for scheme, hostname, keys in (("https:", "registry.corp.example", ()), ("http:", "10.0.0.1", ("proxy",))):
            with self.subTest(scheme=scheme):
                self.assertEqual(token_helper_route_outcome(scheme, hostname, run_credential=True, project_route_keys=keys), "run-credential")


class CredentialPrecedenceTests(unittest.TestCase):
    """Phase 1a "Precedence and commands": what a request for one registry key carries."""

    def test_a_credential_from_the_command_line_or_the_environment_beats_the_helper(self) -> None:
        self.assertEqual(credential_in_use(helper=True, file_credential=True, run_credential=True), "run")
        self.assertEqual(credential_in_use(helper=True, file_credential=False, run_credential=True), "run")

    def test_the_helper_beats_a_credential_in_a_file(self) -> None:
        self.assertEqual(credential_in_use(helper=True, file_credential=True, run_credential=False), "helper")

    def test_a_file_credential_is_used_where_there_is_no_helper(self) -> None:
        self.assertEqual(credential_in_use(helper=False, file_credential=True, run_credential=False), "file")
        self.assertIsNone(credential_in_use(helper=False, file_credential=False, run_credential=False))


class ContainingProjectTests(unittest.TestCase):
    """The location rule for a user or global file that the command line or the environment chose."""

    HOME = "/home/user"

    def project(self, directories: list[str], marks: set[tuple[str, str]], home: str | None = HOME):
        return containing_project(directories, home, lambda directory, marker: (directory, marker) in marks)

    def test_a_package_json_in_the_directory_of_the_file(self) -> None:
        self.assertEqual(self.project(["/work/repo", "/work", "/"], {("/work/repo", "package.json")}), ("/work/repo", "package.json"))

    def test_a_git_root_with_no_package_json_counts_from_below(self) -> None:
        # the file at the root of a repository whose packages are below it
        self.assertEqual(self.project(["/work/repo", "/work", "/"], {("/work/repo", ".git")}), ("/work/repo", ".git"))

    def test_a_directory_above_the_file_counts(self) -> None:
        self.assertEqual(self.project(["/work/repo/ci", "/work/repo", "/work", "/"], {("/work/repo", "package.json")}), ("/work/repo", "package.json"))

    def test_the_nearest_mark_is_the_one_named(self) -> None:
        marks = {("/work/repo/pkg", "package.json"), ("/work/repo", ".git")}
        self.assertEqual(self.project(["/work/repo/pkg", "/work/repo", "/work", "/"], marks), ("/work/repo/pkg", "package.json"))

    def test_node_modules_is_no_mark(self) -> None:
        self.assertIsNone(self.project(["/usr/local", "/usr", "/"], {("/usr/local", "node_modules")}))

    def test_a_file_in_a_directory_with_no_mark_below_home_is_the_users(self) -> None:
        self.assertIsNone(self.project(["/home/user/cfg", "/home/user", "/home", "/"], {("/home", "package.json")}))

    def test_home_is_never_looked_at(self) -> None:
        marks = {("/home/user", "package.json"), ("/home/user", ".git")}
        self.assertIsNone(self.project(["/home/user", "/home", "/"], marks))
        self.assertIsNone(self.project(["/home/user/.config/npm", "/home/user/.config", "/home/user", "/home", "/"], marks))

    def test_a_git_directory_below_home_is_refused(self) -> None:
        # a dotfiles repository in ~/.config: the false refusal the limits name
        self.assertEqual(
            self.project(["/home/user/.config/npm", "/home/user/.config", "/home/user", "/"], {("/home/user/.config", ".git")}),
            ("/home/user/.config", ".git"),
        )

    def test_a_file_outside_home_is_walked_to_the_root(self) -> None:
        self.assertEqual(self.project(["/srv/ci", "/srv", "/"], {("/", "package.json")}), ("/", "package.json"))
        self.assertIsNone(self.project(["/srv/ci", "/srv", "/"], set()))

    def test_a_home_that_is_a_root_or_is_not_there_stops_nothing(self) -> None:
        marks = {("/top", "package.json")}
        self.assertEqual(self.project(["/top/sub", "/top", "/"], marks, home=None), ("/top", "package.json"))


if __name__ == "__main__":
    unittest.main()
