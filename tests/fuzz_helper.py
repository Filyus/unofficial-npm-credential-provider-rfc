"""Fuzz what the Phase 1a runner makes of what a token helper printed.

    python -m tests.fuzz_helper --prototype ../npm-cli [--seconds 60] [--seed N]

A helper's stdout is the credential and its stderr is shown to the user, so
four things are checked against the Python model and against what Phase 1a
says. The runner is npm/cli's lib/utils/token-helper.js, driven through the
factory npm uses with a stub config (poc/helper-fuzz/bridge.js), with only the
process replaced:

- `header`: the Authorization value the runner makes of the output is the one
  the model (`token_helper_header`) makes of it, or both refuse it, and a
  refusal quotes none of the output;
- `log`: what the runner logs of stderr holds no control character and never
  the helper's exact token, whole or without its scheme, wherever it is in a
  line;
- `setting`: whether the runner takes a `tokenHelper` value is what the model
  (`check_token_helper_config`) says of it, on a tree of real files: an
  absolute path, one with arguments, one that is not there. On Windows only
  the values with no whitespace are compared, since whether a path with
  whitespace in it is there depends on how Win32, Python and libuv each
  normalize a name; Linux and macOS compare them all;
- `route`: what the runner does with a request before any program starts is what
  the model (`token_helper_route_outcome`) says: the helper is not run when the
  command line or the environment gave a credential, over plain `http:` to a host
  that is not this machine (hosts written in the spellings a URL parser folds to
  loopback, and ones that only look like it), or with a route setting a project
  chose; otherwise it starts exactly once. The stub config says which of those
  hold.

What it does not look for is in "Limits" in phase-1a-implementation.md: a
credential that is encoded on purpose (the log check is for the exact token only),
and what no stub config reaches, which files are the user's and where a setting came
from: npm's own tests cover those.

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
from typing import Any

from tests.protocol_model import (
    JS_WHITESPACE,
    ResolutionFailure,
    TokenHelperFailure,
    check_token_helper_config,
    token_helper_header,
    token_helper_route_outcome,
)

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


def stderr_text(rng: random.Random, secret: str, bare: str) -> str:
    """What a helper might say, with its own credential in it exactly as it
    printed it (whole, as `{s}`, or without its scheme, as `{b}`): the one
    thing npm hides. The credential in another form is not generated: a
    helper that encodes it on purpose is not stopped and is not looked for."""
    templates = [
        "{s}", "{b}", "Authorization: {s}", "Authorization: Bearer {b}", "authorization={s}",
        'curl -H "Authorization: {s}" https://r.test/', '{{"token":"{b}"}}',
        "NPM_TOKEN={b}", "--token {b}", "+ echo {s}", "x{b}y", "token: {b}", "Basic {b}", "Bearer {b}",
        "\x1b[31m{s}\x1b[0m", "{s}\r", "'{s}'", '"{s}"', "{s}{s}", "password={b}", "secret: {b}",
        "request failed: 401 for {b}", "failed to get {s} (HTTP 500)",
    ]
    lines = []
    for _ in range(rng.randint(1, 4)):
        template = rng.choice(templates)
        lines.append(template.format(s=secret, b=bare))
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
        # what the text around a hidden credential is, with the credential as ***:
        # a short credential may be part of an ordinary word next to it, as `er *`
        # is of `Bearer ***`, and that is no leak
        around = case.stderr.decode("utf-8", "replace")
        for hidden in sorted({secret for secret in secrets if secret}, key=len, reverse=True):
            around = around.replace(hidden, "***")
        for secret in sorted(secrets):
            # a credential is what can be typed and seen: one with a control, a
            # format (U+180E) or a space other than " " in it is not looked for.
            # Text beyond ASCII that prints (an accented or an emoji credential)
            # is looked for like any other. U+FFFD is what invalid bytes decode
            # to, a decoding artifact and not something typed
            if not secret or not secret.isprintable() or "\ufffd" in secret or secret in "***":
                continue
            if secret in shown and secret not in around:
                found.append({"kind": "secret in the log", "case": case, "secret": secret, "log": log["lines"]})
        if any(CONTROL.search(line) for line in log["lines"]):
            found.append({"kind": "control character in the log", "case": case, "log": log["lines"]})
    return found


# --- the setting: which paths are a helper -----------------------------------------

PREFIXES = ["", "", "", " ", "\t", "rel/", "./", "../", "~/", "C:", "C:x", "\\\\?\\", "file:///", "$HOME/", "%USERPROFILE%\\",
            "\\", "/", "C:\\", "C:/"]
SUFFIXES = ["", "", "", " arg", " --flag value", "\t", "\targ", "\u00a0arg", " ", "  ", "\u2003x", "\ufeffx", "\n", " \"quoted arg\"",
            "\u180ex", "\u200bx", "x y z", " .exe", ".cmd", ".sh"]


def path_fixture(root: Path) -> list[str]:
    """Files and directories to point at, some with whitespace in their names."""
    made = []
    for relative, is_dir in (("bin/aws", False), ("bin/aws cli", False), ("dir with space/tool", False),
                             ("a b", False), ("x/y z", False), ("empty dir", True), ("t\tab", False)):
        target = root / relative
        try:
            if is_dir:
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("#!/bin/sh\n", encoding="utf-8")
        except OSError:
            continue  # a name this file system will not take
        made.append(str(target))
    return made


def path_cases(rng: random.Random, existing: list[str], count: int) -> list[str]:
    values = []
    for _ in range(count):
        base = rng.choice(existing + [str(Path(existing[0]).parent / "nope"), "/usr/bin/env", "C:\\Windows\\System32\\cmd.exe", "tool"])
        prefix = rng.choice(PREFIXES) if rng.random() < 0.35 else ""
        suffix = rng.choice(SUFFIXES)
        value = prefix + base + suffix
        if rng.random() < 0.1:
            at = rng.randrange(len(value) + 1)
            value = value[:at] + rng.choice([" ", "\t", "/", "\\", "\u00a0", "\u2028"]) + value[at:]
        if re.match(r"^[/\\]{2}", value) and any(char in JS_WHITESPACE for char in value):
            # a UNC path with whitespace in it would make the file system look for a
            # server, and a verbatim (`\\?\`) or device path has an error mapping of its
            # own in libuv that the model does not copy
            continue
        if sys.platform == "win32" and any(char in JS_WHITESPACE for char in value):
            # whether a path with whitespace in it is there is up to the file system, and
            # Win32, Python and libuv each normalize a name differently (a space or a dot
            # at the end of a segment, a slash after a file, a verbatim path): on Windows
            # only the part that touches no file is compared, and the rest on Linux and macOS
            continue
        values.append(value)
    return values


def model_refusal(value: str) -> str:
    """What the model says of a tokenHelper setting from user config: ok, abs
    (not an absolute path, or one with arguments) or notfound. The model takes
    an absolute path to be either form's; Node, on a platform that has one
    form, takes only that form's."""
    if sys.platform != "win32" and not value.startswith("/"):
        return "abs"
    try:
        check_token_helper_config(value, "user")
    except ResolutionFailure as failure:
        return "notfound" if "not found" in str(failure) else "abs"
    return "ok"


def judge_paths(prototype: Path, values: list[str]) -> list[dict]:
    answers = bridge(prototype, [{"op": "config", "value": value} for value in values])
    found = []
    for value, answer in zip(values, answers):
        refused = answer["refused"]
        got = "ok" if refused is None else "notfound" if "not found" in refused else "abs"
        expected = model_refusal(value)
        if got != expected:
            found.append({"kind": "setting", "value": value, "prototype": got, "model": expected})
    return found


# --- the route: whether a request gets the helper at all ---------------------------

# a host as written in a URL, and as the parsed URL reads it (what the runner sees):
# lowercased, an IPv4 address in its dotted form, an IPv6 address shortened, in brackets
ROUTE_HOSTS = [
    ("localhost", "localhost"), ("LOCALHOST", "localhost"), ("127.0.0.1", "127.0.0.1"), ("127.1", "127.0.0.1"),
    ("127.255.255.254", "127.255.255.254"), ("0x7f.0.0.1", "127.0.0.1"), ("2130706433", "127.0.0.1"),
    ("[::1]", "[::1]"), ("[0:0:0:0:0:0:0:1]", "[::1]"), ("[::ffff:127.0.0.1]", "[::ffff:7f00:1]"),
    ("localhost.", "localhost."), ("0.0.0.0", "0.0.0.0"), ("127.0.0.1.example.com", "127.0.0.1.example.com"),
    ("localhost.example.com", "localhost.example.com"), ("example.com", "example.com"),
    ("Registry.Corp.Example", "registry.corp.example"), ("10.0.0.1", "10.0.0.1"), ("192.168.1.5", "192.168.1.5"),
    ("[fe80::1]", "[fe80::1]"), ("128.0.0.1", "128.0.0.1"), ("126.255.255.255", "126.255.255.255"),
]
ROUTE_SCHEMES = [("http", "http:"), ("HTTP", "http:"), ("https", "https:"), ("HTTPS", "https:")]
ROUTE_KEYS = ["proxy", "https-proxy", "ca", "cafile", "strict-ssl"]


def route_cases(rng: random.Random, count: int) -> list[dict]:
    cases = []
    for _ in range(count):
        written, scheme = rng.choice(ROUTE_SCHEMES)
        host, hostname = rng.choice(ROUTE_HOSTS)
        port = rng.choice(["", "", ":8080", ":4873", ":80", ":443"])
        keys = rng.sample(ROUTE_KEYS, rng.choice([0, 0, 1, 2]))
        cases.append({
            "uri": f"{written}://{host}{port}{rng.choice(['/', '/pkg', '/@scope%2fpkg', '/pkg/-/pkg-1.0.0.tgz'])}",
            "scheme": scheme, "hostname": hostname, "given": rng.random() < 0.2, "keys": keys,
        })
    return cases


def judge_routes(prototype: Path, cases: list[dict]) -> list[dict]:
    answers = bridge(prototype, [{
        "op": "route", "uri": case["uri"], "given": ["//bridge.example/:_authToken"] if case["given"] else [],
        "transport": [{"key": key, "source": "a .npmrc"} for key in case["keys"]],
    } for case in cases])
    found = []
    for case, answer in zip(cases, answers):
        expected = token_helper_route_outcome(case["scheme"], case["hostname"], case["given"], tuple(case["keys"]))
        started = 1 if expected == "ran" else 0
        if answer["outcome"] != expected or answer["started"] != started:
            found.append({
                "kind": "route", "value": f"{case['uri']} given={case['given']} keys={case['keys']}",
                "prototype": f"{answer['outcome']}, {answer['started']} started", "model": f"{expected}, {started} started",
            })
    return found


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--prototype", type=Path, required=True, help="the npm-cli checkout with the prototype")
    parser.add_argument("--seconds", type=float, default=30)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--batch", type=int, default=2000)
    args = parser.parse_args(argv)
    master = args.seed if args.seed is not None else random.SystemRandom().getrandbits(32)
    chooser = random.Random(master)
    print(f"master seed {master}", flush=True)
    started, tried, settings, routes, kinds = time.monotonic(), 0, 0, 0, {}
    import tempfile

    with tempfile.TemporaryDirectory(prefix="helper-paths-") as scratch:
        existing = path_fixture(Path(scratch))
        while time.monotonic() - started < args.seconds:
            cases = [Case(chooser.getrandbits(32)) for _ in range(args.batch)]
            tried += len(cases)
            findings = judge(args.prototype, cases)
            values = path_cases(chooser, existing, 800)
            settings += len(values)
            findings += judge_paths(args.prototype, values)
            requests = route_cases(chooser, 400)
            routes += len(requests)
            findings += judge_routes(args.prototype, requests)
            for finding in findings:
                size = lambda item: len(item["case"].stdout) + len(item["case"].stderr) if "case" in item else len(item["value"])
                current = kinds.get(finding["kind"])
                if current is None or size(finding) < size(current):
                    kinds[finding["kind"]] = finding
    print(f"{tried} outputs, {settings} settings and {routes} requests in {time.monotonic() - started:.0f} s, master seed {master}")
    for kind, finding in kinds.items():
        case = finding.get("case")
        if case:
            print(f"\n[{kind}] seed {case.seed}\n  stdout {case.stdout[:200]!r}\n  stderr {case.stderr[:300]!r}")
        else:
            print(f"\n[{kind}] {finding['value']!r}")
        for key in ("model", "prototype", "secret", "log"):
            if key in finding:
                print(f"  {key}: {str(finding[key])[:300]}")
    if not kinds:
        print("the prototype and the model agreed, and nothing leaked")
    return 1 if kinds else 0


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
