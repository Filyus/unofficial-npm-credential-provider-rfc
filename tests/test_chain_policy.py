from __future__ import annotations

import json
from pathlib import Path
import unittest

from tests.protocol_model import DeclinedRegistries, STORED_CREDENTIAL_ENTRY, resolve_chain


POLICY = json.loads((Path(__file__).resolve().parents[1] / "spec" / "policy-v1.json").read_text(encoding="utf-8"))
DECLINE = "try-next-provider"
NOT_FOUND = "try-next-provider-not-found"
TOKEN = STORED_CREDENTIAL_ENTRY


def outcomes(answers, *, per_registry, legacy_fallback=False):
    """The chain's result with and without a stored credential."""
    return {
        stored: resolve_chain(answers, per_registry=per_registry, stored_credential=stored, legacy_fallback=legacy_fallback)
        for stored in (True, False)
    }


class ChainPolicyTests(unittest.TestCase):
    """Every `fallback` key of the policy, checked against the model."""

    def assert_policy(self, key, results):
        value = POLICY["fallback"][key]
        with_stored, without = results[True], results[False]
        if value == "fail":
            self.assertEqual((with_stored.result, without.result), ("fail", "fail"), key)
        elif value.startswith("stored-credential-or-anonymous"):
            self.assertEqual((with_stored.result, without.result), ("stored-credential", "anonymous"), key)
            self.assertEqual(bool(with_stored.warnings), value.endswith("-with-warning"), key)
            self.assertEqual(without.warnings, (), key)
        else:
            self.fail(f"{key}: no check for {value!r}")

    def test_no_provider_configured(self):
        # no chain: what npm does today
        self.assert_policy("noProviderConfigured", outcomes([], per_registry=False))

    def test_global_chain_that_declines_the_registry(self):
        self.assert_policy("globalChainAllUrlNotSupported", outcomes([DECLINE, DECLINE], per_registry=False))

    def test_per_registry_list_that_declines_the_registry(self):
        self.assert_policy("registryChainAllUrlNotSupported", outcomes([DECLINE, DECLINE], per_registry=True))

    def test_per_registry_list_warns_about_a_stored_credential_it_ignores(self):
        self.assertEqual(POLICY["fallback"]["registryChainIgnoresStoredCredential"], "warn")
        for answers in (["ok"], [DECLINE], [NOT_FOUND]):
            with self.subTest(answers=answers):
                results = outcomes(answers, per_registry=True)
                self.assertTrue(results[True].warnings)
                self.assertEqual(results[False].warnings, ())
                self.assertNotEqual(results[True].result, "stored-credential")
        self.assertEqual(outcomes([DECLINE, TOKEN], per_registry=True)[True].warnings, ())

    def test_not_found_at_the_end(self):
        for per_registry in (False, True):
            for answers in ([NOT_FOUND], [DECLINE, NOT_FOUND, DECLINE]):
                with self.subTest(per_registry=per_registry, answers=answers):
                    self.assert_policy("notFoundAtEnd", outcomes(answers, per_registry=per_registry))
                    self.assert_policy(
                        "notFoundAtEndWithLegacyFallback",
                        outcomes(answers, per_registry=per_registry, legacy_fallback=True),
                    )

    def test_not_found_goes_on_to_the_next_provider(self):
        self.assertEqual(POLICY["chain"]["notFound"], "try-next-provider")
        result = resolve_chain([NOT_FOUND, "ok"], per_registry=False, stored_credential=True)
        self.assertEqual((result.result, result.entry), ("ok", 1))

    def test_no_common_version(self):
        for per_registry in (False, True):
            with self.subTest(per_registry=per_registry):
                self.assert_policy("noCommonVersion", outcomes(["no-common-version", "ok"], per_registry=per_registry))
                # with the opt-in it is a not-found: the chain goes on, and falls back at its end
                self.assertEqual(POLICY["fallback"]["noCommonVersionWithLegacyFallback"], "as-not-found")
                on = resolve_chain(["no-common-version", "ok"], per_registry=per_registry, stored_credential=True, legacy_fallback=True)
                self.assertEqual((on.result, on.entry), ("ok", 1))
                self.assert_policy(
                    "notFoundAtEndWithLegacyFallback",
                    outcomes(["no-common-version"], per_registry=per_registry, legacy_fallback=True),
                )

    def test_any_other_failure_stops_the_chain(self):
        for legacy_fallback, key in ((False, "otherFailure"), (True, "otherFailureWithLegacyFallback")):
            for per_registry in (False, True):
                with self.subTest(per_registry=per_registry, legacy_fallback=legacy_fallback):
                    results = outcomes([DECLINE, "fail", "ok"], per_registry=per_registry, legacy_fallback=legacy_fallback)
                    self.assert_policy(key, results)
                    self.assertEqual(results[True].entry, 1)

    def test_listed_npm_token_is_used_where_it_stands_without_a_warning(self):
        first = resolve_chain([TOKEN, "ok"], per_registry=False, stored_credential=True)
        self.assertEqual((first.result, first.entry, first.warnings), ("stored-credential", 0, ()))
        # listing it is the user's opt-in, so it serves after a not-found as well
        after = resolve_chain([NOT_FOUND, TOKEN], per_registry=True, stored_credential=True)
        self.assertEqual((after.result, after.entry), ("stored-credential", 1))
        # with nothing stored it declines, and the chain goes on
        empty = resolve_chain([TOKEN, "ok"], per_registry=False, stored_credential=False)
        self.assertEqual((empty.result, empty.entry), ("ok", 1))
        # a listed npm:token that has nothing leaves a declined global chain anonymous, without a warning
        self.assertEqual(resolve_chain([DECLINE, TOKEN], per_registry=False, stored_credential=False).result, "anonymous")
        self.assertEqual(resolve_chain([DECLINE, TOKEN], per_registry=False, stored_credential=True).warnings, ())

    def test_implicit_npm_token_is_not_consulted_after_a_not_found(self):
        self.assertEqual(
            POLICY["chain"]["implicitStoredCredentialEntry"],
            "end-of-global-chain-unless-a-provider-answered-not-found",
        )
        self.assertEqual(resolve_chain([NOT_FOUND], per_registry=False, stored_credential=True).result, "fail")

    def test_a_declined_registry_is_asked_once_per_provider(self):
        self.assertEqual(POLICY["chain"]["urlNotSupportedRemembered"], "per-provider-and-registry-for-the-command")
        memo = DeclinedRegistries()
        asked = []
        for _ in range(3):
            for provider in ("gitlab", "github"):
                if memo.should_ask(provider, "https://registry.npmjs.org/"):
                    asked.append(provider)
                    memo.record(provider, "https://registry.npmjs.org/", DECLINE if provider == "gitlab" else "ok")
        self.assertEqual(asked, ["gitlab", "github", "github", "github"])
        self.assertTrue(memo.should_ask("gitlab", "https://gitlab.example.com/"))


if __name__ == "__main__":
    unittest.main()
