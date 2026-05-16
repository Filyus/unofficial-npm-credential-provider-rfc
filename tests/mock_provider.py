from __future__ import annotations

import argparse
import json
import sys


def write(message: dict) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def read_requests():
    for line in sys.stdin:
        if line.strip():
            yield json.loads(line)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--scenario",
        choices=["get-success", "not-found", "version-mismatch", "refresh-success"],
        default="get-success",
    )
    args = parser.parse_args()

    if args.scenario == "version-mismatch":
        write({"v": [2]})
        return 0

    write({"v": [1]})
    for request in read_requests():
        action = request.get("action")
        if args.scenario == "not-found":
            write({"Err": {"kind": "not-found"}})
        elif args.scenario == "refresh-success" and action == "refresh":
            write(
                {
                    "Ok": {
                        "auth": {"type": "bearer", "token": "refreshed-token"},
                        "cache": "expires",
                        "expiresAt": 1893456000,
                        "refreshToken": "opaque-refresh-token",
                        "granularity": "scope",
                    }
                }
            )
        else:
            write(
                {
                    "Ok": {
                        "auth": {"type": "bearer", "token": "test-token"},
                        "cache": "session",
                        "granularity": "scope",
                    }
                }
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
