from __future__ import annotations

import argparse
import json
import sys
import time


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
        choices=[
            "get-success",
            "not-found",
            "version-mismatch",
            "refresh-success",
            "batch-success",
            "batch-count-mismatch",
            "login-success",
            "logout-success",
            "erase-success",
            "operation-not-supported",
            "other-error",
            "malformed-auth",
            "expires-missing-expiration",
            "invalid-json",
            "no-hello",
            "slow-hello",
            "both-ok-err",
        ],
        default="get-success",
    )
    args = parser.parse_args()

    if args.scenario == "no-hello":
        return 0

    if args.scenario == "slow-hello":
        time.sleep(10)
        return 0

    if args.scenario == "version-mismatch":
        write({"v": [2]})
        return 0

    write({"v": [1]})
    for request in read_requests():
        kind = request.get("kind")
        if args.scenario == "not-found":
            write({"Err": {"kind": "not-found"}})
        elif args.scenario == "operation-not-supported":
            write({"Err": {"kind": "operation-not-supported"}})
        elif args.scenario == "other-error":
            write({"Err": {"kind": "other", "message": "provider failed"}})
        elif args.scenario == "invalid-json":
            sys.stdout.write("{not-json}\n")
            sys.stdout.flush()
        elif args.scenario == "both-ok-err":
            write({"Ok": {"kind": "login"}, "Err": {"kind": "other"}})
        elif args.scenario == "malformed-auth":
            write({"Ok": {"kind": "get", "auth": {"type": "bearer"}, "cache": "session"}})
        elif args.scenario == "expires-missing-expiration":
            write(
                {
                    "Ok": {
                        "kind": "get",
                        "auth": {"type": "bearer", "token": "test-token"},
                        "cache": "expires",
                    }
                }
            )
        elif args.scenario == "batch-success" and kind == "get-batch":
            packages = request.get("packages", [])
            write(
                {
                    "Ok": {
                        "kind": "get-batch",
                        "results": [
                            {
                                "auth": {
                                    "type": "bearer",
                                    "token": f"token-for-{package['package']}",
                                },
                                "granularity": "package",
                            }
                            for package in packages
                        ],
                        "cache": "session",
                    }
                }
            )
        elif args.scenario == "batch-count-mismatch" and kind == "get-batch":
            write(
                {
                    "Ok": {
                        "kind": "get-batch",
                        "results": [
                            {
                                "auth": {"type": "bearer", "token": "only-one"},
                                "granularity": "package",
                            }
                        ],
                        "cache": "session",
                    }
                }
            )
        elif args.scenario in {"login-success", "logout-success", "erase-success"}:
            write({"Ok": {"kind": kind}})
        elif args.scenario == "refresh-success" and kind == "refresh":
            write(
                {
                    "Ok": {
                        "kind": "refresh",
                        "auth": {"type": "bearer", "token": "refreshed-token"},
                        "cache": "expires",
                        "expiresAt": 1893456000,
                        "refreshState": "opaque-provider-handle",
                        "granularity": "scope",
                    }
                }
            )
        else:
            write(
                {
                    "Ok": {
                        "kind": "get",
                        "auth": {"type": "bearer", "token": "test-token"},
                        "cache": "session",
                        "granularity": "scope",
                    }
                }
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
