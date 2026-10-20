from __future__ import annotations

import json
from pathlib import Path
import unittest

from tests.tools_required import skip_or_fail


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

    def test_no_pattern_ends_in_a_bare_dollar(self) -> None:
        # Python's re.search lets `$` match before a final newline, so a
        # validator built on it accepts "login\n"; the lookahead does not.
        found = []

        def walk(node: object, where: str) -> None:
            if isinstance(node, dict):
                for key, value in node.items():
                    if key == "pattern" and isinstance(value, str) and value.endswith("$"):
                        found.append(where)
                    walk(value, f"{where}/{key}")
            elif isinstance(node, list):
                for index, value in enumerate(node):
                    walk(value, f"{where}/{index}")

        walk(self.schema, "#")
        self.assertEqual(found, [])

    def test_jsonschema_refuses_a_trailing_newline_wherever_a_pattern_anchors_the_end(self) -> None:
        jsonschema = self.import_jsonschema()
        validator = jsonschema.Draft202012Validator(self.schema)
        request = {"v": 1, "kind": "x-y", "registry": "r", "operation": "read"}
        cases = [
            ("a request kind", {**request, "kind": "x-y\n"}),
            ("a request operation", {**request, "operation": "read\n"}),
            ("an Ok kind", {"Ok": {"kind": "login\n"}}),
            ("a hello registry", {"v": [1], "registries": ["https://h/\n"]}),
        ]
        controls = [request, {"v": [1], "registries": ["https://h/"]}]
        for message in controls:
            with self.subTest(control=message):
                self.assertTrue(validator.is_valid(message))
        for name, message in cases:
            with self.subTest(name):
                self.assertFalse(validator.is_valid(message))

    def test_generated_vectors_have_unique_names(self) -> None:
        names = [case["name"] for case in self.vectors["validMessages"] + self.vectors["invalidMessages"]]

        self.assertEqual(len(names), len(set(names)))

    def import_jsonschema(self):
        try:
            import jsonschema
        except ModuleNotFoundError as exc:
            skip_or_fail(self, f"jsonschema is not installed: {exc}")
        return jsonschema


if __name__ == "__main__":
    unittest.main()
