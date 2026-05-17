from __future__ import annotations

import subprocess
import sys
import unittest


class CodegenTests(unittest.TestCase):
    def test_generated_files_are_fresh(self) -> None:
        result = subprocess.run(
            [sys.executable, "tools/generate_from_policy.py", "--check"],
            cwd=".",
            capture_output=True,
            text=True,
        )

        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
