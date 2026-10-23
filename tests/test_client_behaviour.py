"""Behaviour of npm that only a client shows, as far as the Python model can:
which operation a command sends, what is logged and at which level, how often a
warning is said, what happens to a provider when npm exits. The rest of the
list is in phase-2-conformance.md, "What only an npm client can show"."""

from __future__ import annotations

import json
from pathlib import Path
import re
import unittest

from tests.protocol_model import (
    CommandRefused,
    CommandWarnings,
    ProviderListing,
    ProviderRestarts,
    STORED_CREDENTIAL_ENTRY,
    loggable,
    operation_for,
    resolve_chain,
)

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = "https://registry.example.test/"
DECLINE = "try-next-provider"


class OperationSelectionTests(unittest.TestCase):
    CASES = [
        ("install", None, "read"), ("ci", None, "read"), ("update", None, "read"), ("view", None, "read"),
        ("search", None, "read"), ("outdated", None, "read"),
        ("publish", None, "publish"), ("stage", "approve", "publish"),
        ("stage", "publish", "stage"),
        ("stage", "list", "stage-read"), ("stage", "view", "stage-read"), ("stage", "download", "stage-read"),
        ("deprecate", None, "deprecate"), ("undeprecate", None, "deprecate"),
        ("dist-tag", "add", "dist-tag"), ("dist-tag", "rm", "dist-tag"),
        ("unpublish", None, "unpublish"),
        ("owner", "add", "owner"), ("owner", "rm", "owner"),
        ("access", "list", "access"), ("team", "ls", "access"), ("org", "ls", "access"),
        ("trust", "github", "trust"), ("trust", "list", "trust"),
        ("stage", "reject", "stage-reject"),
        ("token", "list", "account"), ("token", "create", "account"), ("token", "revoke", "account"),
        ("profile", "get", "account"), ("profile", "set", "account"), ("profile", "disable-2fa", "account"),
        # a command that writes nothing and has no row
        ("whoami", None, "read"), ("owner", "ls", "read"), ("dist-tag", "ls", "read"),
    ]

    def test_every_command_sends_the_operation_of_its_row(self) -> None:
        for command, subcommand, operation in self.CASES:
            with self.subTest(command=command, subcommand=subcommand):
                self.assertEqual(operation_for(command, subcommand), operation)

    def test_the_spec_table_lists_each_command_in_the_row_of_its_operation(self) -> None:
        text = (ROOT / "phase-2-credential-provider.md").read_text(encoding="utf-8")
        rows = {}
        for line in text.splitlines():
            row = re.match(r"\| `([a-z-]+)` \| (.*?) \| (?:—|required|optional.*|[^|]*) \|$", line)
            if row and row.group(1) in {operation for *_, operation in self.CASES}:
                rows.setdefault(row.group(1), line)
        for command, subcommand, operation in self.CASES:
            if (command, subcommand) in {("whoami", None), ("owner", "ls"), ("dist-tag", "ls")} or operation == "read":
                continue
            if (command, subcommand) == ("profile", "disable-2fa"):
                self.assertIn("`disable-2fa` is not refused; it sends `account`", text)
                continue
            # the row names the command, and a subcommand where the rows differ by it
            # (`stage list`, `view`, `download` are one row: the later ones are bare words)
            with self.subTest(command=command, subcommand=subcommand):
                self.assertIn(command, rows[operation], f"the {operation} row does not name `{command}`")
                if subcommand and command in {"stage", "dist-tag", "owner", "profile"}:
                    self.assertIn(subcommand, rows[operation], f"the {operation} row does not name `{subcommand}`")

    def test_dry_run_turns_publish_unpublish_and_deprecate_into_reads(self) -> None:
        for command in ("publish", "unpublish", "deprecate"):
            with self.subTest(command=command):
                self.assertEqual(operation_for(command, dry_run=True), "read")

    def test_every_other_command_sends_its_operation_whatever_dry_run_says(self) -> None:
        for command, subcommand, operation in self.CASES:
            if command not in ("publish", "unpublish", "deprecate"):
                with self.subTest(command=command, subcommand=subcommand):
                    self.assertEqual(operation_for(command, subcommand, dry_run=True), operation)

    def test_enable_2fa_is_refused_under_a_provider_and_disable_2fa_is_not(self) -> None:
        with self.assertRaises(CommandRefused):
            operation_for("profile", "enable-2fa")
        self.assertEqual(operation_for("profile", "disable-2fa"), "account")

    def test_a_command_with_no_row_and_no_rule_is_unknown(self) -> None:
        with self.assertRaises(KeyError):
            operation_for("frobnicate")


class LoggingTests(unittest.TestCase):
    def test_the_login_token_is_never_logged(self) -> None:
        request = {"v": 1, "kind": "login", "registry": REGISTRY, "interactive": True, "token": "npm_pasted_secret"}

        logged = loggable(request)

        self.assertNotIn("token", logged)
        self.assertNotIn("npm_pasted_secret", json.dumps(logged))
        self.assertEqual(logged["registry"], REGISTRY)

    def test_a_request_without_a_token_is_logged_as_it_is(self) -> None:
        request = {"v": 1, "kind": "get", "registry": REGISTRY, "operation": "read", "interactive": False}
        self.assertEqual(loggable(request), request)

    def test_a_provider_without_registries_is_logged_at_verbose_and_the_fallback_at_warn(self) -> None:
        providers = [ProviderListing("listed", [REGISTRY]), ProviderListing("open", None)]

        outcome = resolve_chain([DECLINE, DECLINE], per_registry=False, stored_credential=True,
                                registry="https://other.example.test/", providers=providers)

        self.assertEqual(outcome.result, "stored-credential")
        self.assertEqual(len(outcome.verbose), 1)
        self.assertIn("open sent no registries", outcome.verbose[0])
        self.assertNotIn("listed", outcome.verbose[0])
        self.assertEqual(len(outcome.warnings), 1, "the fallback is a warning, not a verbose line")
        self.assertIn("open", outcome.warnings[0])
        self.assertNotIn("listed", outcome.warnings[0])

    def test_a_per_registry_list_logs_nothing_at_verbose_about_registries(self) -> None:
        outcome = resolve_chain([DECLINE], per_registry=True, stored_credential=False,
                                registry=REGISTRY, providers=[ProviderListing("open", None)])
        self.assertEqual(outcome.verbose, ())

    def test_a_chain_in_which_every_provider_lists_its_registries_logs_nothing(self) -> None:
        outcome = resolve_chain([DECLINE], per_registry=False, stored_credential=True, registry=REGISTRY,
                                providers=[ProviderListing("a", ["https://elsewhere.example.test/"])])
        self.assertEqual((outcome.verbose, outcome.warnings), ((), ()))

    def test_the_error_for_a_declined_form_names_the_remedy(self) -> None:
        outcome = resolve_chain([DECLINE], per_registry=False, stored_credential=True, registry="http://host.example/",
                                providers=[ProviderListing("p", ["https://host.example/"])])
        self.assertEqual(outcome.result, "fail")
        self.assertIn(f"per-registry list for it that holds just {STORED_CREDENTIAL_ENTRY}", outcome.message)


class WarningCountTests(unittest.TestCase):
    def fallback(self, registry: str):
        return resolve_chain([DECLINE], per_registry=False, stored_credential=True,
                             registry=registry, providers=[ProviderListing("p", None)])

    def test_the_fallback_is_said_once_per_registry_per_command(self) -> None:
        command = CommandWarnings()
        a, b = "https://a.example.test/", "https://b.example.test/"

        self.assertEqual(len(command.say(a, self.fallback(a))), 1)
        self.assertEqual(command.say(a, self.fallback(a)), [], "the second request to the same registry")
        self.assertEqual(len(command.say(b, self.fallback(b))), 1, "another registry is its own")
        self.assertEqual(len(command.lines), 2)

    def test_a_stored_credential_a_list_ignores_is_said_in_every_command(self) -> None:
        for _ in range(3):
            command = CommandWarnings()
            outcome = resolve_chain(["ok"], per_registry=True, stored_credential=True)
            self.assertEqual(len(command.say(REGISTRY, outcome)), 1, "a new command says it again")
            self.assertEqual(command.say(REGISTRY, outcome), [], "but not twice in one")

    def test_a_chain_with_nothing_to_warn_about_says_nothing(self) -> None:
        command = CommandWarnings()
        self.assertEqual(command.say(REGISTRY, resolve_chain(["ok"], per_registry=False, stored_credential=True)), [])


class NpmExitTests(unittest.TestCase):
    def test_a_provider_with_a_request_outstanding_is_killed(self) -> None:
        restarts = ProviderRestarts()
        restarts.start()
        self.assertEqual(restarts.npm_exits(outstanding=True), "kill")
        self.assertEqual(restarts.kills, 0, "an exit of npm is no failure of the provider")

    def test_an_idle_provider_gets_its_stdin_closed(self) -> None:
        restarts = ProviderRestarts()
        restarts.start()
        self.assertEqual(restarts.npm_exits(outstanding=False), "close-stdin")

    def test_no_session_is_nothing_to_end(self) -> None:
        self.assertEqual(ProviderRestarts().npm_exits(outstanding=False), "none")


if __name__ == "__main__":
    unittest.main()
