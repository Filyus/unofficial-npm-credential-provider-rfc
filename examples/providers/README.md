# Reference providers

Three of the [examples](../README.md) have a provider that runs: [GitLab](gitlab/provider.js), [npmjs.com](npmjs/provider.js) and the [corporate SSO gateway](corporate-sso/provider.js). Each is a Node program with no dependencies that speaks the [Phase 2 protocol](../../phase-2-credential-provider.md) on stdin and stdout, and each produces, from its own state, every answer its example's transcripts record. They show what the pages describe as code: where a provider keeps a refresh token, when it mints and deletes, when it asks for presence and when it answers `other` instead.

```sh
node examples/providers/run.js            # every provider against every transcript of its example
node examples/providers/run.js gitlab     # one provider
```

## How a run works

[`run.js`](run.js) starts the provider as npm would, with `--npm-credential-provider` and the provider's own `--config`, and feeds it the client lines of each `examples/<name>/*.jsonl`. Every provider line must equal the recorded one. A scenario per transcript, `<name>/scenarios/<t>.json`, gives what the answers must follow from:

| Field | What it sets |
|---|---|
| `store` | what the provider has stored: a JSON file standing in for the OS keychain |
| `state`, `hosts` | the vendor API's state, served by the provider's `fake.js` on 127.0.0.1 for those origins |
| `now`, `clock` | the time, fixed, or one time per client request, since a retry comes when a token has lapsed; within a request time passes only when the provider sleeps, at once, so a poll interval or a deadline of minutes costs nothing |
| `env` | the environment beyond `PATH`; CI variables, for instance |
| `presence` | the person's answers to presence prompts, in order, `true`, `false` or `"silent"` for one never given; each one must be asked for |
| `config` | further keys of the provider's own configuration |
| `expect.store`, `expect.state` | what must hold afterwards, as a subset; `null` means absent |

Every transcript of an example must have a scenario, so an exchange added to a page without code behind it fails the run. After each session the run also fails if any secret the scenario put within the provider's reach (a token, password or client secret in the store, the fake's state, the environment, the fixtures or the transcript) appears in the provider's stderr, which npm logs. CI runs it with the rest of the conformance material.

Two other implementations check the same exchanges. `tests/test_examples.py` replays every transcript through the Python model of the client and validates each message against [the JSON schema](../../spec/protocol-v1.schema.json) for its role, and since a provider must print its transcript exactly, that is its answers checked against the schema too. The Rust client in [poc/rust](../../poc/rust) runs the providers itself ([`reference_providers.rs`](../../poc/rust/crates/mock-client/tests/reference_providers.rs)): it sends each recorded request through its own types and validation, requires the recorded answer through its own parser, and has [`scenario.js`](scenario.js) set each scenario up and check its end state.

The transcripts check what someone thought to record. [`tests/test_provider_sessions.py`](../../tests/test_provider_sessions.py) sends each provider seeded random sessions instead, from every scenario's starting state (any operation, either `interactive`, 401 retries after an erase and 403 retries without one, foreign registries, unknown kinds, login and logout), and checks what the RFC requires of any provider rather than exact answers: every answer and the whole session pass the Python model; a request that is not interactive asks the person nothing; what a provider does not know is `operation-not-supported`, never a read; a foreign registry is `url-not-supported`; erase does not log out; a retry is never `not-found`; a 403 on a read never moves to a credential the session saw handed out for a write; no secret reaches stderr. Each was seen to fail with a provider broken to violate it. Its first run found the npmjs.com provider answering a 403 retry `not-found` when nothing wider was stored, where the RFC asks for `other`, saying so.

[`lib/`](lib) holds what the three share: the provider side of the protocol ([`protocol.js`](lib/protocol.js)), the provider's own context ([`context.js`](lib/context.js): the store, the clock, the vendor API, presence on the controlling terminal or scripted), and the fake API server ([`fake-server.js`](lib/fake-server.js)).

## What the fakes are

The fakes answer as the vendors document their APIs, where the pages cite them; a call the provider's author recalled rather than read is marked so in a comment in the provider. The corporate gateway is invented, as on its page. None of this has run against a live registry: no secret is needed, and none is in the repository.

## What the transcripts pin

Every behaviour the providers' authors found unpinned on a first pass now has an exchange of its own, and each was seen to fail when the code behind it was broken: a GitLab job token asked about another project, the deploy token `erase` deletes, a read and a stage-only credential refused with 403 on npmjs.com, a package with no read token, a pasted token in `npm login`, `access` in CI, `Retry-After` on the web-login poll, the corporate gateway refusing a revoked IdP access token, a 403 with the user's groups unchanged, a CI identity without the publisher role, `slow_down` in the device flow, a device sign-in nobody approves and a presence prompt nobody answers, both ended by the provider's 4 minutes 30 seconds of synthetic time.

Left open, on purpose, because no page describes it:

- The npmjs.com provider does not serve `trust`, which its page leaves untested against the registry, and the GitLab provider does not read a deploy token from a CI variable, whose name the page does not give.

Time is synthetic only where a provider takes it from its context (`now`, `clockMs`, `sleep`); outside a conformance run [`context.js`](lib/context.js) maps those to the system clock and real timers. [`real-time.test.js`](real-time.test.js) checks that mapping, which a run cannot, on Linux, macOS and Windows in CI (`node --test examples/providers/real-time.test.js`, a few seconds): the clock moves, a sleep waits, no request carries the run's clock, and the npmjs.com provider waits out a real `Retry-After`. Its first run caught the provider writing the sign-in text to a file named `CONOUT$` in its working directory: Node resolves that name against the current directory like any relative path, which takes it out of Windows' device namespace, so a Node provider opens `\\.\CONOUT$` and `\\.\CONIN$`.
