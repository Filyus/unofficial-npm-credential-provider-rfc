"""Rules of the credential a provider hands out: what `npm:token` serves, the
anonymous answer, and the route a provider's credential may take. Each is a
rule of the model; that npm follows it is for npm's own tests."""

from __future__ import annotations

import json
from pathlib import Path
import unittest

from tests.protocol_model import (
    CommandWarnings,
    CredentialClientModel,
    ProtocolViolation,
    ProviderListing,
    RequestContext,
    STORED_CREDENTIAL_ENTRY,
    npm_token_serves,
    provider_route_outcome,
    resolve_chain,
)

POLICY = json.loads((Path(__file__).resolve().parents[1] / "spec" / "policy-v1.json").read_text(encoding="utf-8"))
DECLINE = "try-next-provider"
REGISTRY = "https://registry.example.test/"
NONE_ANSWER = {"Ok": {"kind": "get", "auth": {"type": "none"}, "cache": "session", "granularity": "registry"}}


def ready_client() -> CredentialClientModel:
    client = CredentialClientModel()
    client.receive_hello({"v": [1], "registries": [REGISTRY]})
    return client


def get(operation="read", **extra):
    return RequestContext(registry=REGISTRY, operation=operation, **extra)


class StoredCredentialSourceTests(unittest.TestCase):
    def test_npm_token_serves_only_what_the_user_stored(self):
        for source in ("user", "global", "env", "cli"):
            self.assertTrue(npm_token_serves(source), source)
        for source in ("project", "workspace", "publishConfig"):
            self.assertFalse(npm_token_serves(source), source)
        self.assertEqual(set(POLICY["chain"]["storedCredentialSources"]), {"user", "global", "env", "cli"})

    def test_a_committed_job_token_for_a_host_the_project_chose_sends_nothing(self):
        # registry=https://evil.example/ and //evil.example/:_authToken=${CI_JOB_TOKEN}, both in the project
        evil = "https://evil.example/"
        providers = [ProviderListing("gitlab", ["https://gitlab.example.com/"])]
        outcome = resolve_chain([DECLINE], per_registry=False, stored_credential=False, project_credential=True,
                                registry=evil, providers=providers)
        self.assertEqual(outcome.result, "anonymous")
        self.assertEqual(len(outcome.warnings), 1)
        self.assertIn("project config", outcome.warnings[0])

    def test_a_listed_npm_token_does_not_serve_it_either(self):
        # with nothing the entry may serve, a global chain goes out anonymously and a per-registry list fails
        for per_registry, result in ((False, "anonymous"), (True, "fail")):
            outcome = resolve_chain([STORED_CREDENTIAL_ENTRY], per_registry=per_registry, stored_credential=False,
                                    project_credential=True)
            self.assertEqual(outcome.result, result, per_registry)
            self.assertTrue(outcome.warnings)

    def test_the_users_own_credential_is_served_beside_a_project_one(self):
        outcome = resolve_chain([DECLINE], per_registry=False, stored_credential=True, project_credential=True)
        self.assertEqual(outcome.result, "stored-credential")
        self.assertEqual(len(outcome.warnings), 1)

    def test_where_no_chain_applies_config_is_read_as_today(self):
        outcome = resolve_chain([], per_registry=False, stored_credential=False, project_credential=True)
        self.assertEqual((outcome.result, outcome.warnings), ("stored-credential", ()))

    def test_the_warning_is_said_once_per_registry_per_command(self):
        command = CommandWarnings()
        outcome = resolve_chain([DECLINE], per_registry=False, stored_credential=False, project_credential=True)
        self.assertEqual(len(command.say(REGISTRY, outcome)), 1)
        self.assertEqual(command.say(REGISTRY, outcome), [])

    def test_the_policy_says_so(self):
        self.assertEqual(POLICY["fallback"]["projectCredentialThroughChain"], "never-served-and-warned")


class AnonymousAnswerTests(unittest.TestCase):
    def answer(self, context, response=NONE_ANSWER):
        client = ready_client()
        request = client.build_request(context)
        return client, client.handle_response(request, response)

    def test_a_get_for_read_may_be_answered_anonymously(self):
        client, outcome = self.answer(get())
        self.assertEqual(outcome, "ok")
        found = client.lookup(REGISTRY)
        self.assertEqual(found.auth, {"type": "none"})

    def test_nothing_but_a_get_for_read_may(self):
        self.assertEqual(POLICY["anonymousAnswer"]["validOperations"], ["read"])
        for operation, version in (("publish", "1.0.0"), ("stage", "1.0.0"), ("stage-read", None), ("access", None),
                                   ("account", None), ("dist-tag", None), ("trust", None)):
            with self.subTest(operation=operation), self.assertRaises(ProtocolViolation):
                self.answer(get(operation, interactive=True, version=version))

    def test_a_retry_may_not_go_anonymous(self):
        client = ready_client()
        request = client.build_request(get())
        request = {**request, "retry": True, "httpStatus": 401}
        with self.assertRaises(ProtocolViolation):
            client.handle_response(request, NONE_ANSWER)

    def test_other_kinds_may_not_carry_it(self):
        client = ready_client()
        login = client.build_request(RequestContext(registry=REGISTRY, kind="login", interactive=True))
        with self.assertRaises(ProtocolViolation):
            client.handle_response(login, {"Ok": {"kind": "login", "auth": {"type": "none"}}})

    def test_it_is_never_operation_independent(self):
        client = ready_client()
        request = client.build_request(get())
        answer = {"Ok": {"kind": "get", "auth": {"type": "none"}, "operationIndependent": True}}
        with self.assertRaises(ProtocolViolation):
            client.handle_response(request, answer)

    def test_a_cached_anonymous_answer_never_serves_a_write(self):
        client, _ = self.answer(get())
        for operation in ("publish", "stage-read", "access"):
            self.assertIsNone(client.lookup(REGISTRY, operation=operation), operation)

    def test_it_is_said_at_warn_once_per_registry_per_command_naming_the_provider(self):
        command = CommandWarnings()
        first = command.say_anonymous(REGISTRY, "npmjs")
        self.assertEqual(len(first), 1)
        self.assertIn("npmjs", first[0])
        self.assertIn("anonymously", first[0])
        self.assertEqual(command.say_anonymous(REGISTRY, "npmjs"), [])
        self.assertEqual(len(command.say_anonymous("https://other.example.test/", "npmjs")), 1)

    def test_the_policy_says_so(self):
        anonymous = POLICY["anonymousAnswer"]
        self.assertEqual((anonymous["erase"], anonymous["retry"], anonymous["validOnRetry"]), ("none", "none", False))
        self.assertIn("none", POLICY["wire"]["authTypes"])
        self.assertIs(POLICY["nonInteractive"]["readMayStartLogin"], False)


class ProviderRouteTests(unittest.TestCase):
    def test_plain_http_goes_only_to_this_machine(self):
        self.assertEqual(provider_route_outcome("http:", "registry.example.test"), "plain-http")
        self.assertEqual(provider_route_outcome("http:", "10.0.0.5"), "plain-http")
        for host in ("localhost", "127.0.0.1", "127.1.2.3", "[::1]"):
            self.assertEqual(provider_route_outcome("http:", host), "sent", host)
        self.assertEqual(provider_route_outcome("https:", "registry.example.test"), "sent")

    def test_a_certificate_setting_a_project_chose_refuses_every_scheme(self):
        for key in ("ca", "cafile", "strict-ssl"):
            for scheme, host in (("https:", "registry.example.test"), ("http:", "localhost")):
                with self.subTest(key=key, scheme=scheme):
                    self.assertEqual(provider_route_outcome(scheme, host, (key,)), "project-route")

    def test_a_project_proxy_refuses_only_what_it_could_read(self):
        for key in ("proxy", "https-proxy"):
            self.assertEqual(provider_route_outcome("http:", "localhost", (key,)), "project-route", key)
            self.assertEqual(provider_route_outcome("https:", "registry.example.test", (key,)), "sent", key)
            self.assertEqual(provider_route_outcome("http:", "registry.example.test", (key,)), "plain-http", key)

    def test_the_policy_applies_from_the_first_release(self):
        self.assertEqual(POLICY["providerRoute"]["appliesFrom"], "first-release")
        self.assertEqual(POLICY["providerRoute"]["projectProxyRefuses"], "http-loopback-only")


if __name__ == "__main__":
    unittest.main()
