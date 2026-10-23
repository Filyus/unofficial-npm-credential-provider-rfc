from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from tests.generated_policy import LINE_SIZE_MINIMUM, SENTINEL_ARGUMENT, FAILED_SESSIONS_BEFORE_NO_RESTART
from tests.protocol_model import (
    CacheKey,
    CredentialClientModel,
    DeclinedRegistries,
    ProtocolViolation,
    ProviderListing,
    ProviderRestarts,
    RequestContext,
    rejection_action,
    resolve_chain,
    validate_transcript,
)

REGISTRY = "https://registry.example.test/"
POLICY = json.loads((Path(__file__).resolve().parents[1] / "spec" / "policy-v1.json").read_text(encoding="utf-8"))
TRANSCRIPTS = Path(__file__).resolve().parent / "transcripts"


def client(capabilities=(), **hello):
    model = CredentialClientModel()
    model.receive_hello({"v": [1], "capabilities": list(capabilities), **hello})
    return model


def get(model, operation="read", scope="@scope", package="pkg", version=None, registry=REGISTRY, **ok):
    context = RequestContext(registry=registry, operation=operation, scope=scope, package=package, version=version,
                             command="publish" if operation != "read" else "install")
    request = model.build_request(context)
    model.handle_response(request, {"Ok": {"kind": "get", "auth": {"type": "bearer", "token": ok.pop("token", "t")}, **ok}})
    return context, model.last_issuance


class CacheBindingTests(unittest.TestCase):
    """Any operation but read is cached bound to its operation and package."""

    def test_a_workspace_publish_asks_once_per_package(self):
        model = client()
        get(model, "publish", package="a", version="1.0.0", token="a-token", granularity="registry")
        self.assertIsNotNone(model.lookup(REGISTRY, "@scope", "a", "publish"))
        self.assertIsNone(model.lookup(REGISTRY, "@scope", "b", "publish"), "package b needs a get of its own")
        self.assertIsNone(model.lookup(REGISTRY, "@scope", "a", "dist-tag"), "nor does another operation reuse it")
        self.assertEqual(POLICY["cache"]["operationBoundExcept"], ["read"])

    def test_read_keeps_registry_wide_reuse(self):
        model = client()
        get(model, "read", granularity="registry")
        self.assertIsNotNone(model.lookup(REGISTRY, "@other", "x", "read"))

    def test_a_write_command_reuses_within_its_package(self):
        # owner add reads the packument and writes it under the one operation
        model = client()
        get(model, "owner", granularity="registry")
        self.assertIsNotNone(model.lookup(REGISTRY, "@scope", "pkg", "owner"))

    def test_the_scheme_is_part_of_the_key(self):
        model = client()
        get(model, "read", granularity="registry", registry="https://registry.example.test/")
        self.assertIsNone(model.lookup("http://registry.example.test/", "@scope", "pkg", "read"))
        self.assertTrue(POLICY["cache"]["schemeInKey"])

    def test_the_policy_decides_whether_the_scheme_is_part_of_the_key(self):
        # the model reads `cache.schemeInKey`: without it the two forms share an entry
        from tests import protocol_model

        with mock.patch.object(protocol_model, "SCHEME_IN_CACHE_KEY", False):
            model = client()
            get(model, "read", granularity="registry", registry="https://registry.example.test/")
            self.assertIsNotNone(model.lookup("http://registry.example.test/", "@scope", "pkg", "read"))

    def test_queued_misses_find_the_scope_answer_ahead_of_them(self):
        model = client()
        get(model, "read", package="first", granularity="scope")
        for package in ("second", "third"):
            self.assertIsNotNone(model.lookup(REGISTRY, "@scope", package, "read"), package)

    def test_a_field_the_request_did_not_carry_is_part_of_the_key(self):
        model = client()
        get(model, "read", package=None, granularity="package")
        self.assertIsNone(model.lookup(REGISTRY, "@scope", "pkg", "read"))
        self.assertIsNotNone(model.lookup(REGISTRY, "@scope", None, "read"))


class RejectionTests(unittest.TestCase):
    def test_a_stale_401_erases_nothing_new(self):
        model = client()
        context, first = get(model, token="A", granularity="scope")
        erase = model.reject_credential(context, issuance=first)
        self.assertIsNotNone(erase)
        _, second = get(model, token="B", granularity="scope")
        self.assertIsNone(model.reject_credential(context, issuance=first), "the second request carried A too")
        self.assertEqual(model.lookup(REGISTRY, "@scope", "pkg").auth["token"], "B")
        self.assertNotIn(second, model.retired)

    def test_the_retry_names_the_context_the_status_and_the_challenges(self):
        model = client()
        context, _ = get(model, token="A")
        for status in (401, 403):
            retry = model.retry_request(context, status, ['Bearer realm="r"'])
            self.assertEqual((retry["kind"], retry["retry"], retry["httpStatus"]), ("get", True, status))
            self.assertEqual((retry["registry"], retry["scope"], retry["package"]), (REGISTRY, "@scope", "pkg"))
            self.assertEqual(retry["authChallenges"], ['Bearer realm="r"'])
        self.assertNotIn("authChallenges", model.retry_request(context, 401))

    def test_a_stale_rejection_on_a_cache_miss_sends_the_retry_get_not_a_plain_one(self):
        """A 401 on an answer already erased, with nothing in the cache to send
        again: the `get` that follows is the request's one retry, so it carries
        `retry: true` and the status, and the provider is not asked as if for the
        first time (it could hand out the token it has just been told was refused)."""
        model = client()
        context, first = get(model, token="A", cache="never")
        model.reject_credential(context, issuance=first)
        self.assertIsNone(model.lookup(REGISTRY, "@scope", "pkg"), "a miss")

        for status in (401, 403):
            request = model.request_after_stale(context, status, first, auth_challenges=["Basic"])
            self.assertEqual((request["retry"], request["httpStatus"]), (True, status))
            self.assertEqual(request["authChallenges"], ["Basic"])

    def test_a_stale_rejection_on_a_cache_hit_sends_no_request_to_the_provider(self):
        model = client()
        context, first = get(model, token="A", granularity="scope")
        model.reject_credential(context, issuance=first)
        get(model, token="B", granularity="scope")

        self.assertIsNone(model.request_after_stale(context, 401, first), "the request goes again with B")

    def test_a_rejection_that_is_not_stale_has_no_stale_path(self):
        model = client()
        context, first = get(model, token="A")
        with self.assertRaises(ProtocolViolation):
            model.request_after_stale(context, 401, first)

    def test_erasing_a_publish_credential_carries_its_version(self):
        model = client()
        context, issuance = get(model, "publish", version="2.0.0", granularity="package", operationIndependent=False)
        erase = model.reject_credential(context, issuance=issuance)
        self.assertEqual((erase["operation"], erase["version"], erase["granularity"]), ("publish", "2.0.0", "package"))

    def test_a_second_401_on_the_retried_credential_erases_without_retrying(self):
        self.assertEqual(rejection_action(401, retried=True), (True, False, "rejected"))
        model = client()
        context, first = get(model, token="A")
        model.reject_credential(context, issuance=first)
        _, retried = get(model, token="B")
        self.assertIsNotNone(model.reject_credential(context, issuance=retried))
        self.assertIsNone(model.lookup(REGISTRY, "@scope", "pkg"))

    def test_a_403_retry_answer_replaces_the_refused_credential(self):
        model = client()
        _, refused = get(model, token="narrow", granularity="scope")
        self.assertTrue(model.refused_by_403(refused))
        get(model, token="wider", granularity="registry")
        model.replace_after_403(refused)
        self.assertEqual(model.lookup(REGISTRY, "@scope", "pkg").auth["token"], "wider")
        self.assertFalse(model.refused_by_403(refused), "a stale 403 sends no second retry")

    def test_the_rejection_table(self):
        cases = [
            ((401,), (True, True, "rejected")),
            ((401, "otp"), (False, False, "otp-prompt")),
            ((401, "ipaddress, otp"), (False, False, "eauthip")),
            ((403,), (False, True, "forbidden")),
            ((403, None, None, True), (False, False, "forbidden")),
        ]
        for args, expected in cases:
            with self.subTest(args=args):
                self.assertEqual(rejection_action(*args), expected)
        self.assertEqual(POLICY["rejection"]["retriesPerRequest"], 1)

    def test_a_403_retry_transcript_follows_no_erase(self):
        model = validate_transcript(str(TRANSCRIPTS / "retry-after-403.jsonl"))
        self.assertEqual(model.state.value, "closed")
        lines = (TRANSCRIPTS / "retry-after-403.jsonl").read_text(encoding="utf-8").splitlines()
        erase = '{"from":"client","message":{"v":1,"kind":"erase","registry":"https://registry.example.test/","scope":"@scope","package":"pkg","operation":"read","granularity":"scope"}}'
        reply = '{"from":"provider","message":{"Ok":{"kind":"erase"}}}'
        with tempfile.TemporaryDirectory() as tmp:
            broken = Path(tmp) / "erase-before-403.jsonl"
            broken.write_text("\n".join(lines[:3] + [erase, reply] + lines[3:]) + "\n", encoding="utf-8")
            with self.assertRaises(ProtocolViolation):
                validate_transcript(str(broken))
            twice = Path(tmp) / "two-retries.jsonl"
            twice.write_text("\n".join(lines[:5] + lines[3:5] + lines[5:]) + "\n", encoding="utf-8")
            with self.assertRaises(ProtocolViolation):
                validate_transcript(str(twice))


class HelloRegistriesTests(unittest.TestCase):
    def test_a_registry_outside_the_list_is_declined_without_a_message(self):
        model = client(registries=["https://gitlab.example.com/"])
        declined = DeclinedRegistries()
        outside = model.request_or_decline(RequestContext(registry="https://registry.npmjs.org/"), declined, "gitlab")
        self.assertEqual(outside, "try-next-provider")
        self.assertFalse(declined.should_ask("gitlab", "https://registry.npmjs.org/"))
        inside = model.request_or_decline(RequestContext(registry="https://gitlab.example.com/api/v4/"))
        self.assertEqual(inside["registry"], "https://gitlab.example.com/api/v4/")
        self.assertEqual(model.request_or_decline(RequestContext(registry="http://gitlab.example.com/")), "try-next-provider")

    def test_an_empty_list_declines_everything_and_no_list_asks_only_in_a_per_registry_list(self):
        self.assertEqual(client(registries=[]).request_or_decline(RequestContext(registry=REGISTRY)), "try-next-provider")
        self.assertIsInstance(client().request_or_decline(RequestContext(registry=REGISTRY)), dict)
        # a provider in the global chain that sent no list serves no registry
        self.assertEqual(client().request_or_decline(RequestContext(registry=REGISTRY), global_chain=True),
                         "try-next-provider")
        self.assertIsInstance(
            client(registries=[REGISTRY]).request_or_decline(RequestContext(registry=REGISTRY), global_chain=True), dict)

    def test_the_policy_says_a_global_provider_without_a_list_serves_none(self):
        self.assertEqual(POLICY["chain"]["globalChainProviderWithoutRegistries"], "serves-no-registry-and-warns")
        self.assertNotIn("globalChainWarningLimitedToListedHostsWhenEveryProviderListsRegistries", POLICY["fallback"])
        self.assertEqual(POLICY["fallback"]["globalChainAllUrlNotSupportedOnListedHost"], "fail")

    def test_the_fallback_after_a_global_chain_is_never_warned_about(self):
        def fall(registry, *lists):
            providers = [ProviderListing(f"p{n}", registries) for n, registries in enumerate(lists)]
            return resolve_chain(["try-next-provider"] * len(lists), per_registry=False, stored_credential=True,
                                 registry=registry, providers=providers)

        gitlab = ["https://gitlab.example.com/"]
        for lists in ((gitlab, ["https://other.example.com/"]), (gitlab, None), (None,)):
            outcome = fall("https://registry.npmjs.org/", *lists)
            self.assertEqual((outcome.result, outcome.warnings), ("stored-credential", ()), lists)
        self.assertEqual(resolve_chain(["try-next-provider"], per_registry=False, stored_credential=True).warnings, ())


class ListedHostFallbackTests(unittest.TestCase):
    """A global chain every provider of which declined the registry sends no stored
    credential where some provider's hello lists the registry's host."""

    LISTS = ["https://registry.example.test/npm/"]

    def chain(self, registry, *lists, stored=True, answers=None):
        providers = [ProviderListing(f"p{n}", registries) for n, registries in enumerate(lists)]
        return resolve_chain(answers or ["try-next-provider"] * len(lists), per_registry=False, stored_credential=stored,
                             registry=registry, providers=providers)

    def test_the_http_form_of_a_listed_https_host_fails(self):
        outcome = self.chain("http://registry.example.test/npm/", self.LISTS)
        self.assertEqual(outcome.result, "fail")
        self.assertEqual(outcome.warnings, ())
        self.assertIn("p0", outcome.message)
        self.assertIn("https://registry.example.test/npm/", outcome.message, "it names the forms the provider lists")
        self.assertIn("no stored credential", outcome.message)

    def test_another_path_on_a_listed_host_fails(self):
        for registry in ("https://registry.example.test/other/", "https://REGISTRY.example.test/", "https://registry.example.test:8443/npm/"):
            with self.subTest(registry=registry):
                self.assertEqual(self.chain(registry, self.LISTS).result, "fail")

    def test_it_names_every_provider_that_lists_the_host_and_not_the_others(self):
        outcome = self.chain("http://registry.example.test/", ["https://a.example.test/"], self.LISTS,
                             ["http://registry.example.test:81/"])
        self.assertEqual(outcome.result, "fail")
        self.assertIn("p1 lists https://registry.example.test/npm/", outcome.message)
        self.assertIn("p2 lists http://registry.example.test:81/", outcome.message)
        self.assertNotIn("p0", outcome.message)

    def test_it_fails_with_or_without_a_stored_credential(self):
        self.assertEqual(self.chain("http://registry.example.test/npm/", self.LISTS, stored=False).result, "fail")

    def test_an_unlisted_host_still_falls_back_without_a_warning(self):
        outcome = self.chain("https://registry.npmjs.org/", self.LISTS, None)
        self.assertEqual(outcome.result, "stored-credential")
        self.assertEqual(outcome.warnings, ())
        self.assertEqual(self.chain("https://registry.npmjs.org/", None).result, "stored-credential")
        self.assertEqual(self.chain("https://registry.npmjs.org/", None, stored=False).result, "anonymous")

    def test_a_listed_npm_token_after_a_declined_listed_host_fails_too(self):
        # npm's `//host/path/` key ignores the scheme: the https token would go out over http
        self.assertEqual(POLICY["fallback"]["listedStoredCredentialOnListedHost"], "fail")
        registry = "http://registry.example.test/npm/"
        for stored in (True, False):
            outcome = self.chain(registry, self.LISTS, answers=["try-next-provider", "npm:token"], stored=stored)
            self.assertEqual(outcome.result, "fail", stored)
            self.assertEqual(outcome.warnings, ())
            self.assertIn("p0 lists https://registry.example.test/npm/", outcome.message)
        for per_registry in (False, True):
            providers = [ProviderListing("p0", self.LISTS)]
            outcome = resolve_chain(["try-next-provider", "npm:token"], per_registry=per_registry, stored_credential=True,
                                    registry=registry, providers=providers)
            self.assertEqual(outcome.result, "fail", per_registry)

    def test_a_listed_npm_token_is_unaffected_where_no_earlier_provider_declined_the_host(self):
        registry = "http://registry.example.test/npm/"
        # it stands first, or behind a provider that answered not-found or does not list the host
        self.assertEqual(self.chain(registry, self.LISTS, answers=["npm:token", "try-next-provider"]).result, "stored-credential")
        self.assertEqual(self.chain(registry, self.LISTS, answers=["try-next-provider-not-found", "npm:token"]).result,
                         "stored-credential")
        self.assertEqual(self.chain(registry, ["https://other.example.test/"], answers=["try-next-provider", "npm:token"]).result,
                         "stored-credential")
        self.assertEqual(self.chain(registry, None, answers=["try-next-provider", "npm:token"]).result, "stored-credential")
        # a provider after the entry did not decline anything before it
        providers = [ProviderListing("p0", ["https://other.example.test/"]), ProviderListing("p1", self.LISTS)]
        outcome = resolve_chain(["try-next-provider", "npm:token", "try-next-provider"], per_registry=False,
                                stored_credential=True, registry=registry, providers=providers)
        self.assertEqual(outcome.result, "stored-credential")

    def test_a_provider_that_answered_ok_or_not_found_decides_as_before(self):
        self.assertEqual(self.chain("http://registry.example.test/npm/", self.LISTS, None,
                                    answers=["try-next-provider", "ok"]).result, "ok")
        outcome = self.chain("http://registry.example.test/npm/", self.LISTS, answers=["try-next-provider-not-found"])
        self.assertEqual(outcome.result, "fail", "not-found at the end fails unless the chain lists npm:token")

    def test_a_provider_whose_hello_leaves_the_registry_out_is_declined_without_a_message(self):
        # the whole path: the hello lists https, the lockfile URL is http
        model = client(registries=self.LISTS)
        registry = "http://registry.example.test/npm/"
        self.assertEqual(model.request_or_decline(RequestContext(registry=registry)), "try-next-provider")
        outcome = self.chain(registry, self.LISTS)
        self.assertEqual(outcome.result, "fail")


class NotFoundMemoTests(unittest.TestCase):
    """`not-found` is remembered per provider, registry and scope for the command."""

    def ask(self, model, declined, provider, scope, package, answer):
        context = RequestContext(registry=REGISTRY, scope=scope, package=package)
        request = model.request_or_decline(context, declined, provider)
        if isinstance(request, str):
            return request, False
        return model.answer_in_chain(request, answer, declined, provider), True

    def test_a_provider_that_holds_one_scope_is_asked_once_per_other_scope(self):
        self.assertEqual(POLICY["chain"]["notFoundRemembered"], "per-provider-registry-and-scope-for-the-command")
        model, declined = client(), DeclinedRegistries()
        not_found = {"Err": {"kind": "not-found"}}
        first = self.ask(model, declined, "gitlab", "@a", "x", not_found)
        again = self.ask(model, declined, "gitlab", "@a", "y", not_found)
        other_scope = self.ask(model, declined, "gitlab", "@b", "x", not_found)
        self.assertEqual(first, ("try-next-provider-not-found", True))
        self.assertEqual(again, ("try-next-provider-not-found", False), "@a/y is not asked: the answer is remembered")
        self.assertEqual(other_scope, ("try-next-provider-not-found", True), "@b is a scope of its own")
        self.assertEqual(self.ask(model, declined, "gitlab", "@b", "z", not_found)[1], False)

    def test_a_not_found_for_the_stage_read_lookup_is_not_remembered_so_the_write_is_asked(self):
        """`stage approve` looks the record up with `stage-read` before the
        write, which the memory (per provider, registry and scope, not keyed by
        operation) would otherwise shut: the lookup names no scope, and the
        write for an unscoped package is that same key."""
        model, declined = client(), DeclinedRegistries()
        not_found = {"Err": {"kind": "not-found"}}
        lookup = model.request_or_decline(RequestContext(registry=REGISTRY, operation="stage-read", command="stage"),
                                          declined, "p")
        self.assertEqual(model.answer_in_chain(lookup, not_found, declined, "p"), "try-next-provider-not-found")

        write = model.request_or_decline(
            RequestContext(registry=REGISTRY, operation="publish", package="pkg", version="1.0.0", command="stage"),
            declined, "p")
        self.assertIsInstance(write, dict, "the write's get reaches the provider")

        # any other operation is remembered, as before
        read = model.request_or_decline(RequestContext(registry=REGISTRY, package="a"), declined, "q")
        model.answer_in_chain(read, not_found, declined, "q")
        self.assertEqual(
            model.request_or_decline(RequestContext(registry=REGISTRY, package="b"), declined, "q"),
            "try-next-provider-not-found",
        )

    def test_an_unscoped_package_is_no_scope_and_not_a_scope_named_none(self):
        model, declined = client(), DeclinedRegistries()
        not_found = {"Err": {"kind": "not-found"}}
        self.assertTrue(self.ask(model, declined, "p", None, "left-pad", not_found)[1])
        self.assertFalse(self.ask(model, declined, "p", None, "lodash", not_found)[1])
        self.assertTrue(self.ask(model, declined, "p", "@a", "x", not_found)[1], "a scope is asked even after the unscoped")

    def test_it_is_per_provider_and_per_registry(self):
        model, declined = client(), DeclinedRegistries()
        not_found = {"Err": {"kind": "not-found"}}
        self.ask(model, declined, "one", "@a", "x", not_found)
        self.assertTrue(self.ask(model, declined, "two", "@a", "x", not_found)[1], "another provider is asked")
        self.assertTrue(declined.should_ask("one", "https://other.example.test/", "@a"), "another registry too")

    def test_a_remembered_not_found_still_counts_for_the_end_of_the_chain(self):
        model, declined = client(), DeclinedRegistries()
        self.ask(model, declined, "p", "@a", "x", {"Err": {"kind": "not-found"}})
        remembered, _ = self.ask(model, declined, "p", "@a", "y", {"Err": {"kind": "not-found"}})
        self.assertEqual(resolve_chain([remembered], per_registry=False, stored_credential=True).result, "fail")

    def test_an_ok_is_not_remembered_and_url_not_supported_stays_per_registry(self):
        model, declined = client(), DeclinedRegistries()
        ok = {"Ok": {"kind": "get", "auth": {"type": "bearer", "token": "t"}, "granularity": "package"}}
        self.assertEqual(self.ask(model, declined, "p", "@a", "x", ok), ("ok", True))
        self.assertTrue(declined.should_ask("p", REGISTRY, "@a"))
        self.ask(model, declined, "q", "@a", "x", {"Err": {"kind": "url-not-supported"}})
        self.assertFalse(declined.should_ask("q", REGISTRY, "@zzz"), "the registry's decline holds for every scope")

    def test_an_erase_answered_not_found_is_not_remembered(self):
        model, declined = client(), DeclinedRegistries()
        erase = {"v": 1, "kind": "erase", "registry": REGISTRY, "scope": "@a", "operation": "read", "granularity": "scope"}
        model.answer_in_chain(erase, {"Err": {"kind": "not-found"}}, declined, "p")
        self.assertTrue(declined.should_ask("p", REGISTRY, "@a"))


class SessionTests(unittest.TestCase):
    def test_killed_twice_for_a_timeout_is_not_started_again(self):
        restarts = ProviderRestarts()
        self.assertEqual(restarts.on_timeout(queued=["a", "b", "c"]), ["a", "b", "c"], "the queued requests fail")
        self.assertTrue(restarts.may_start(), "a first kill, at hello, allows a new session")
        self.assertEqual(restarts.on_timeout(queued=[]), [])
        self.assertFalse(restarts.may_start())
        self.assertEqual((restarts.kills, restarts.failed), (2, ["a", "b", "c"]))
        self.assertEqual(FAILED_SESSIONS_BEFORE_NO_RESTART, 2)
        self.assertEqual(POLICY["credentialProvider"]["cacheAfterTimeout"], "keep")

    def test_policy_numbers(self):
        self.assertEqual(LINE_SIZE_MINIMUM, 1024 * 1024)
        self.assertEqual(SENTINEL_ARGUMENT, "--npm-credential-provider")
        self.assertEqual(POLICY["nonInteractive"]["interactiveRule"], "stdin and stdout are TTYs and no CI is detected")


if __name__ == "__main__":
    unittest.main()
