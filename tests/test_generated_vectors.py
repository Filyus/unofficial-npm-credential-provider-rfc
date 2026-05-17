from __future__ import annotations

import json
from pathlib import Path
import unittest

from tests.protocol_model import CredentialClientModel, ProtocolViolation, validate_request


ROOT = Path(__file__).resolve().parents[1]
VECTOR_PATH = ROOT / "tests" / "generated_protocol_vectors.json"


class GeneratedProtocolVectorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.vectors = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))

    def test_generated_valid_request_vectors_match_python_model(self) -> None:
        for vector in self._vectors("validMessages", "request-"):
            with self.subTest(vector=vector["name"]):
                validate_request(vector["message"])

    def test_generated_invalid_request_vectors_match_python_model(self) -> None:
        for vector in self._vectors("invalidMessages", "request-"):
            with self.subTest(vector=vector["name"]):
                with self.assertRaises(ProtocolViolation):
                    validate_request(vector["message"])

    def test_generated_hello_vectors_match_python_model(self) -> None:
        for vector in self._vectors("validMessages", "hello-"):
            with self.subTest(valid=vector["name"]):
                client = CredentialClientModel()
                client.receive_hello(vector["message"])

        for vector in self._vectors("invalidMessages", "hello-"):
            with self.subTest(invalid=vector["name"]):
                client = CredentialClientModel()
                with self.assertRaises(ProtocolViolation):
                    client.receive_hello(vector["message"])

    def _vectors(self, group: str, name_prefix: str) -> list[dict]:
        return [vector for vector in self.vectors[group] if vector["name"].startswith(name_prefix)]


if __name__ == "__main__":
    unittest.main()
