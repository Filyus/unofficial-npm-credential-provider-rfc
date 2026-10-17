from __future__ import annotations

import json
from pathlib import Path
import unittest

from tests import protocol_model
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
        self.assertEqual(schema_kind["pattern"], self.policy["forwardCompatibility"]["identifierPattern"])
        self.assertEqual(set(schema_kind["examples"]), set(self.policy["wire"]["requestKinds"]))
        self.assertEqual(set(schema_kind["examples"]), protocol_model.SUPPORTED_REQUEST_KINDS)

    def test_operation_is_open_and_its_known_values_match_policy_and_python_model(self) -> None:
        schema_operation = self.schema["$defs"]["request"]["properties"]["operation"]

        self.assertNotIn("enum", schema_operation)
        self.assertEqual(schema_operation["pattern"], self.policy["forwardCompatibility"]["identifierPattern"])
        self.assertEqual(set(schema_operation["examples"]), set(self.policy["wire"]["operations"]))
        self.assertEqual(set(schema_operation["examples"]), protocol_model.SUPPORTED_OPERATIONS)

    def test_request_granularity_matches_response_granularity(self) -> None:
        defs = self.schema["$defs"]

        self.assertEqual(
            defs["request"]["properties"]["granularity"]["enum"],
            defs["providerOk"]["properties"]["granularity"]["enum"],
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

    def test_cache_policy_enum_matches_policy_and_python_model(self) -> None:
        schema_cache_policies = set(self.schema["$defs"]["providerOk"]["properties"]["cache"]["enum"])

        self.assertEqual(schema_cache_policies, set(self.policy["wire"]["cachePolicies"]))
        self.assertEqual(schema_cache_policies, protocol_model.SUPPORTED_CACHE)

    def test_granularity_enum_matches_policy_and_python_model(self) -> None:
        schema_granularities = set(self.schema["$defs"]["providerOk"]["properties"]["granularity"]["enum"])

        self.assertEqual(schema_granularities, set(self.policy["wire"]["granularities"]))
        self.assertEqual(schema_granularities, protocol_model.SUPPORTED_GRANULARITY)

    def test_error_kind_enum_matches_policy_and_python_model(self) -> None:
        schema_error_kinds = set(self.schema["$defs"]["providerErr"]["properties"]["kind"]["enum"])

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


if __name__ == "__main__":
    unittest.main()
