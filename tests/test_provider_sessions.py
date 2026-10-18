"""Random sessions against the reference providers in examples/providers.

The transcripts check what someone thought to record. Here a seeded
generator sends each reference provider sessions of its own, from every
scenario's starting state: any operation (now and then one no version
knows), either `interactive`, a 401 retry after an erase or a 403 retry
without one, a registry the provider does not serve, a kind no version
knows, login and logout. The answers are not known in advance, so what is
checked is what the RFC requires of every provider:

- every answer is one the Python model of the client accepts, and the whole
  session, written out, is a transcript the model accepts;
- a request that is not interactive asks the person nothing;
- an operation or a request kind it does not know is answered
  `operation-not-supported`, never served as a read;
- a registry it does not serve is answered `url-not-supported`, whatever the
  kind or operation;
- erase drops the credential handed out, not the login: the 401 retry that
  follows it is not answered `not-found` when the first `get` was answered;
- a 403 retry is not answered `not-found` either: a provider with nothing
  else to release answers `other`, saying so;
- a 403 on a read never moves to a credential the session handed out for a
  write, unless the read's own credential was that one;
- no secret reaches stderr;
- every request is answered within 10 s, and the provider exits 0.

Needs `node`. A few seconds: one session per scenario, a fixed seed each.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import queue
import random
import subprocess
import tempfile
import threading
import unittest

from tests.generated_policy import OPERATIONS_REQUIRING_VERSION, SUPPORTED_OPERATIONS
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


def node_available() -> bool:
    try:
        return subprocess.run(["node", "--version"], capture_output=True).returncode == 0
    except FileNotFoundError:
        return False


class Lines:
    """A pipe read by a thread, so a silent provider fails the test instead
    of hanging it."""

    def __init__(self, stream) -> None:
        self.queue: queue.Queue[str | None] = queue.Queue()
        self.text: list[str] = []

        def pump() -> None:
            for line in stream:
                self.text.append(line)
                self.queue.put(line)
            self.queue.put(None)

        threading.Thread(target=pump, daemon=True).start()

    def next(self, what: str) -> str:
        try:
            line = self.queue.get(timeout=10)
        except queue.Empty:
            raise AssertionError(f"no answer within 10 s, waiting for {what}") from None
        if line is None:
            raise AssertionError(f"the stream closed before {what}")
        return line


class Session:
    def __init__(self, name: str, transcript: Path, seed: int) -> None:
        self.label = f"{name}/{transcript.name} seed {seed}"
        self.random = random.Random(seed)
        self.helper = subprocess.Popen(
            ["node", str(SCENARIO), "--sessions", str(seed), name, str(transcript)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8",
        )
        self.helper_out = Lines(self.helper.stdout)
        setup = json.loads(self.helper_out.next("the scenario"))
        self.asked_file = Path(setup["askedFile"])
        self.secrets: set[str] = set(setup["secrets"])
        env = {key: value for key, value in setup["env"].items() if value is not None}
        self.provider = subprocess.Popen(
            ["node", setup["provider"], "--npm-credential-provider", "--config", setup["configFile"]],
            cwd=setup["cwd"], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8",
        )
        self.out = Lines(self.provider.stdout)
        self.err = Lines(self.provider.stderr)
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

    def asked(self) -> int:
        return len(self.asked_file.read_text(encoding="utf-8").splitlines()) if self.asked_file.exists() else 0

    def send(self, request: dict) -> dict:
        validate_request(request)
        self.events.append({"from": "client", "message": request})
        asked_before = self.asked()
        self.provider.stdin.write(json.dumps(request) + "\n")
        self.provider.stdin.flush()
        answer = json.loads(self.out.next(f"the answer to {request['kind']}"))
        self.events.append({"from": "provider", "message": answer})
        where = f"{self.label}, request {json.dumps(request)}, answer {json.dumps(answer)}"
        try:
            self.model.handle_response(request, answer)
        except ProviderFailure:
            pass
        except ProtocolViolation as violation:
            raise AssertionError(f"{where}: {violation}") from None
        if not request.get("interactive"):
            assert self.asked() == asked_before, f"{where}: asked the person on a request that is not interactive"
        auth = answer.get("Ok", {}).get("auth") or {}
        for field in ("token", "password"):
            if isinstance(auth.get(field), str):
                self.secrets.add(auth[field])
        return answer

    # --- the generator ---------------------------------------------------------

    def fresh_get(self) -> dict:
        request = dict(self.random.choice(self.pool))
        for field in ("retry", "httpStatus", "authChallenges"):
            request.pop(field, None)
        # mostly what the recorded request asked, so that credentials are
        # handed out and retried; sometimes any operation, now and then one
        # no version knows
        roll = self.random.random()
        if roll < 0.05:
            operation = "frobnicate"
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

    def step(self) -> None:
        roll = self.random.random()
        if roll < 0.08:
            request = {"v": 1, "kind": "get", "registry": FOREIGN, "operation": "read", "command": "install",
                       "interactive": False}
            answer = self.send(request)
            assert answer == {"Err": {"kind": "url-not-supported"}}, f"{self.label}: {FOREIGN} answered {answer}"
            return
        if roll < 0.12:
            registry = self.random.choice(self.pool)["registry"]
            answer = self.send({"v": 1, "kind": "refresh", "registry": registry})
            assert answer.get("Err", {}).get("kind") == "operation-not-supported", (
                f"{self.label}: a kind no version knows answered {answer}"
            )
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
        if request["operation"] == "frobnicate":
            assert answer.get("Err", {}).get("kind") == "operation-not-supported", (
                f"{self.label}: an operation no version knows answered {answer}"
            )
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
            assert retry.get("Err", {}).get("kind") != "not-found", (
                f"{self.label}: the 401 retry after erase answered not-found, as if erase had logged out: {request}"
            )
        elif follow < 0.6:
            retry = self.send({**request, "retry": True, "httpStatus": 403})
            assert retry.get("Err", {}).get("kind") != "not-found", (
                f"{self.label}: a 403 retry answered not-found; a provider with nothing else to release answers "
                f"other, saying so: {request}"
            )
            widened = (retry.get("Ok") or {}).get("auth", {})
            widened = widened.get("token") or widened.get("password")
            if request["operation"] in READ_OPERATIONS and token not in self.write_tokens:
                assert widened not in self.write_tokens, (
                    f"{self.label}: a 403 on a read moved to a credential handed out for a write: {request}"
                )

    def close(self) -> None:
        self.provider.stdin.close()
        self.events.append({"from": "client", "event": "close"})
        code = self.provider.wait(timeout=10)
        stderr = "".join(self.err.text)
        assert code == 0, f"{self.label}: the provider exited {code}\n{stderr}"
        self.helper.stdin.close()
        last = json.loads(self.helper_out.next("the scenario's end"))
        self.helper.wait(timeout=10)
        self.secrets |= set(last["secrets"])
        leaked = sorted(secret for secret in self.secrets if secret in stderr)
        assert not leaked, f"{self.label}: secrets in stderr: {leaked}\n{stderr}"
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
                raise AssertionError(f"{self.label}: the session is not a valid transcript: {violation}") from None

    def kill(self) -> None:
        for process in (self.provider, self.helper):
            if process.poll() is None:
                process.kill()


@unittest.skipUnless(node_available(), "node is not installed")
class ProviderSessionTests(unittest.TestCase):
    def test_random_sessions_keep_the_rfc_invariants(self) -> None:
        listed = subprocess.run(["node", str(SCENARIO)], capture_output=True, text=True, check=True)
        scenarios = [line.split(" ", 1) for line in listed.stdout.splitlines()]
        self.assertGreater(len(scenarios), 30)
        requests = 0
        for seed, (name, transcript) in enumerate(scenarios, 1):
            with self.subTest(scenario=f"{name}/{Path(transcript).name}"):
                session = Session(name, Path(transcript), seed)
                try:
                    session.learn_write_tokens()
                    for _ in range(STEPS):
                        session.step()
                    session.close()
                    requests += sum(1 for event in session.events if event.get("from") == "client" and "message" in event)
                finally:
                    session.kill()
        self.assertGreater(requests, len(scenarios) * 5)


if __name__ == "__main__":
    unittest.main()
