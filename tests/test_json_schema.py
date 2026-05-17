from __future__ import annotations

import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "spec" / "protocol-v1.schema.json"
VECTOR_PATH = ROOT / "tests" / "generated_protocol_vectors.json"


class JsonSchemaArtifactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        cls.vectors = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))

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

        for vector in self.vectors["validMessages"]:
            with self.subTest(valid=vector["name"]):
                validator.validate(vector["message"])

        for vector in self.vectors["invalidMessages"]:
            with self.subTest(invalid=vector["name"]):
                with self.assertRaises(jsonschema.ValidationError):
                    validator.validate(vector["message"])

    def test_generated_vectors_have_unique_names(self) -> None:
        names = [case["name"] for case in self.vectors["validMessages"] + self.vectors["invalidMessages"]]

        self.assertEqual(len(names), len(set(names)))

    def import_jsonschema(self):
        try:
            import jsonschema
        except ModuleNotFoundError as exc:
            self.skipTest(f"jsonschema is not installed: {exc}")
        return jsonschema


if __name__ == "__main__":
    unittest.main()
