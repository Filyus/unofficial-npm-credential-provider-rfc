"""Sessions against the reference providers in examples/providers, shared by
the random-session test, the hostile-input test and the long fuzz run
(tests/fuzz_providers.py).

A `Session` starts one provider the way npm does, from the starting state of
one transcript's scenario (examples/providers/scenario.js sets that up), and
sends it requests it generates itself. Step *i* of a session draws on its own
random stream, `Random(f"{seed}:{i}")`, so a run that leaves some steps out
still does what the others did: that is what lets `shrink` cut a failing
session down to the few steps that matter.

What is checked is what the RFC requires of every provider, not exact answers
(see INVARIANTS). A `Violation` names the invariant it broke.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import queue
import random
import subprocess
import tempfile
import threading
from typing import Any, Callable, Iterable

from tests.generated_policy import ERROR_KINDS, OPERATIONS_REQUIRING_VERSION, SUPPORTED_OPERATIONS
from tests.protocol_model import (
    CredentialClientModel,
    ProtocolViolation,
    ProviderConfig,
    ProviderFailure,
    load_transcript,
    validate_request,
    validate_transcript,
)

ROOT = Path(__file__).resolve().parents[1]
SCENARIO = ROOT / "examples" / "providers" / "scenario.js"
STEPS = 20
READ_OPERATIONS = {"read", "stage-read"}
FOREIGN = "https://elsewhere.example.test/"
# operations no version knows; two of them are also names on every JavaScript object
UNKNOWN_OPERATIONS = ["frobnicate", "constructor", "prototype"]
LINE_FLOOR = 1024 * 1024  # Phase 2: a maximum line size of at least 1 MiB

# how the reference providers say a line was rejected before it was a request
REJECTION_PREFIXES = ("malformed request", "a line over")

INVARIANTS = {
    "answer-is-a-response": "every line the provider writes is a JSON object with exactly Ok or Err",
    "model-accepts-answers": "the Python model accepts every answer, and the whole session as a transcript",
    "no-prompt-unattended": "a request that is not interactive asks the person nothing",
    "unknown-is-unsupported": "an unknown operation or kind is operation-not-supported, never served as a read",
    "foreign-registry": "a registry the provider does not serve is url-not-supported",
    "erase-keeps-the-login": "the 401 retry after an erase is not not-found",
    "retry-403-not-found": "a 403 retry is not not-found: nothing else to release is `other`, saying so",
    "no-write-credential-for-a-read": "a 403 on a read does not move to a credential handed out for a write",
    "no-secret-on-stderr": "no secret reaches stderr",
    "exit-0": "the provider exits 0 when stdin closes",
    "in-time": "every line is answered within the deadline",
    "one-answer-per-line": "one answer per request line, none left over",
    "malformed-gets-an-error": "a line that is not a valid request is answered with an error, never Ok",
    "valid-is-not-malformed": "a valid request is not rejected as malformed",
}


class Violation(AssertionError):
    def __init__(self, invariant: str, message: str) -> None:
        super().__init__(f"[{invariant}] {message}")
        self.invariant = invariant
        self.detail = message


def node_available() -> bool:
    try:
        return subprocess.run(["node", "--version"], capture_output=True).returncode == 0
    except FileNotFoundError:
        return False


def scenarios() -> list[tuple[str, Path]]:
    listed = subprocess.run(["node", str(SCENARIO)], capture_output=True, text=True, check=True)
    return [(name, Path(path)) for name, path in (line.split(" ", 1) for line in listed.stdout.splitlines())]


class Lines:
    """A pipe read by a thread, so a silent provider fails the run instead of
    hanging it."""

    def __init__(self, stream, deadline: float) -> None:
        self.queue: queue.Queue[bytes | None] = queue.Queue()
        self.text: list[bytes] = []
        self.deadline = deadline

        def pump() -> None:
            for line in iter(stream.readline, b""):
                self.text.append(line)
                self.queue.put(line)
            self.queue.put(None)

        self.thread = threading.Thread(target=pump, daemon=True)
        self.thread.start()

    def next(self, what: str) -> bytes:
        try:
            line = self.queue.get(timeout=self.deadline)
        except queue.Empty:
            raise Violation("in-time", f"no answer within {self.deadline:g} s, waiting for {what}") from None
        if line is None:
            raise Violation("exit-0", f"the provider's output closed before {what}")
        return line

    def leftover(self) -> list[bytes]:
        lines = []
        while True:
            try:
                line = self.queue.get_nowait()
            except queue.Empty:
                return lines
            if line is not None:
                lines.append(line)


def classify(raw: bytes) -> tuple[str, Any]:
    """What a line is, by the Python model and Python's JSON: ('request', object),
    ('malformed', why), ('oversized', None), or ('unsure', why) where Python and
    JavaScript read JSON differently enough that no answer can be required."""
    if len(raw) > LINE_FLOOR:
        return "oversized", None
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return "malformed", "not UTF-8"
    integral_float = []

    def parse_float(literal: str) -> float:
        value = float(literal)
        if value.is_integer():
            integral_float.append(literal)
        return value

    def refuse(constant: str) -> Any:
        raise ValueError(constant)

    try:
        message = json.loads(text, parse_float=parse_float, parse_constant=refuse)
    except RecursionError:
        return "unsure", "nested too deep for Python"
    except ValueError:
        return "malformed", "not JSON"
    if integral_float:
        # an integer spelled 1.0 or 1e2: the schema allows it, the model does not
        return "unsure", f"integral float {integral_float[0]}"
    if not isinstance(message, dict):
        return "malformed", "not an object"
    try:
        validate_request(message)
    except ProtocolViolation as violation:
        return "malformed", str(violation)
    return "request", message


def response_shape_problem(answer: Any) -> str | None:
    if not isinstance(answer, dict) or set(answer) not in ({"Ok"}, {"Err"}):
        return "not exactly one of Ok or Err"
    if "Err" in answer:
        error = answer["Err"]
        if not isinstance(error, dict) or error.get("kind") not in ERROR_KINDS:
            return f"Err.kind is not one of {sorted(ERROR_KINDS)}"
        if "message" in error and not isinstance(error["message"], str):
            return "Err.message is not a string"
    return None


PROTOTYPE_NAMES = ["constructor", "prototype", "__proto__", "toString", "hasOwnProperty", "valueOf"]
LOUD_VALUES: list[Any] = [
    None, True, False, 0, 1, -1, 2**53, 2**64, 1.5, "", " ", "x", [], {}, [1], ["a"], {"a": 1},
    "constructor", "@", "@/x", "https://", "http://[", "\u0000", "\ud800", "é", "‮", "a\nb", "../..", "%2f",
    "﻿", "Ω" * 40, "x" * 5000, "get", "read", "publish", "\\", '"', "{}", "null",
]
FIELDS = ["v", "kind", "registry", "scope", "package", "version", "operation", "granularity", "command",
          "interactive", "retry", "httpStatus", "token", "authChallenges"]


class Session:
    def __init__(self, name: str, transcript: Path, seed: int, *, hostile: bool = False, deadline: float = 10) -> None:
        self.name = name
        self.seed = seed
        self.hostile = hostile
        self.label = f"{name}/{transcript.name} seed {seed}"
        self.random = random.Random(seed)
        self.sent: list[bytes] = []
        self.helper = subprocess.Popen(
            ["node", str(SCENARIO), "--sessions", str(seed), name, str(transcript)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.helper_out = Lines(self.helper.stdout, 30)
        setup = json.loads(self.helper_out.next("the scenario"))
        self.asked_file = Path(setup["askedFile"])
        self.secrets: set[str] = set(setup["secrets"])
        env = {key: value for key, value in setup["env"].items() if value is not None}
        self.provider = subprocess.Popen(
            ["node", setup["provider"], "--npm-credential-provider", "--config", setup["configFile"]],
            cwd=setup["cwd"], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.out = Lines(self.provider.stdout, deadline)
        self.err = Lines(self.provider.stderr, deadline)
        self.events: list[dict] = []
        self.model = CredentialClientModel(ProviderConfig())
        hello = json.loads(self.out.next("hello"))
        self.events.append({"from": "provider", "message": hello})
        self.model.receive_hello(hello)
        self.hello = hello

        # the transcripts' own get requests: realistic registries, scopes and packages
        self.pool = [
            event["message"]
            for event in load_transcript(str(transcript))
            if event.get("from") == "client" and event.get("message", {}).get("kind") == "get"
        ]
        if not self.pool:
            for other in sorted(transcript.parent.glob("*.jsonl")):
                self.pool += [
                    event["message"]
                    for event in load_transcript(str(other))
                    if event.get("from") == "client" and event.get("message", {}).get("kind") == "get"
                ]
        self.write_tokens: set[str] = set()

    # --- the wire ---------------------------------------------------------------

    def asked(self) -> int:
        return len(self.asked_file.read_text(encoding="utf-8").splitlines()) if self.asked_file.exists() else 0

    def transmit(self, raw: bytes, what: str) -> Any:
        """One line out, one line back, whatever the line is."""
        self.sent.append(raw)
        self.provider.stdin.write(raw + b"\n")
        self.provider.stdin.flush()
        line = self.out.next(what)
        try:
            answer = json.loads(line)
        except ValueError:
            raise Violation("answer-is-a-response", f"{self.label}: {what} was answered with {line[:200]!r}") from None
        return answer

    def send(self, request: dict, raw: bytes | None = None, *, record: bool = True) -> dict:
        validate_request(request)
        if record:
            self.events.append({"from": "client", "message": request})
        asked_before = self.asked()
        if raw is None:
            raw = json.dumps(request).encode("utf-8")
        answer = self.transmit(raw, f"the answer to {request['kind']}")
        if record:
            self.events.append({"from": "provider", "message": answer})
        where = f"{self.label}, request {json.dumps(request)[:300]}, answer {json.dumps(answer)[:300]}"
        problem = response_shape_problem(answer)
        if problem:
            raise Violation("answer-is-a-response", f"{where}: {problem}")
        try:
            self.model.handle_response(request, answer)
        except ProviderFailure:
            pass
        except ProtocolViolation as violation:
            raise Violation("model-accepts-answers", f"{where}: {violation}") from None
        if not request.get("interactive") and self.asked() != asked_before:
            raise Violation("no-prompt-unattended", f"{where}: asked the person on a request that is not interactive")
        if answer.get("Err", {}).get("message", "").startswith(REJECTION_PREFIXES):
            raise Violation("valid-is-not-malformed", f"{where}: a request the model accepts was rejected as malformed")
        auth = answer.get("Ok", {}).get("auth") or {}
        for field in ("token", "password"):
            if isinstance(auth.get(field), str):
                self.secrets.add(auth[field])
        return answer

    def send_hostile(self, raw: bytes) -> None:
        kind, detail = classify(raw)
        if kind == "request":
            # a line the model accepts is a request like any other, though not
            # one in the sequence a transcript is
            self.send(detail, raw, record=False)
            return
        answer = self.transmit(raw, f"the answer to a {kind} line ({len(raw)} bytes)")
        problem = response_shape_problem(answer)
        if problem:
            raise Violation("answer-is-a-response", f"{self.label}: {problem}: {json.dumps(answer)[:300]}")
        if kind in ("malformed", "oversized") and "Err" not in answer:
            raise Violation(
                "malformed-gets-an-error",
                f"{self.label}: a {kind} line ({detail or ''}; {raw[:120]!r}) was answered {json.dumps(answer)[:300]}",
            )

    # --- the generator ----------------------------------------------------------

    def fresh_get(self) -> dict:
        request = dict(self.random.choice(self.pool))
        for field in ("retry", "httpStatus", "authChallenges"):
            request.pop(field, None)
        # mostly what the recorded request asked, so that credentials are
        # handed out and retried; sometimes any operation, now and then one
        # no version knows
        roll = self.random.random()
        if roll < 0.05:
            operation = self.random.choice(UNKNOWN_OPERATIONS)
        elif roll < 0.35:
            operation = self.random.choice(sorted(SUPPORTED_OPERATIONS))
        else:
            operation = request["operation"]
        request["operation"] = operation
        request["interactive"] = self.random.random() < 0.6
        if operation in OPERATIONS_REQUIRING_VERSION and "package" in request:
            request.setdefault("version", "9.9.9")
        elif operation in OPERATIONS_REQUIRING_VERSION:
            request.update(package="widgets", version="9.9.9")
        return request

    def learn_write_tokens(self) -> None:
        """Asks once for each write operation, interactively, so the session
        knows which credentials the provider hands out for writes before it
        checks that a 403 on a read does not move to one."""
        self.random = random.Random(f"{self.seed}:learn")
        base = self.random.choice(self.pool)
        for operation in sorted(SUPPORTED_OPERATIONS - READ_OPERATIONS):
            request = {key: value for key, value in base.items() if key not in ("retry", "httpStatus", "authChallenges")}
            request.update(operation=operation, interactive=True)
            if operation in OPERATIONS_REQUIRING_VERSION:
                request.setdefault("package", "widgets")
                request.setdefault("version", "9.9.9")
            try:
                validate_request(request)
            except ProtocolViolation:
                continue
            ok = self.send(request).get("Ok")
            if ok and ok.get("kind") == "get":
                self.write_tokens.add(ok["auth"].get("token") or ok["auth"].get("password"))

    def step(self, index: int) -> None:
        self.random = random.Random(f"{self.seed}:{index}")
        roll = self.random.random()
        if self.hostile and roll < 0.3:
            self.send_hostile(self.hostile_line())
            return
        roll = self.random.random()
        if roll < 0.08:
            request = {"v": 1, "kind": "get", "registry": FOREIGN, "operation": "read", "command": "install",
                       "interactive": False}
            answer = self.send(request)
            if answer != {"Err": {"kind": "url-not-supported"}}:
                raise Violation("foreign-registry", f"{self.label}: {FOREIGN} answered {answer}")
            return
        if roll < 0.12:
            registry = self.random.choice(self.pool)["registry"]
            answer = self.send({"v": 1, "kind": "refresh", "registry": registry})
            if answer.get("Err", {}).get("kind") != "operation-not-supported":
                raise Violation("unknown-is-unsupported", f"{self.label}: a kind no version knows answered {answer}")
            return
        if roll < 0.18:
            registry = self.random.choice(self.pool)["registry"]
            kind = self.random.choice(["login", "logout"])
            self.send({"v": 1, "kind": kind, "registry": registry, "interactive": self.random.random() < 0.5})
            return

        request = self.fresh_get()
        try:
            validate_request(request)
        except ProtocolViolation:
            return
        answer = self.send(request)
        if request["operation"] in UNKNOWN_OPERATIONS:
            if answer.get("Err", {}).get("kind") != "operation-not-supported":
                raise Violation("unknown-is-unsupported", f"{self.label}: an operation no version knows answered {answer}")
            return
        ok = answer.get("Ok")
        if not ok or ok.get("kind") != "get":
            return
        token = ok["auth"].get("token") or ok["auth"].get("password")
        if request["operation"] not in READ_OPERATIONS:
            self.write_tokens.add(token)

        follow = self.random.random()
        if follow < 0.35:
            # a 401: npm erases what it was handed, then retries once
            erase = {key: request[key] for key in ("v", "registry", "scope", "package", "version", "operation")
                     if key in request}
            erase.update(kind="erase", granularity=ok.get("granularity", "registry"))
            self.send(erase)
            retry = self.send({**request, "retry": True, "httpStatus": 401})
            if retry.get("Err", {}).get("kind") == "not-found":
                raise Violation(
                    "erase-keeps-the-login",
                    f"{self.label}: the 401 retry after erase answered not-found, as if erase had logged out: {request}",
                )
        elif follow < 0.6:
            retry = self.send({**request, "retry": True, "httpStatus": 403})
            if retry.get("Err", {}).get("kind") == "not-found":
                raise Violation(
                    "retry-403-not-found",
                    f"{self.label}: a 403 retry answered not-found; a provider with nothing else to release answers "
                    f"other, saying so: {request}",
                )
            widened = (retry.get("Ok") or {}).get("auth", {})
            widened = widened.get("token") or widened.get("password")
            if request["operation"] in READ_OPERATIONS and token not in self.write_tokens and widened in self.write_tokens:
                raise Violation(
                    "no-write-credential-for-a-read",
                    f"{self.label}: a 403 on a read moved to a credential handed out for a write: {request}",
                )

    # --- hostile lines ----------------------------------------------------------

    def a_value(self) -> Any:
        return self.random.choice(LOUD_VALUES)

    def mutated_request(self) -> dict:
        request = self.fresh_get()
        if self.random.random() < 0.3:
            request.update(retry=True, httpStatus=self.random.choice([401, 403]),
                           authChallenges=['Bearer realm="https://x"'])
        for _ in range(self.random.randint(1, 3)):
            choice = self.random.randrange(7)
            if choice == 0 and request:
                request.pop(self.random.choice(sorted(request)), None)
            elif choice == 1:
                request[self.random.choice(FIELDS)] = self.a_value()
            elif choice == 2:
                request[self.random.choice(PROTOTYPE_NAMES + ["x", "token2", "\u0000"])] = self.a_value()
            elif choice == 3:
                request[self.random.choice(["kind", "operation"])] = self.random.choice(
                    ["constructor", "prototype", "Get", "get ", "", "-x", "0", "read\n", "refresh", "login"])
            elif choice == 4:
                request[self.random.choice(FIELDS)] = self.random.choice([[], {}, [[]], [{}], 0, "0"])
            elif choice == 5:
                request["registry"] = self.random.choice(
                    ["", "elsewhere", FOREIGN, "https://registry.npmjs.org", "HTTPS://REGISTRY.NPMJS.ORG/", "//x/", "\u0000"])
            else:
                request[self.random.choice(["scope", "package", "version"])] = self.random.choice(
                    ["@", "@a/b", "@ü", "a" * 3000, "\ud800", "x\u0000", "../../", "@" + "a" * 3000])
        return request

    def hostile_line(self) -> bytes:
        generators = [
            (40, self.line_mutated_fields),
            (25, self.line_mangled),
            (8, self.line_not_a_request),
            (8, self.line_not_utf8),
            (4, self.line_deeply_nested),
            (5, self.line_near_the_floor),
            (5, self.line_over_the_floor),
            (5, self.line_with_prototype_keys),
        ]
        raw = self.random.choices([g for _, g in generators], [w for w, _ in generators])[0]()
        raw = raw.replace(b"\n", b" ")
        if not raw.strip(b" \t\r"):
            raw = b"x"
        return raw

    def line_mutated_fields(self) -> bytes:
        text = json.dumps(self.mutated_request(), ensure_ascii=self.random.random() < 0.7)
        return text.encode("utf-8", "surrogatepass")

    def line_mangled(self) -> bytes:
        return self.mangled(json.dumps(self.fresh_get()).encode("utf-8"))

    def line_not_a_request(self) -> bytes:
        return self.random.choice([
            b"null", b"[]", b"7", b'"get"', b"true", b"{}", b"[{}]", b'{"v":1}', b'{"Ok":{"kind":"get"}}',
            b"{", b"}", b'{"v":1,"kind":"get",}', b"{'v':1}", b"\xff\xfe", b"\xef\xbb\xbf{}", b"nul\x00l",
            b'{"v":1,"kind":"get","registry":"x","operation":"read","interactive":true,"kind":"refresh"}',
            b'{"__proto__":{"kind":"get"},"v":1,"kind":"refresh","registry":"x"}',
        ])

    def line_not_utf8(self) -> bytes:
        # a request that would be served, with bytes in a field nothing reads
        # that are not UTF-8: a provider that decodes leniently serves it
        request = self.fresh_get()
        request["command"] = "@@"
        bad = self.random.choice([b"\xff", b"\xc3\x28", b"\xe2\x82", b"\xed\xa0\x80", b"\xf8\x88\x80\x80\x80", b"\xc0\xaf"])
        return json.dumps(request).encode("utf-8").replace(b"@@", bad)

    def line_deeply_nested(self) -> bytes:
        depth = self.random.choice([50, 300, 5000, 200000])
        return b'{"v":1,"kind":"refresh","registry":"x","deep":' + b"[" * depth + b"]" * depth + b"}"

    def line_near_the_floor(self) -> bytes:
        # a line near the floor must still be accepted, so it must be a valid request
        request = self.fresh_get()
        request["padding"] = "p" * (LINE_FLOOR - len(json.dumps(request)) - 4096)
        return json.dumps(request).encode("utf-8")

    def line_over_the_floor(self) -> bytes:
        # a request that would be served, if the line were not rejected whole
        request = dict(self.pool[0])
        request["padding"] = "p" * self.random.choice([2 * LINE_FLOOR, 5 * LINE_FLOOR])
        return json.dumps(request).encode("utf-8")

    def line_with_prototype_keys(self) -> bytes:
        raw = json.dumps(self.fresh_get()).encode("utf-8")
        return raw.replace(b"{", b'{"__proto__":{"kind":"x"},"constructor":{"kind":"get"},', 1)

    def mangled(self, raw: bytes) -> bytes:
        for _ in range(self.random.randint(1, 3)):
            choice = self.random.randrange(10)
            at = self.random.randrange(len(raw) + 1) if raw else 0
            if choice == 0:
                raw = raw[:at]
            elif choice == 1:
                raw = raw[:at] + bytes([self.random.randrange(256)]) + raw[at:]
            elif choice == 2 and raw:
                raw = raw[:at] + raw[at + self.random.randint(1, 8):]
            elif choice == 3 and raw:
                at = min(at, len(raw) - 1)
                raw = raw[:at] + bytes([self.random.randrange(256)]) + raw[at + 1:]
            elif choice == 4:
                raw = b"\xef\xbb\xbf" + raw
            elif choice == 5:
                raw = raw + self.random.choice([b"x", b"}", b",", b" {}", b"\r", b"\x00"])
            elif choice == 6:
                raw = self.random.choice([b" ", b"\t", b"\r"]) + raw
            elif choice == 7:
                raw = raw + raw
            elif choice == 8:
                raw = raw.replace(b'"', b"'", 1)
            else:
                raw = raw.replace(b",", b",,", 1)
        return raw

    # --- running ----------------------------------------------------------------

    def run(self, indices: Iterable[int | str]) -> None:
        for index in indices:
            if index == "learn":
                self.learn_write_tokens()
            else:
                self.step(int(index))

    def close(self) -> None:
        self.provider.stdin.close()
        self.events.append({"from": "client", "event": "close"})
        try:
            code = self.provider.wait(timeout=10)
        except subprocess.TimeoutExpired:
            raise Violation("exit-0", f"{self.label}: the provider did not exit after stdin closed") from None
        stderr = b"".join(self.err.text).decode("utf-8", "replace")
        if code != 0:
            raise Violation("exit-0", f"{self.label}: the provider exited {code}\n{stderr[-1500:]}")
        extra = self.out.leftover()
        if extra:
            raise Violation("one-answer-per-line", f"{self.label}: lines left unread: {extra[:2]!r}")
        self.helper.stdin.close()
        last = json.loads(self.helper_out.next("the scenario's end"))
        self.helper.wait(timeout=10)
        self.secrets |= set(last["secrets"])
        leaked = sorted(secret for secret in self.secrets if secret in stderr)
        if leaked:
            raise Violation("no-secret-on-stderr", f"{self.label}: secrets in stderr: {leaked}\n{stderr[-1500:]}")
        # the whole session, as a transcript the model accepts
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch) / "session.jsonl"
            with path.open("w", encoding="utf-8", newline="\n") as file:
                file.writelines(json.dumps(event) + "\n" for event in self.events)
                file.flush()
                os.fsync(file.fileno())
            try:
                validate_transcript(str(path))
            except ProtocolViolation as violation:
                raise Violation("model-accepts-answers", f"{self.label}: the session is not a valid transcript: {violation}") from None

    def kill(self) -> None:
        for process in (self.provider, self.helper):
            if process.poll() is None:
                process.kill()
            process.wait(timeout=10)
        for lines in (self.out, self.err, self.helper_out):
            lines.thread.join(timeout=10)
        for process in (self.provider, self.helper):
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream and not stream.closed:
                    stream.close()


def run_session(name: str, transcript: Path, seed: int, indices: list, *, hostile: bool,
                deadline: float = 10) -> tuple[Violation | None, Session]:
    session = Session(name, transcript, seed, hostile=hostile, deadline=deadline)
    try:
        session.run(indices)
        session.close()
        return None, session
    except Violation as violation:
        return violation, session
    finally:
        session.kill()


def all_indices() -> list:
    return ["learn", *range(STEPS)]


def shrink(name: str, transcript: Path, seed: int, indices: list, violation: Violation, *, hostile: bool,
           deadline: float = 10, runs: Callable[[], None] | None = None) -> tuple[list, Violation]:
    """ddmin over the steps: the smallest list of steps that still breaks the
    same invariant."""
    def fails(candidate: list) -> Violation | None:
        if runs:
            runs()
        found, _ = run_session(name, transcript, seed, candidate, hostile=hostile, deadline=deadline)
        return found if found and found.invariant == violation.invariant else None

    current, best = list(indices), violation
    granularity = 2
    while len(current) >= 2:
        size = max(1, len(current) // granularity)
        chunks = [current[i:i + size] for i in range(0, len(current), size)]
        reduced = False
        for chunk in chunks:
            rest = [item for item in current if item not in chunk]
            found = fails(rest) if rest else None
            if found:
                current, best, reduced = rest, found, True
                granularity = max(granularity - 1, 2)
                break
        if not reduced:
            if granularity >= len(current):
                break
            granularity = min(len(current), granularity * 2)
    if len(current) == 1 and (found := fails([])):
        current, best = [], found
    return current, best


def repro(name: str, transcript: Path, seed: int, indices: list, violation: Violation, session: Session,
          *, hostile: bool) -> dict:
    return {
        "scenario": [name, transcript.name],
        "seed": seed,
        "hostile": hostile,
        "steps": indices,
        "invariant": violation.invariant,
        "violation": violation.detail[:2000],
        "lines": [base64.b64encode(line[:4096]).decode("ascii") + ("…" if len(line) > 4096 else "")
                  for line in session.sent],
    }
