"""Seeds the corpus of poc/rust/fuzz's `message` target with the messages of
the transcripts: one file per distinct hello, request and response, a role
byte (0, 1, 2) first, as the target reads it.

    python tools/seed_fuzz_corpus.py poc/rust/fuzz/corpus/message
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.differential import bases  # noqa: E402

ROLE_BYTE = {"hello": 0, "request": 1, "response": 2}


def main(destination: str) -> int:
    out = Path(destination)
    out.mkdir(parents=True, exist_ok=True)
    count = 0
    for role, messages in bases().items():
        for message in messages:
            body = json.dumps(message, separators=(",", ":")).encode("utf-8")
            name = hashlib.sha1(bytes([ROLE_BYTE[role]]) + body).hexdigest()
            (out / name).write_bytes(bytes([ROLE_BYTE[role]]) + body)
            count += 1
    print(f"{count} seeds in {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
