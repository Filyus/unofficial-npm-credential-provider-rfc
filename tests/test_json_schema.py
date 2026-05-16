from __future__ import annotations

import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "schema" / "protocol-v1.schema.json"


class JsonSchemaArtifactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))

    def test_schema_file_is_valid_json_and_names_protocol_version(self) -> None:
        self.assertEqual(self.schema["$schema"], "https://json-schema.org/draft/2020-12/schema")
        self.assertIn("Credential Provider Protocol v1", self.schema["title"])

    def test_schema_exposes_expected_top_level_defs(self) -> None:
        defs = self.schema["$defs"]

        for name in (
            "hello",
            "request",
            "providerResponse",
            "providerOk",
            "providerErr",
            "auth",
            "bearerAuth",
            "basicAuth",
        ):
            self.assertIn(name, defs)

    def test_schema_uses_external_ok_err_response_shape(self) -> None:
        response = self.schema["$defs"]["providerResponse"]

        self.assertIn("Ok", response["properties"])
        self.assertIn("Err", response["properties"])
        self.assertEqual(len(response["oneOf"]), 2)

    def test_jsonschema_validates_positive_and_negative_examples_when_available(self) -> None:
        jsonschema = self.import_jsonschema()

        validator = jsonschema.Draft202012Validator(self.schema)
        jsonschema.Draft202012Validator.check_schema(self.schema)

        valid_messages = [
            {"v": [1]},
            {
                "v": 1,
                "action": "get",
                "registry": "https://registry.example.test/",
                "operation": "install",
                "interactive": False,
            },
            {
                "v": 1,
                "action": "refresh",
                "registry": "https://registry.example.test/",
                "refreshToken": "opaque-refresh-token",
            },
            {
                "Ok": {
                    "auth": {"type": "bearer", "token": "token"},
                    "cache": "session",
                    "granularity": "scope",
                }
            },
            {
                "Ok": {
                    "auth": {"type": "basic", "username": "user", "password": "secret"},
                    "cache": "expires",
                    "expiresAt": 1893456000,
                }
            },
            {
                "Err": {
                    "kind": "other",
                    "message": "provider failed",
                    "causedBy": ["test"],
                }
            },
        ]
        invalid_messages = [
            {"v": []},
            {
                "v": 1,
                "action": "refresh",
                "registry": "https://registry.example.test/",
            },
            {
                "v": 1,
                "action": "get",
                "registry": "https://registry.example.test/",
                "interactive": False,
            },
            {"Ok": {"auth": {"type": "bearer"}}},
            {"Ok": {"auth": {"type": "bearer", "token": "token"}, "cache": "expires"}},
            {"Ok": {"kind": "login"}, "Err": {"kind": "other"}},
            {"Err": {"kind": "permission-denied"}},
        ]

        for message in valid_messages:
            with self.subTest(valid=message):
                validator.validate(message)

        for message in invalid_messages:
            with self.subTest(invalid=message):
                with self.assertRaises(jsonschema.ValidationError):
                    validator.validate(message)

    def import_jsonschema(self):
        try:
            import jsonschema
        except ModuleNotFoundError as exc:
            self.skipTest(f"jsonschema is not installed: {exc}")
        return jsonschema


if __name__ == "__main__":
    unittest.main()
