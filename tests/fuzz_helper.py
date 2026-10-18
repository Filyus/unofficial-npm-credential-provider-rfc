"""Fuzz what the Phase 1 prototype makes of what a token helper printed.

    python -m tests.fuzz_helper --prototype ../npm-registry-fetch [--seconds 60] [--seed N]

A helper's stdout is the credential and its stderr is shown to the user, so
two things are checked against the Python model and against what Phase 1 says:

- `header`: the Authorization value the prototype (lib/token-helper.js
  `toHeader`) makes of the output is the one the model
  (`token_helper_header`) makes of it, or both refuse it, and a refusal
  quotes none of the output;
- `log`: what the prototype logs of stderr (`scrub`, then lines, control
  characters out, `mask`: poc/helper-fuzz/bridge.js runs them in that order)
  holds no control character, never the helper's token, whole or in the
  pieces after its scheme, nor that token as JSON writes it, and, for output
  the prototype refused, none of its long runs of printable characters.

Needs `node`. Exit status 1 if anything was found.
"""

from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path
import random
import re
import subprocess
import sys
import time
import urllib.parse
from typing import Any

from tests.protocol_model import JS_WHITESPACE, TokenHelperFailure, token_helper_header

ROOT = Path(__file__).resolve().parents[1]
BRIDGE = ROOT / "poc" / "helper-fuzz" / "bridge.js"

HEX = "0123456789abcdef"
BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
BASE64 = BASE64URL.replace("-_", "+/") + "="
PRINTABLE = "".join(chr(code) for code in range(0x21, 0x7F))
ODD = "".join(chr(code) for code in range(0x21, 0x7F) if chr(code) in "\"'\\`${}()[]<>|&;:,=%*?!~^# /+@.")
SCHEMES = ["Bearer", "bearer", "BEARER", "Basic", "Token", "Digest", "X-Custom", "Bearer\t", "B", "Bear er", "Bearer1", ""]
SPACES = list(JS_WHITESPACE) + ["\x1c", "\x1d", "\x1e", "\x1f", "\x85", "᠎", "​", "\x00", "\x1b", "\x7f"]
NOISE = ["é", "日本", "😀", "\x1b[31m", "\x1b[0m", "\x00", "\x07", "\x08", "\x9b", "\x80", "‮", "�", "\ud800"]


def token(rng: random.Random) -> str:
    alphabet = rng.choice([HEX, BASE64URL, BASE64, BASE64URL + ".", PRINTABLE, BASE64URL + ODD, PRINTABLE + " "])
    return "".join(rng.choice(alphabet) for _ in range(rng.choice([1, 3, 7, 8, 9, 20, 40, 120, 2000])))


def stdout_text(rng: random.Random) -> str:
    parts: list[str] = []
    parts.append("".join(rng.choice(SPACES) for _ in range(rng.choice([0, 0, 1, 2, 5]))))
    scheme = rng.choice(SCHEMES)
    if scheme:
        parts.append(scheme + rng.choice([" ", " ", "  ", "\t", " ", ""]))
    parts.append(token(rng))
    for _ in range(rng.choice([0, 0, 0, 1, 2])):
        parts.append(rng.choice(NOISE + ["\n", "\r\n", " ", "\n" + token(rng)]))
    parts.append("".join(rng.choice(SPACES) for _ in range(rng.choice([0, 0, 1, 2, 5]))))
    return "".join(parts)


def stdout_bytes(rng: random.Random) -> bytes:
    raw = stdout_text(rng).encode("utf-8", "surrogatepass")
    if rng.random() < 0.08:
        at = rng.randrange(len(raw) + 1)
        raw = raw[:at] + rng.choice([b"\xff", b"\xc3\x28", b"\xe2\x82", b"\xed\xa0\x80", b"\xef\xbb\xbf", b"\x00"]) + raw[at:]
    return raw


def decode(raw: bytes) -> str:
    return raw.decode("utf-8", "replace")


def forms(secret: str) -> set[str]:
    """The ways a helper that echoes its credential may write it: as JSON (both
    ways, with a quote, a backslash or a control character escaped, and in
    ASCII), inside a shell's single quotes (`set -x`) or double quotes, and
    percent-encoded as a URL has it."""
    return {
        json.dumps(secret, ensure_ascii=ascii_)[1:-1] for ascii_ in (True, False)
    } | {
        secret.replace("'", "'\\''"),
        re.sub(r'(["$`\\])', r"\\\1", secret),
        urllib.parse.quote(secret, safe=""),
    }


def stderr_text(rng: random.Random, secret: str, bare: str) -> str:
    """What a helper might say, with its own credential in it."""
    templates = [
        "{s}", "{b}", "Authorization: {s}", "Authorization: Bearer {b}", "authorization={s}",
        'curl -H "Authorization: {s}" https://r.test/', '{{"token":"{j}"}}', '{{"authorizationToken": "{j}"}}',
        "NPM_TOKEN={b}", "--token {b}", "+ echo {s}", "x{b}y", "token: {b}", "Basic {b}", "Bearer {b}",
        "\x1b[31m{s}\x1b[0m", "{s}\r", "'{s}'", '"{s}"', "{s}{s}", "password={b}", "secret: {b}",
        "request failed: 401 for {b}", "{j}", "failed to get {s} (HTTP 500)",
    ]
    lines = []
    for _ in range(rng.randint(1, 4)):
        template = rng.choice(templates)
        encoded = rng.choice(sorted(forms(secret)))
        lines.append(template.format(s=secret, b=bare, j=encoded))
        if rng.random() < 0.3:
            lines.append(rng.choice(["", "ordinary text", "the token was refreshed", "done"] + NOISE))
    return rng.choice(["\n", "\r\n"]).join(lines)


class Case:
    def __init__(self, seed: int) -> None:
        rng = random.Random(seed)
        self.seed = seed
        self.stdout = stdout_bytes(rng)
        trimmed = decode(self.stdout).strip(JS_WHITESPACE)
        self.token = trimmed
        self.bare = re.sub(r"^[A-Za-z]+\s+", "", trimmed)
        self.stderr = stderr_text(rng, trimmed, self.bare).encode("utf-8", "surrogatepass")


def bridge(prototype: Path, requests: list[dict]) -> list[dict]:
    done = subprocess.run(
        ["node", str(BRIDGE), str(prototype)],
        input=("\n".join(json.dumps(request) for request in requests) + "\n").encode(),
        capture_output=True, timeout=600,
    )
    if done.returncode != 0:
        raise RuntimeError(done.stderr.decode("utf-8", "replace")[-800:])
    answers = done.stdout.decode("utf-8").split("\n")[:-1]
    if len(answers) != len(requests):
        raise RuntimeError(f"{len(answers)} answers for {len(requests)} requests")
    return [json.loads(answer) for answer in answers]


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def model_header(raw: bytes) -> str | None:
    try:
        return token_helper_header(0, decode(raw))
    except TokenHelperFailure:
        return None


# JavaScript reads its regex by UTF-16 unit, so a character beyond U+FFFF is two kept units
CONTROL = re.compile(r"[^\t\x20-\x7e\xa0-\U0010ffff]")


def judge(prototype: Path, cases: list[Case]) -> list[dict]:
    headers = bridge(prototype, [{"op": "header", "stdout": b64(case.stdout)} for case in cases])
    logs = bridge(prototype, [{"op": "log", "stdout": b64(case.stdout), "stderr": b64(case.stderr)} for case in cases])
    found = []
    for case, header, log in zip(cases, headers, logs):
        expected = model_header(case.stdout)
        got = header.get("ok")
        if expected != got:
            found.append({"kind": "header", "case": case, "model": expected, "prototype": header})
        if got is None and case.token and case.token in header.get("err", ""):
            found.append({"kind": "refusal quotes the output", "case": case, "prototype": header})
        shown = "\n".join(log["lines"])
        secrets = {case.token, case.bare}
        # a refused output never appears whole in stderr, so its long runs are hidden
        if expected is None:
            cleaned = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", " ", case.token)
            secrets |= {run for run in re.split(r"[^\x21-\x7e]+", cleaned) if len(run) >= 8}
        for secret in sorted(secrets):
            # a credential is what can be typed: a lone control character the
            # helper printed is none
            if not secret or not all(" " <= character <= "~" for character in secret) or secret in "***":
                continue
            for form in {secret} | forms(secret):
                if form and form in shown:
                    found.append({"kind": "secret in the log", "case": case, "secret": secret, "form": form, "log": log["lines"]})
                    break
        if any(CONTROL.search(line) for line in log["lines"]):
            found.append({"kind": "control character in the log", "case": case, "log": log["lines"]})
    return found


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--prototype", type=Path, required=True, help="the npm-registry-fetch checkout with the prototype")
    parser.add_argument("--seconds", type=float, default=30)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--batch", type=int, default=2000)
    args = parser.parse_args(argv)
    master = args.seed if args.seed is not None else random.SystemRandom().getrandbits(32)
    chooser = random.Random(master)
    print(f"master seed {master}", flush=True)
    started, tried, kinds = time.monotonic(), 0, {}
    while time.monotonic() - started < args.seconds:
        cases = [Case(chooser.getrandbits(32)) for _ in range(args.batch)]
        tried += len(cases)
        for finding in judge(args.prototype, cases):
            current = kinds.get(finding["kind"])
            if current is None or len(finding["case"].stdout) + len(finding["case"].stderr) < len(current["case"].stdout) + len(current["case"].stderr):
                kinds[finding["kind"]] = finding
    print(f"{tried} outputs in {time.monotonic() - started:.0f} s, master seed {master}")
    for kind, finding in kinds.items():
        case = finding["case"]
        print(f"\n[{kind}] seed {case.seed}\n  stdout {case.stdout[:200]!r}\n  stderr {case.stderr[:300]!r}")
        for key in ("model", "prototype", "secret", "form", "log"):
            if key in finding:
                print(f"  {key}: {str(finding[key])[:300]}")
    if not kinds:
        print("the prototype and the model agreed, and nothing leaked")
    return 1 if kinds else 0


if __name__ == "__main__":
    sys.exit(main())
