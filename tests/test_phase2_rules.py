from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from tests.generated_policy import LINE_SIZE_MINIMUM, SENTINEL_ARGUMENT, TIMEOUT_KILLS_BEFORE_NO_RESTART
from tests.protocol_model import (
    CacheKey,
    CredentialClientModel,
    DeclinedRegistries,
    ProtocolViolation,
    ProviderRestarts,
    RequestContext,
    rejection_action,
    resolve_chain,
    validate_transcript,
)

REGISTRY = "https://registry.example.test/"
POLICY = json.loads((Path(__file__).resolve().parents[1] / "spec" / "policy-v1.json").read_text(encoding="utf-8"))
TRANSCRIPTS = Path(__file__).resolve().parent / "transcripts"


def client(capabilities=("erase",), **hello):
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
            ((401, "ipaddress otp"), (False, False, "eauthip")),
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

    def test_an_empty_list_declines_everything_and_no_list_asks(self):
        self.assertEqual(client(registries=[]).request_or_decline(RequestContext(registry=REGISTRY)), "try-next-provider")
        self.assertIsInstance(client().request_or_decline(RequestContext(registry=REGISTRY)), dict)

    def test_the_fallback_warning_is_limited_to_hosts_a_listing_provider_serves(self):
        warn = lambda host, listed: resolve_chain(["try-next-provider"], per_registry=False, stored_credential=True,
                                                 registry_host=host, listed_hosts=listed).warnings
        self.assertTrue(warn("gitlab.example.com", frozenset({"gitlab.example.com"})))
        self.assertFalse(warn("registry.npmjs.org", frozenset({"gitlab.example.com"})))
        self.assertTrue(warn("registry.npmjs.org", None), "a provider without a list leaves the warning on")


class SessionTests(unittest.TestCase):
    def test_killed_twice_for_a_timeout_is_not_started_again(self):
        restarts = ProviderRestarts()
        self.assertEqual(restarts.on_timeout(queued=3), 3, "the queued requests fail")
        self.assertTrue(restarts.may_start(), "a first kill, at hello, allows a new session")
        restarts.on_timeout(queued=0)
        self.assertFalse(restarts.may_start())
        self.assertEqual(TIMEOUT_KILLS_BEFORE_NO_RESTART, 2)
        self.assertEqual(POLICY["credentialProvider"]["cacheAfterTimeout"], "keep")

    def test_policy_numbers(self):
        self.assertEqual(LINE_SIZE_MINIMUM, 1024 * 1024)
        self.assertEqual(SENTINEL_ARGUMENT, "--npm-credential-provider")
        self.assertIn("TTY", POLICY["nonInteractive"]["interactiveRule"])


if __name__ == "__main__":
    unittest.main()
