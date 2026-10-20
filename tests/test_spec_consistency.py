from __future__ import annotations

import json
from pathlib import Path
import unittest

import re

from tests import generated_policy, protocol_model
from tests.protocol_model import (
    CacheKey,
    CredentialClientModel,
    ProviderLocation,
    ResolutionFailure,
    resolve_provider,
)


ROOT = Path(__file__).resolve().parents[1]
PROTOCOL_SCHEMA_PATH = ROOT / "spec" / "protocol-v1.schema.json"
POLICY_PATH = ROOT / "spec" / "policy-v1.json"


def schema_pattern(policy: dict) -> str:
    """The policy's identifier pattern as the schema spells it: `$` in Python's
    `re.search` also matches before a final newline, so the schema ends the
    pattern with a lookahead that only the end of the string satisfies."""
    pattern = policy["forwardCompatibility"]["identifierPattern"]
    assert pattern.endswith("$")
    return pattern[:-1] + "(?![\\s\\S])"


class SpecConsistencyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = json.loads(PROTOCOL_SCHEMA_PATH.read_text(encoding="utf-8"))
        cls.policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))

    def test_policy_version_matches_python_model(self) -> None:
        self.assertEqual(self.policy["protocolVersion"], protocol_model.PROTOCOL_VERSION)

    def test_request_kind_is_open_and_its_known_values_match_policy_and_python_model(self) -> None:
        schema_kind = self.schema["$defs"]["request"]["properties"]["kind"]

        self.assertNotIn("enum", schema_kind)
        self.assertEqual(schema_kind["pattern"], schema_pattern(self.policy))
        self.assertEqual(set(schema_kind["examples"]), set(self.policy["wire"]["requestKinds"]))
        self.assertEqual(set(schema_kind["examples"]), protocol_model.SUPPORTED_REQUEST_KINDS)

    def test_operation_is_open_and_its_known_values_match_policy_and_python_model(self) -> None:
        schema_operation = self.schema["$defs"]["request"]["properties"]["operation"]

        self.assertNotIn("enum", schema_operation)
        self.assertEqual(schema_operation["pattern"], schema_pattern(self.policy))
        self.assertEqual(set(schema_operation["examples"]), set(self.policy["wire"]["operations"]))
        self.assertEqual(set(schema_operation["examples"]), protocol_model.SUPPORTED_OPERATIONS)

    def test_request_granularity_matches_response_granularity(self) -> None:
        defs = self.schema["$defs"]

        # the request's is closed, the response's open: its known values are the same
        self.assertEqual(
            defs["request"]["properties"]["granularity"]["enum"],
            defs["providerOk"]["properties"]["granularity"]["examples"],
        )

    def test_timeouts_match_python_model_and_interactive_get_gets_the_login_budget(self) -> None:
        timeouts = self.policy["credentialProvider"]["timeoutSeconds"]

        self.assertEqual(timeouts, protocol_model.TIMEOUT_SECONDS)
        self.assertEqual(timeouts["getInteractive"], timeouts["login"])
        self.assertGreater(timeouts["getInteractive"], timeouts["get"])

    def test_command_is_open_ended_in_schema_and_python_model(self) -> None:
        schema_command = self.schema["$defs"]["request"]["properties"]["command"]

        self.assertNotIn("enum", schema_command)
        self.assertEqual(schema_command["type"], "string")
        self.assertTrue(self.policy["wire"]["knownCommands"])
        self.assertEqual(generated_policy.KNOWN_COMMANDS, frozenset(self.policy["wire"]["knownCommands"]))
        request = {
            "v": 1,
            "kind": "get",
            "registry": "https://registry.example.test/",
            "operation": "read",
            "command": "outdated",
            "interactive": False,
        }
        self.assertNotIn("outdated", self.policy["wire"]["knownCommands"])
        protocol_model.validate_request(request)

    def test_operations_requiring_version_match_schema(self) -> None:
        rules = self.schema["$defs"]["request"]["allOf"]
        version_rule = next(rule for rule in rules if rule["then"].get("required") == ["version"])

        self.assertEqual(
            set(version_rule["if"]["properties"]["operation"]["enum"]),
            set(self.policy["wire"]["operationsRequiringVersion"]),
        )
        self.assertEqual(
            set(self.policy["wire"]["operationsRequiringVersion"]),
            protocol_model.OPERATIONS_REQUIRING_VERSION,
        )

    def test_operation_not_supported_has_no_fallback_left(self) -> None:
        self.assertEqual(
            self.policy["errors"]["operation-not-supported"], {"default": "fail", "erase": "ignore-and-retry"}
        )

    def test_erase_errors_match_python_model(self) -> None:
        client = CredentialClientModel()
        client.receive_hello({"v": [1], "capabilities": ["erase"]})
        erase = {
            "v": 1,
            "kind": "erase",
            "registry": "https://registry.example.test/",
            "operation": "read",
            "granularity": "registry",
        }
        for kind, rules in self.policy["errors"].items():
            with self.subTest(kind=kind):
                self.assertEqual(client.handle_response(erase, {"Err": {"kind": kind}}), rules["erase"])

    def test_capabilities_match_policy_and_python_model(self) -> None:
        hello_properties = self.schema["$defs"]["hello"]["properties"]

        self.assertIn("capabilities", hello_properties)
        self.assertEqual(set(self.policy["wire"]["capabilities"]), protocol_model.SUPPORTED_CAPABILITIES)

    def test_auth_type_enum_matches_policy_and_python_model(self) -> None:
        schema_auth_types = {
            self.schema["$defs"]["bearerAuth"]["properties"]["type"]["const"],
            self.schema["$defs"]["basicAuth"]["properties"]["type"]["const"],
        }

        self.assertEqual(schema_auth_types, set(self.policy["wire"]["authTypes"]))
        self.assertEqual(schema_auth_types, protocol_model.SUPPORTED_AUTH_TYPES)
        # any other identifier is the third shape of `auth`, which npm fails as `other`
        unknown = self.schema["$defs"]["unknownAuth"]["properties"]["type"]
        self.assertEqual(unknown["pattern"], schema_pattern(self.policy))
        self.assertEqual(set(unknown["not"]["enum"]), schema_auth_types)

    def test_cache_policy_enum_matches_policy_and_python_model(self) -> None:
        schema_cache = self.schema["$defs"]["providerOk"]["properties"]["cache"]
        schema_cache_policies = set(schema_cache["examples"])

        self.assertNotIn("enum", schema_cache)
        self.assertEqual(schema_cache["pattern"], schema_pattern(self.policy))
        self.assertIn(self.policy["forwardCompatibility"]["unknownCache"], schema_cache_policies)

        self.assertEqual(schema_cache_policies, set(self.policy["wire"]["cachePolicies"]))
        self.assertEqual(schema_cache_policies, protocol_model.SUPPORTED_CACHE)

    def test_granularity_enum_matches_policy_and_python_model(self) -> None:
        schema_granularity = self.schema["$defs"]["providerOk"]["properties"]["granularity"]
        schema_granularities = set(schema_granularity["examples"])

        self.assertNotIn("enum", schema_granularity)
        self.assertEqual(schema_granularity["pattern"], schema_pattern(self.policy))
        self.assertIn(self.policy["forwardCompatibility"]["unknownGranularity"], schema_granularities)

        self.assertEqual(schema_granularities, set(self.policy["wire"]["granularities"]))
        self.assertEqual(schema_granularities, protocol_model.SUPPORTED_GRANULARITY)

    def test_error_kind_enum_matches_policy_and_python_model(self) -> None:
        schema_error = self.schema["$defs"]["providerErr"]["properties"]["kind"]
        schema_error_kinds = set(schema_error["examples"])

        self.assertNotIn("enum", schema_error)
        self.assertEqual(schema_error["pattern"], schema_pattern(self.policy))
        self.assertIn(self.policy["forwardCompatibility"]["unknownErrorKind"], schema_error_kinds)

        self.assertEqual(schema_error_kinds, set(self.policy["wire"]["errorKinds"]))
        self.assertEqual(schema_error_kinds, protocol_model.ERROR_KINDS)

    def test_resolution_policy_matches_python_model(self) -> None:
        self.assertEqual(
            set(self.policy["resolution"]["trustedLocationKinds"]),
            protocol_model.TRUSTED_LOCATION_KINDS,
        )

        with self.assertRaises(ResolutionFailure):
            resolve_provider("provider", "project", [])

        resolved = resolve_provider(
            "provider",
            "user",
            [ProviderLocation("provider", "global-bin", "/trusted/provider")],
        )
        self.assertEqual(resolved.kind, "global-bin")

    def test_error_policy_matches_python_model(self) -> None:
        client = CredentialClientModel()
        client.receive_hello({"v": [1]})
        request = {
            "v": 1,
            "kind": "get",
            "registry": "https://registry.example.test/",
            "operation": "read",
            "command": "install",
            "interactive": False,
        }

        self.assertEqual(
            client.handle_response(request, {"Err": {"kind": "url-not-supported"}}),
            self.policy["errors"]["url-not-supported"]["default"],
        )

        self.assertEqual(
            client.handle_response(request, {"Err": {"kind": "not-found"}}),
            self.policy["errors"]["not-found"]["default"],
        )
        self.assertEqual(self.policy["chain"]["notFound"], "try-next-provider")

    def test_cache_defaults_match_python_model(self) -> None:
        client = CredentialClientModel()
        client.receive_hello({"v": [1]})
        request = {
            "v": 1,
            "kind": "get",
            "registry": "https://registry.example.test/",
            "operation": "read",
            "command": "install",
            "interactive": False,
        }
        client.handle_response(request, {"Ok": {"kind": "get", "auth": {"type": "bearer", "token": "token"}}})
        entry = client.cache[CacheKey("registry", "https://registry.example.test/")]

        self.assertEqual(entry.cache, self.policy["cache"]["defaultPolicy"])
        self.assertEqual(entry.granularity, self.policy["cache"]["defaultGranularity"])
        self.assertEqual(
            entry.operation_independent,
            self.policy["cache"]["operationIndependentDefault"],
        )


class UnusedPolicyValueTests(unittest.TestCase):
    def test_the_phase_1_timeout_is_spec_data_pinned_to_the_text_not_a_model_constant(self) -> None:
        """The Phase 1 model runs no helper, so it has no timeout to read: the
        policy's `tokenHelper.timeoutSeconds` is not generated into the model,
        and the text it summarizes is what pins it."""
        policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
        text = (ROOT / "phase-1-token-helper.md").read_text(encoding="utf-8")

        self.assertIn(f"Running longer than {policy['tokenHelper']['timeoutSeconds']} seconds", text)
        self.assertFalse(hasattr(protocol_model, "TOKEN_HELPER_TIMEOUT_SECONDS"))

    def test_every_generated_python_constant_is_read_by_the_model_or_a_test(self) -> None:
        generated = (ROOT / "tests" / "generated_policy.py").read_text(encoding="utf-8")
        names = re.findall(r"^([A-Z_]+) = ", generated, re.MULTILINE)
        sources = "".join(path.read_text(encoding="utf-8") for path in (ROOT / "tests").glob("*.py") if path.name != "generated_policy.py")
        unread = [name for name in names if name not in sources]

        self.assertEqual(unread, [])


if __name__ == "__main__":
    unittest.main()
