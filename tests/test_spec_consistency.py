from __future__ import annotations

import json
from pathlib import Path
import unittest

from tests import protocol_model
from tests.protocol_model import (
    CredentialClientModel,
    ProviderConfig,
    ProviderFailure,
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

    def test_request_kind_enum_matches_policy_and_python_model(self) -> None:
        schema_kinds = set(self.schema["$defs"]["request"]["properties"]["kind"]["enum"])

        self.assertEqual(schema_kinds, set(self.policy["wire"]["requestKinds"]))
        self.assertEqual(schema_kinds, protocol_model.SUPPORTED_REQUEST_KINDS)

    def test_operation_enum_matches_policy_and_python_model(self) -> None:
        schema_operations = set(self.schema["$defs"]["request"]["properties"]["operation"]["enum"])

        self.assertEqual(schema_operations, set(self.policy["wire"]["operations"]))
        self.assertEqual(schema_operations, protocol_model.SUPPORTED_OPERATIONS)

    def test_command_enum_matches_policy_and_python_model(self) -> None:
        schema_commands = set(self.schema["$defs"]["request"]["properties"]["command"]["enum"])

        self.assertEqual(schema_commands, set(self.policy["wire"]["commands"]))
        self.assertEqual(schema_commands, protocol_model.SUPPORTED_COMMANDS)

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

        with self.assertRaises(ProviderFailure):
            client.handle_response(request, {"Err": {"kind": "not-found"}})

        fallback_client = CredentialClientModel(ProviderConfig(legacy_fallback=True))
        fallback_client.receive_hello({"v": [1]})
        self.assertEqual(
            fallback_client.handle_response(request, {"Err": {"kind": "not-found"}}),
            self.policy["errors"]["not-found"]["legacyFallbackEnabled"],
        )

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
        entry = client.cache[("https://registry.example.test/",)]

        self.assertEqual(entry.cache, self.policy["cache"]["defaultPolicy"])
        self.assertEqual(entry.granularity, self.policy["cache"]["defaultGranularity"])
        self.assertEqual(
            entry.operation_independent,
            self.policy["cache"]["operationIndependentDefault"],
        )


if __name__ == "__main__":
    unittest.main()
