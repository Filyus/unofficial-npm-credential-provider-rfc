"""Fuzz the readers of the protocol against each other, for as long as asked.

    python -m tests.fuzz_messages --seconds 600 [--seed N] [--batch 3000] [--out DIR]

Makes messages (tests/differential.py): a hello, a request or a response from
the transcripts with fields dropped, retyped, added and respelled and bytes
mangled; has the JSON schema, the Python model, the Rust crate and the
JavaScript providers say whether each is acceptable; and reports every kind
of case on which they do not all agree, or on which one of them crashes. Each
kind is shrunk to the operations that matter and written to --out as JSON.
Needs `cargo` and `node`. Exit status 1 if the readers disagreed.
"""

from __future__ import annotations

import argparse
import base64
import collections
import json
from pathlib import Path
import random
import sys
import time

from tests import differential as d


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seconds", type=float, default=60)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--batch", type=int, default=3000)
    parser.add_argument("--out", type=Path, default=Path("fuzz-findings"))
    args = parser.parse_args(argv)

    master = args.seed if args.seed is not None else random.SystemRandom().getrandbits(32)
    chooser = random.Random(master)
    print(f"master seed {master}: batches of {args.batch}, {args.seconds:g} s", flush=True)
    args.out.mkdir(parents=True, exist_ok=True)
    pool = d.bases()
    started = time.monotonic()
    tried = 0
    kinds: dict[tuple, dict] = {}
    counts: collections.Counter[tuple] = collections.Counter()
    while time.monotonic() - started < args.seconds:
        cases = d.generate(chooser.getrandbits(32), args.batch, pool)
        tried += len(cases)
        for entry in d.judge(cases):
            signature = d.signature(entry)
            counts[signature] += 1
            if signature not in kinds:
                kinds[signature] = entry

    print(f"\n{tried} messages in {time.monotonic() - started:.0f} s, master seed {master}")
    if not kinds:
        print("the four readers agreed on all of them")
        return 0
    for signature, entry in kinds.items():
        def same(case: d.Case, signature=signature) -> bool:
            found = d.judge([case])
            return bool(found) and d.signature(found[0]) == signature

        small = d.shrink_case(entry["case"], same)
        verdicts = d.judge([small])[0]["verdicts"]
        role = small.role
        name = f"{role}-{'-'.join(f'{reader}_{d.short(v)}' for reader, v in sorted(verdicts.items()))}"
        path = args.out / f"{name}.json"
        path.write_text(json.dumps({
            "role": role,
            "message": small.text.decode("utf-8", "backslashreplace"),
            "bytes": base64.b64encode(small.text).decode("ascii"),
            "verdicts": verdicts,
            "ops": small.ops,
        }, indent=2) + "\n", encoding="utf-8")
        print(f"\n{counts[signature]} x {role}: {verdicts}\n  {small.text[:300]!r}\n  repro: {path}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
