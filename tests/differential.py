"""Four readers of one protocol, given the same messages.

A message of the protocol (a hello, a request or a response) is accepted or
refused by the JSON schema (spec/protocol-v1.schema.json), by the Python model
of the client (tests/protocol_model.py), by the Rust crate (poc/rust, through
its `classify` example) and, for requests, by the JavaScript providers
(examples/providers/lib/classify.js). The four are written by hand from the
same text, so where they differ one of them, or the text, is wrong. This
module makes the messages (a valid one of each role from the transcripts, with
fields dropped, retyped, added and respelled, and bytes mangled), asks each
reader, and reports every case on which they do not all say the same.

Verdicts are `ok`, `err`, `skip` (the JavaScript bridge does not read this role),
`crash` (the Python model raised something that is not a protocol violation) and
`panic` (Rust). A reader that cannot read a case is left out of it: see `applies`.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
import random
import re
import subprocess
from typing import Any

from tests.generated_policy import SUPPORTED_OPERATIONS
from tests.protocol_model import (
    CredentialClientModel,
    ProtocolViolation,
    ProviderConfig,
    ProviderFailure,
    load_transcript,
    validate_hello,
    validate_request,
)

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((ROOT / "spec" / "protocol-v1.schema.json").read_text(encoding="utf-8"))
CLASSIFY_JS = ROOT / "examples" / "providers" / "lib" / "classify.js"
RUST = ROOT / "poc" / "rust"
ROLES = ("hello", "request", "response")
KNOWN_KINDS = {"login", "logout", "get", "erase"}
GET = {"v": 1, "kind": "get", "registry": "https://registry.example.test/", "operation": "read",
       "command": "install", "interactive": False}

FIELD_VALUES: dict[str, list[Any]] = {
    "v": [0, 1, 2, -1, 1.0, 1.5, "1", True, None, [1], [2], [], [1, 1], [1, 2], ["1"], [1.5], [-1], [2**32], [2**32 + 1],
          [True], [None], [[1]], 2**64, 1e0, 10**30],
    "kind": ["get", "login", "logout", "erase", "Get", "", "constructor", "refresh", None, 1, ["get"]],
    "operation": sorted(SUPPORTED_OPERATIONS) + ["Read", "", "frobnicate", "constructor", None, 1],
    "granularity": ["registry", "scope", "package", "Registry", "", "global", None, 1, ["scope"]],
    "registry": ["", "x", "https://x/", "http://[", None, 1, ["https://x/"], "https://registry.example.test/\u0000"],
    "scope": ["@a", "@", "a", "@a/b", "", None, 1, "@ü", "@a\n"],
    "package": ["", "x", None, 1, ["x"]],
    "version": ["", "1.0.0", None, 1],
    "command": ["", "install", None, 1, "x" * 300],
    "interactive": [True, False, None, 0, 1, "true"],
    "retry": [True, False, None, 0, "true"],
    "httpStatus": [99, 100, 401, 403, 599, 600, 200.5, "200", True, None, -1, 2**40, 401.0],
    "authChallenges": [[], ["Bearer"], [1], [None], "Bearer", None, {}, [["x"]]],
    "token": ["", "t", None, 1, " "],
    "capabilities": [[], ["login"], ["x"], [1], None, "login", {}],
    "registries": [[], ["https://x/"], ["https://x/", "https://x/"], ["http://a@b/"], ["https://x/?q"], ["ftp://x/"],
                   ["HTTPS://x/"], [""], [1], None, "https://x/", ["https://x\\y/"], ["https://x/ y"], ["https://"],
                   ["https://x//"], ["https://x/a#b"], ["https://x:99999/"]],
    "type": ["bearer", "basic", "Bearer", "", None, 1, "digest"],
    "username": ["", "u", None, 1],
    "password": ["", "p", None, 1],
    "auth": [None, {}, [], "x", {"type": "bearer"}, {"type": "bearer", "token": "t"}, {"type": "basic"}],
    "cache": ["never", "session", "expires", "Expires", "", None, 1, ["session"]],
    "expiresAt": [0, 1, 2**53, 2**63, 2**64, -1, 1.5, "1", None, True, 1e3, 1700000000.0],
    "operationIndependent": [True, False, None, 0, 1, "true"],
    "message": ["", "x", None, 1, ["x"]],
    "causedBy": [[], ["x"], [1], None, "x"],
    "Ok": [{"kind": "get", "auth": {"type": "bearer", "token": "t"}}, {"kind": "get"}, {}, None, [], "Ok"],
    "Err": [{"kind": "other"}, {"kind": "not-found", "message": "m"}, {}, None, [], "Err", {"kind": "frobnicate"}],
}
LOUD: list[Any] = [None, True, False, 0, 1, -1, 2**53, 1.5, "", " ", "x", [], {}, [1], ["a"], {"a": 1}, "\u0000", "\ud800",
                   "é", "x" * 3000]


class Case:
    """A role, the base message it was made from, the operations that turn it
    into the message tried, and the text. `ops` are plain data so that a
    failing case can be shrunk by leaving some out."""

    def __init__(self, role: str, base: dict, ops: list[list]) -> None:
        self.role, self.base = role, base
        text, self.ops = apply_ops(base, ops)
        # one message to a line: a newline would be two
        self.text = text.replace(b"\n", b" ")

    def line(self) -> bytes:
        return self.role.encode() + b"\t" + self.text


def paths(value: Any, prefix: tuple = ()) -> list[tuple]:
    found = [prefix] if prefix else []
    if isinstance(value, dict):
        for key, item in value.items():
            found += paths(item, prefix + (key,))
    elif isinstance(value, list):
        for index, item in enumerate(value[:3]):
            found += paths(item, prefix + (index,))
    return found


def get_at(value: Any, path: tuple) -> Any:
    for step in path:
        value = value[step]
    return value


def apply_ops(base: dict, ops: list[list]) -> tuple[bytes, list[list]]:
    """The text the operations make, and the ones that did something: an
    operation whose path is not in this message leaves no trace, and a shrunk
    case or a saved repro must not name it."""
    message: Any = copy.deepcopy(base)
    text_ops = []
    applied = []
    for op in ops:
        kind = op[0]
        try:
            if kind == "drop":
                parent = get_at(message, tuple(op[1][:-1]))
                if isinstance(parent, dict) and op[1][-1] in parent:
                    del parent[op[1][-1]]
                elif isinstance(parent, list) and isinstance(op[1][-1], int) and op[1][-1] < len(parent):
                    del parent[op[1][-1]]
                else:
                    continue
            elif kind == "set":
                parent = get_at(message, tuple(op[1][:-1]))
                if op[1]:
                    parent[op[1][-1]] = copy.deepcopy(op[2])
                else:
                    message = copy.deepcopy(op[2])
            elif kind == "add":
                parent = get_at(message, tuple(op[1]))
                if not isinstance(parent, dict):
                    continue
                parent[op[2]] = copy.deepcopy(op[3])
            else:
                text_ops.append(op)
            applied.append(op)
        except (KeyError, IndexError, TypeError):
            continue
    text = json.dumps(message, ensure_ascii=op_flag(ops)).encode("utf-8", "surrogatepass")
    for op in text_ops:
        text = text_op(text, op)
    return text, applied


def op_flag(ops: list[list]) -> bool:
    return not any(op[0] == "utf8" for op in ops)


def text_op(text: bytes, op: list) -> bytes:
    kind = op[0]
    if kind == "respell":
        # a number of the message, written another way
        tokens = list(NUMBER.finditer(text))
        if not tokens:
            return text
        token = tokens[op[1] % len(tokens)]
        return text[:token.start()] + op[2].encode() + text[token.end():]
    if kind == "rawmember":
        # a member written as text, so that it can be what Python would not dump
        body = text.rstrip()
        if body.endswith(b"}"):
            separator = b"" if body.endswith(b"{") else b","
            return body[:-1] + separator + json.dumps(op[1]).encode() + b":" + op[2].encode("utf-8", "surrogatepass") + b"}"
        return text
    if kind == "bytes":
        position, replacement = op[1], bytes.fromhex(op[2])
        position = position % (len(text) + 1)
        return text[:position] + replacement + text[position + op[3]:]
    return text


NUMBER = re.compile(rb"(?<=[:\[,])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?")
RAW_MEMBERS = ["1e400", "-1e400", "1E999", "0.1e-999", "1e308", "123456789012345678901234567890", '"\\ud800"',
               '"\\udc00x"', '"\\ud800\\udc00"', "[1e400]", '{"a":1e400}', '{"\\ud800":1}', "-0", "-0.0", "1e-400", "[[[[[]]]]]"]
RESPELLINGS = ["1.0", "1e0", "10e-1", "0.1e1", "-0", "1E+0", "1.00000000000000000001", "01", "+1", ".1e1", "1.", "0x1",
               "100000000000000000000", "1e400"]


def random_ops(rng: random.Random, base: dict) -> list[list]:
    ops: list[list] = []
    every = paths(base)
    for _ in range(rng.randint(1, 3)):
        choice = rng.randrange(11)
        if choice == 10:
            ops.append(["rawmember", rng.choice(list(FIELD_VALUES) + ["x", "extra"]), rng.choice(RAW_MEMBERS)])
        elif choice == 0 and every:
            ops.append(["drop", list(rng.choice(every))])
        elif choice in (1, 2, 3) and every:
            path = rng.choice(every)
            value = rng.choice(FIELD_VALUES.get(str(path[-1]), []) + LOUD) if rng.random() < 0.8 else rng.choice(LOUD)
            ops.append(["set", list(path), value])
        elif choice == 4:
            container = rng.choice([()] + [p for p in every if isinstance(get_at(base, p), dict)])
            key = rng.choice(list(FIELD_VALUES) + ["__proto__", "constructor", "x", "\u0000"])
            if ("Ok" in base or "Err" in base) and rng.random() < 0.5:
                key = rng.choice(["Ok", "Err"])  # the envelope: one of them, or both, or a third
            ops.append(["add", list(container), key, rng.choice(FIELD_VALUES.get(key, []) + LOUD)])
        elif choice == 5:
            ops.append(["set", [], rng.choice([None, [], 1, "x", True, [base], {}])])
        elif choice == 6:
            ops.append(["respell", rng.randrange(12), rng.choice(RESPELLINGS)])
        elif choice == 7:
            ops.append(["bytes", rng.randrange(400), bytes([rng.randrange(256)]).hex(), rng.choice([0, 0, 1, 2])])
        elif choice == 8:
            ops.append(["utf8"])
        else:
            ops.append(["bytes", rng.randrange(400), rng.choice([b"", b",", b"}", b"{", b'"', b" ", b"\xef\xbb\xbf"]).hex(),
                        rng.randint(0, 3)])
    return ops


def bases() -> dict[str, list[dict]]:
    found: dict[str, list[dict]] = {role: [] for role in ROLES}
    seen: set[str] = set()
    paths_to_read = sorted((ROOT / "examples").glob("*/*.jsonl")) + sorted((ROOT / "tests" / "transcripts").glob("*.jsonl"))
    for path in paths_to_read:
        hello = True
        for event in load_transcript(str(path)):
            if "message" not in event:
                continue
            role = "request" if event["from"] == "client" else ("hello" if hello else "response")
            if event["from"] == "provider":
                hello = False
            key = role + json.dumps(event["message"], sort_keys=True)
            if key not in seen:
                seen.add(key)
                found[role].append(event["message"])
    return found


# --- the readers ------------------------------------------------------------------


def parse_for_python(text: bytes) -> Any:
    """The parsed message, or None if Python's JSON refuses the text, or
    DUPLICATE for a text that repeats a member name: what a reader does with
    one differs (JSON.parse and Python keep the last, serde refuses), and
    Phase 2 says a sender must not send it."""
    try:
        decoded = text.decode("utf-8")
    except UnicodeDecodeError:
        return None
    repeated = []

    def pairs(members: list) -> dict:
        names = [name for name, _ in members]
        if len(set(names)) != len(names):
            repeated.append(True)
        return dict(members)

    def refuse(constant: str) -> Any:
        raise ValueError(constant)

    try:
        message = json.loads(decoded, object_pairs_hook=pairs, parse_constant=refuse)
    except (ValueError, RecursionError):
        return None
    return DUPLICATE if repeated else message


DUPLICATE = object()


def unrepresentable(value: Any) -> bool:
    """A lone surrogate in a string or member name, or a number beyond a double:
    what the schema cannot say and Phase 2 does."""
    pending = [value]
    while pending:
        value = pending.pop()
        if isinstance(value, str):
            try:
                value.encode("utf-8")
            except UnicodeEncodeError:
                return True
        elif isinstance(value, float):
            if value != value or value in (float("inf"), float("-inf")):
                return True
        elif isinstance(value, list):
            pending.extend(value)
        elif isinstance(value, dict):
            for key, item in value.items():
                pending.append(key)
                pending.append(item)
    return False


def schema_validators():
    import jsonschema

    root = {key: value for key, value in SCHEMA.items() if key != "oneOf"}
    return {
        role: jsonschema.Draft202012Validator({**root, "$ref": f"#/$defs/{'providerResponse' if role == 'response' else role}"})
        for role in ROLES
    }


def verdict_schema(validators, role: str, message: Any) -> str:
    if unrepresentable(message):
        return "err"
    if next(validators[role].iter_errors(message), None) is not None:
        return "err"
    if role == "response" and isinstance(message, dict) and "Ok" in message:
        # the schema cannot say which request an answer is to; the other readers
        # judge it as the answer to a get
        ok = message["Ok"]
        if not isinstance(ok, dict) or ok.get("kind") != "get":
            return "err"
    return "ok"


def verdict_python(role: str, message: Any) -> str:
    try:
        if role == "hello":
            validate_hello(message)
        elif role == "request":
            validate_request(message)
        else:
            client = CredentialClientModel(ProviderConfig())
            client.receive_hello({"v": [1]})
            client.handle_response(GET, message)
        return "ok"
    except ProviderFailure:
        return "ok"  # an Err answer is a well-formed answer
    except ProtocolViolation:
        return "err"
    except Exception as error:  # noqa: BLE001 - anything else is a crash, which is the finding
        return f"crash {type(error).__name__}: {error}"[:200]


def applies(role: str, message: Any) -> dict[str, bool]:
    """Which readers read this case. The Rust crate is the client: a request
    with a kind or an operation it has no name for is one it cannot send."""
    readers = {"schema": True, "python": True, "rust": True, "js": role == "request"}
    if role == "request" and isinstance(message, dict):
        kind, operation = message.get("kind"), message.get("operation")
        known_kind = isinstance(kind, str) and kind in KNOWN_KINDS
        known_operation = "operation" not in message or (isinstance(operation, str) and operation in SUPPORTED_OPERATIONS)
        if not (known_kind and known_operation):
            readers["rust"] = False
    return readers


def rust_verdicts(lines: list[bytes]) -> list[str]:
    return _bridge(["cargo", "run", "-q", "-p", "credential-provider-protocol", "--example", "classify"], lines, RUST)


def js_verdicts(lines: list[bytes]) -> list[str]:
    return _bridge(["node", str(CLASSIFY_JS)], lines, ROOT)


def _bridge(command: list[str], lines: list[bytes], cwd: Path) -> list[str]:
    done = subprocess.run(command, input=b"\n".join(lines) + b"\n", capture_output=True, cwd=cwd, timeout=600)
    if done.returncode != 0:
        raise RuntimeError(f"{command[0]} failed: {done.stderr.decode('utf-8', 'replace')[-800:]}")
    # only newline ends a verdict: an error message may hold a character
    # `str.splitlines` takes for one
    verdicts = done.stdout.decode("utf-8", "replace").split("\n")[:-1]
    if len(verdicts) != len(lines):
        raise RuntimeError(f"{command[0]} answered {len(verdicts)} lines for {len(lines)}")
    return verdicts


def short(verdict: str) -> str:
    return verdict.split("\t")[0].split(" ")[0]


def judge(cases: list[Case]) -> list[dict]:
    """Every case on which the readers that read it do not all agree."""
    validators = schema_validators()
    lines = [case.line() for case in cases]
    rust = rust_verdicts(lines)
    js = js_verdicts(lines)
    disagreements = []
    for case, rust_verdict, js_verdict in zip(cases, rust, js):
        message = parse_for_python(case.text)
        if message is DUPLICATE:
            continue
        if message is None and not _parses(case.text):
            python = schema = "err"
        else:
            schema = verdict_schema(validators, case.role, message)
            python = verdict_python(case.role, message)
        readers = applies(case.role, message)
        verdicts = {"schema": schema, "python": python, "rust": rust_verdict, "js": js_verdict}
        verdicts = {name: verdict for name, verdict in verdicts.items() if readers[name] and verdict != "skip"}
        crashed = [name for name, verdict in verdicts.items() if verdict.startswith(("crash", "panic"))]
        if crashed or len({short(verdict) for verdict in verdicts.values()}) > 1:
            disagreements.append({"case": case, "verdicts": verdicts})
    return disagreements


def _parses(text: bytes) -> bool:
    """Whether the text is JSON at all, apart from what Python makes of it."""
    try:
        json.loads(text.decode("utf-8"), parse_constant=lambda constant: (_ for _ in ()).throw(ValueError(constant)))
        return True
    except (ValueError, RecursionError):
        return False


def generate(seed: int, count: int, pool: dict[str, list[dict]] | None = None) -> list[Case]:
    rng = random.Random(seed)
    pool = pool or bases()
    cases = []
    for _ in range(count):
        role = rng.choice(ROLES)
        base = rng.choice(pool[role])
        cases.append(Case(role, base, random_ops(rng, base)))
    return cases


def shrink_case(case: Case, still: Any) -> Case:
    """Leaves out the operations that do not matter to `still(case)`."""
    ops = list(case.ops)
    for index in range(len(ops) - 1, -1, -1):
        if index >= len(ops):
            continue  # an earlier removal also took the operations that did nothing without it
        trial = ops[:index] + ops[index + 1:]
        if trial and still(Case(case.role, case.base, trial)):
            ops = Case(case.role, case.base, trial).ops
    return Case(case.role, case.base, ops)


def signature(entry: dict) -> tuple:
    """What a disagreement is about, so that a run shows each kind once: the
    role and who said what, with the reasons stripped."""
    return (entry["case"].role, tuple(sorted((name, short(verdict)) for name, verdict in entry["verdicts"].items())))
