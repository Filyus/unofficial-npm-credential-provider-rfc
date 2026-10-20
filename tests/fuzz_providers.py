"""Fuzz the reference providers for as long as asked.

    python -m tests.fuzz_providers --seconds 600 [--seed N] [--no-hostile]
                                   [--providers gitlab,npmjs] [--out DIR]
    python -m tests.fuzz_providers --replay DIR/some-repro.json

It runs the sessions of tests/provider_harness.py with random seeds, from
random scenarios, the valid-request sessions and, unless --no-hostile, the
hostile lines too, until the time is up. A session that breaks an invariant
is shrunk to the few steps that still break it and written to --out as a JSON
repro (the scenario, the seed, the steps, the violation, the lines sent);
--replay runs one again. Every run prints the master seed first, so a run
can be repeated. Exit status 1 if anything broke, 2 if the harness did.
"""

from __future__ import annotations

import argparse
import collections
import json
from pathlib import Path
import random
import sys
import time

from tests.provider_harness import (
    INVARIANTS,
    Violation,
    all_indices,
    node_available,
    repro,
    run_session,
    scenarios,
    shrink,
)

PER_KIND_LIMIT = 3


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seconds", type=float, default=60)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--no-hostile", action="store_true")
    parser.add_argument("--providers", default="")
    parser.add_argument("--out", type=Path, default=Path("fuzz-findings"))
    parser.add_argument("--replay", type=Path)
    parser.add_argument("--stop-after", type=int, default=0, metavar="N", help="stop after N violations (0: run to time)")
    parser.add_argument("--deadline", type=float, default=10, help="seconds a provider has to answer a line")
    args = parser.parse_args(argv)
    if not node_available():
        print("node is not installed", file=sys.stderr)
        return 2

    listed = scenarios()
    if args.replay:
        saved = json.loads(args.replay.read_text(encoding="utf-8"))
        name, file = saved["scenario"]
        transcript = next(path for each, path in listed if each == name and path.name == file)
        violation, _ = run_session(name, transcript, saved["seed"], saved["steps"], hostile=saved["hostile"],
                                   deadline=args.deadline)
        print(violation or "no violation")
        return 1 if violation else 0

    wanted = {name for name in args.providers.split(",") if name}
    listed = [(name, path) for name, path in listed if not wanted or name in wanted]
    master = args.seed if args.seed is not None else random.SystemRandom().getrandbits(32)
    chooser = random.Random(master)
    print(f"master seed {master}: {len(listed)} scenarios, {args.seconds:g} s, "
          f"{'valid and hostile' if not args.no_hostile else 'valid'} sessions", flush=True)
    args.out.mkdir(parents=True, exist_ok=True)

    started = time.monotonic()
    sessions = 0
    found: collections.Counter[tuple[str, str]] = collections.Counter()
    while time.monotonic() - started < args.seconds and not (args.stop_after and sum(found.values()) >= args.stop_after):
        name, transcript = chooser.choice(listed)
        seed = chooser.getrandbits(32)
        hostile = not args.no_hostile and chooser.random() < 0.8
        violation, session = run_session(name, transcript, seed, all_indices(), hostile=hostile,
                                         deadline=args.deadline)
        sessions += 1
        if not violation:
            continue
        key = (violation.invariant, name)
        found[key] += 1
        print(f"\nVIOLATION [{violation.invariant}] {session.label} hostile={hostile}", flush=True)
        if found[key] > PER_KIND_LIMIT:
            print("  (already have enough of these; not shrunk)")
            continue
        steps, small = shrink(name, transcript, seed, all_indices(), violation, hostile=hostile,
                              deadline=args.deadline)
        _, small_session = run_session(name, transcript, seed, steps, hostile=hostile, deadline=args.deadline)
        path = args.out / f"{small.invariant}-{name}-{transcript.stem}-{seed}.json"
        path.write_text(json.dumps(repro(name, transcript, seed, steps, small, small_session, hostile=hostile),
                                   indent=2) + "\n", encoding="utf-8")
        print(f"  shrunk to {len(steps)} steps: {steps}\n  {small.detail[:500]}\n  repro: {path}", flush=True)

    print(f"\n{sessions} sessions in {time.monotonic() - started:.0f} s, master seed {master}")
    if found:
        for (invariant, name), count in sorted(found.items()):
            print(f"  {count} x [{invariant}] {name}: {INVARIANTS.get(invariant, '')}")
        return 1
    print("no invariant broken")
    return 0


def main(argv: list[str] | None = None) -> int:
    """Exit status 2 for an error in the harness itself (a missing tool, a bridge that
    died): an invariant that broke is 1, and the two are not the same finding."""
    try:
        return run(argv)
    except Exception:  # noqa: BLE001
        import traceback

        traceback.print_exc()
        print("the harness itself failed; this is not an invariant that broke", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
