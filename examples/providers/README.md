# Reference providers

Every [example](../README.md) has a provider that runs: [GitLab](gitlab/provider.js), [npmjs.com](npmjs/provider.js), the [corporate SSO gateway](corporate-sso/provider.js), [GitHub Packages](github-packages/provider.js), [Google Artifact Registry](google-artifact-registry/provider.js), [JFrog Artifactory](jfrog-artifactory/provider.js), [Azure Artifacts](azure-artifacts/provider.js), [AWS CodeArtifact](aws-codeartifact/provider.js) and [Verdaccio](verdaccio/provider.js). Each is a Node program with no dependencies that speaks the [Phase 2 protocol](../../phase-2-credential-provider.md) on stdin and stdout, and each produces, from its own state, every answer its example's transcripts record. They show what the pages describe as code: where a provider keeps a refresh token, when it mints and deletes, when it asks for presence and when it answers `other` instead.

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
| `typed` | the lines the person types (a username, a password, a one-time password), in order: a string, `"silent"` for one never typed, or `{ "line": ..., "secret": true }` for one that must never reach stderr |
| `terminal` | `false` for a run with no controlling terminal, where a sign-in step cannot be shown |
| `config` | further keys of the provider's own configuration |
| `stall` | `METHOD /path` prefixes of vendor requests that are never answered, so the provider's own deadline has to end them (a scenario sets `config.requestTimeoutMs` small, since time inside a run is synthetic but a call's timer is real) |
| `atRequest` | `{ on, store }`: what the store must hold, as a subset, at the moment a request whose `METHOD /path` starts with `on` arrives, for what a provider killed during a stalled call would leave |
| `concurrently` | `{ on, store }`: the store is replaced, once, just before such a request is answered, as another process (`npm logout`, `npm login`) would |
| `expect.store`, `expect.state` | what must hold afterwards, as a subset; `null` means absent |
| `expect.shown` | lines the person must have been shown (`ctx.showToPerson`), as they are after sanitising |

When a provider shows an address to open (`ctx.showToPerson(text, { browse: url })`), the scripted person opens it: the request goes to the fake that stands for that host (list the host in `hosts`), and a redirect is followed, to a loopback address as it is, which is how a loopback sign-in reaches the provider's own listener. Time stands still while that visit is under way, so a deadline cannot pass before the person's answer arrives; what the fake answers decides what the person did, such as consenting, declining, or never completing the page.

Every transcript of an example must have a scenario, so an exchange added to a page without code behind it fails the run. After each session the run also fails if any secret the scenario put within the provider's reach (a token, password or client secret in the store, the fake's state, the environment, the fixtures or the transcript) appears in the provider's stderr, which npm logs. CI runs it with the rest of the conformance material.

Two other implementations check the same exchanges. `tests/test_examples.py` replays every transcript through the Python model of the client and validates each message against [the JSON schema](../../spec/protocol-v1.schema.json) for its role, and since a provider must print its transcript exactly, that is its answers checked against the schema too. The Rust client in [poc/rust](../../poc/rust) runs the providers itself ([`reference_providers.rs`](../../poc/rust/crates/mock-client/tests/reference_providers.rs)): it sends each recorded request through its own types and validation, requires the recorded answer through its own parser, and has [`scenario.js`](scenario.js) set each scenario up and check its end state.

The transcripts check what someone thought to record. [`tests/test_provider_sessions.py`](../../tests/test_provider_sessions.py) sends each provider seeded random sessions instead, from every scenario's starting state. A session draws from:

- any operation, either `interactive`;
- 401 retries after an erase and 403 retries without one;
- foreign registries and unknown kinds;
- login and logout.

It checks what the RFC requires of any provider rather than exact answers:

- every answer and the whole session pass the Python model;
- a request that is not interactive asks the person nothing;
- what a provider does not know is `operation-not-supported`, never a read;
- a foreign registry is `url-not-supported`;
- erase does not log out;
- a retry is never `not-found`;
- a 403 on a read never moves to a credential the session saw handed out for a write;
- no secret reaches stderr.

Each check was seen to fail with a provider broken to violate it. Its first run found the npmjs.com provider answering a 403 retry `not-found` when nothing wider was stored, where the RFC asks for `other`, saying so.

[`tests/test_provider_hostile.py`](../../tests/test_provider_hostile.py) sends the same sessions lines that are not valid requests, about a third of the steps:

- a field dropped, retyped or added;
- a request mangled byte by byte;
- text that is not an object;
- a request nested 200 000 deep;
- a valid request a little under 1 MiB (it must be served) and one of megabytes (it must be rejected whole);
- a kind or an operation called `constructor`, a key called `__proto__`;
- bytes that are not UTF-8.

Each must be answered with exactly one line, an `Err` for what is not a valid request and never `Ok`, and the session must go on and end with exit status 0.

[`lib/protocol.js`](lib/protocol.js) does that for every provider. It:

- reads bytes and drops an oversized line as it arrives;
- decodes strictly and parses;
- checks the request against the schema's rules;
- looks the handler up among its own properties.

[`tests/fuzz_providers.py`](../../tests/fuzz_providers.py) runs both kinds of session for as long as asked, with seeds of its own (`python -m tests.fuzz_providers --seconds 600`). A session that breaks an invariant is shrunk by ddmin over its steps, each of which draws on a random stream of its own so that leaving some out changes nothing else, and written out as a JSON repro that `--replay` runs again.

It found that:

- the first version of the providers died on any line that was not JSON;
- the first version answered a kind named `constructor` by calling `Object`;
- the npmjs.com provider answered an operation named `constructor` with a `TypeError` message instead of `operation-not-supported`.

Taking each hardening out of `protocol.js` again made a run of 90 seconds fail (measured once, not re-run by CI), except the strict UTF-8 decoding, which needed a generator of its own (bytes that are not UTF-8 in a field nothing reads).

The same run is the [nightly `fuzz` workflow](../../.github/workflows/fuzz.yml), which keeps what breaks as an artifact of the run; `workflow_dispatch` runs it on demand. Besides the fuzzer it covers:

- the schema, the Python model, the Rust crate and these providers, asked about every message of [`tests/fuzz_messages.py`](../../tests/fuzz_messages.py);
- the Rust parser, fuzzed by coverage ([`poc/rust/fuzz`](../../poc/rust/fuzz)).

[`lib/`](lib) holds what the providers share: the provider side of the protocol ([`protocol.js`](lib/protocol.js)), one provider session against a prepared scenario ([`session.js`](lib/session.js), which `run.js` and the live run drive alike), the provider's own context ([`context.js`](lib/context.js): the store, the clock, the vendor API, presence on the controlling terminal or scripted), and the fake API server ([`fake-server.js`](lib/fake-server.js): an answer `{ hang: true }` is one never given). What a provider shows or asks the person goes through `ctx.showToPerson`, `ctx.confirm` and `ctx.ask`, which replace C0 and C1 controls and bidirectional marks and overrides with `?` before anything is written, so no provider can forget to ([`protocol.test.js`](protocol.test.js) checks that); a provider that quotes vendor text in an error message uses the same `plain` of `lib/context.js`.

## What the fakes are

The fakes answer as the vendors document their APIs, where the pages cite them; a call the provider's author recalled rather than read is marked so in a comment in the provider. The corporate gateway is invented, as on its page. Only the Verdaccio fake has been held against a real server (below); the others have not run against a live registry, since no secret is needed and none is in the repository.

## Against a real server

A fake written from the docs can share a mistake with the provider written from the same docs, and then each confirms the other. The first version of the Verdaccio provider logged in with one `PUT /-/user/org.couchdb.user:<name>` and the fake answered it 201; a real Verdaccio answers 409 for a user that exists, because that call is the add-user path, and the login is the same call with the password in `Authorization: Basic`. Nothing in the repository could see that until the provider met the server.

[`live/verdaccio.js`](live/verdaccio.js) runs the Verdaccio provider against a real Verdaccio:

```sh
node examples/providers/live/verdaccio.js                                  # verdaccio@6.10.6, the current stable release
node examples/providers/live/verdaccio.js --version 7.0.0-next-7.31        # the 7.x line, a pre-release (staging, 2FA, web login flags)
node examples/providers/live/verdaccio.js --only login,escalation          # some scenarios (`probes` is the requests no scenario reaches)
VERDACCIO_LIVE_TRACE=1 VERDACCIO_LIVE_LOG=debug node examples/providers/live/verdaccio.js ...   # every call, and the server's own log on a failure
```

It installs the version with `npm install --prefix <dir>` (an empty `--userconfig`, so no npm configuration is read or changed; `--install-dir` keeps the install between runs), starts it as a Node process on a free 127.0.0.1 port from a generated configuration in a temporary directory (htpasswd, the default opaque tokens, the `packages` rules of the scenario, `flags.stage` on the 7.x line), polls `/-/ping` until it answers, and kills it at the end. No docker, so a run is the same on a laptop and in CI.

Each scenario that can run against a real server runs twice, once on the fake as `run.js` does and once here:

- **Set-up through the real API.** A server per scenario. The first start leaves registration open: the users of the scenario's `state` are registered with `PUT /-/user/org.couchdb.user:<name>`, the test package `@acme/widget@2.4.0` is published with a real tarball by a user the rules let publish, and a token is minted with `POST /-/npm/v1/tokens` for each entry of `state.tokens` (its key revoked with `DELETE /-/npm/v1/tokens/token/<key>` for a `dead` one). Then the same storage is started again with registration closed (`max_users: -1`) and the scenario's rules.
- **JWT scenarios.** A scenario whose tokens are JWTs gets a server that signs JWTs expiring as the scenario's do, with the clock set to the real time. Where a token has to lapse, the lifetime is 4 seconds and the clock a day back.
- **The same assertions.** The provider, started as npm starts it and talking to the server through a recording proxy, must answer each client line with the recorded answer, the scenario's fake tokens replaced by the real ones (and `expiresAt` by the real token's `exp`, clamped); leave the store `expect.store` says, a minted token being any real one that then does what its tier says (the read-only one reads and is refused a write, the full one is the user's); and make the calls `expect.state` counts (a `whoami` that reaches its route, a login the server accepted, a token minted, a key revoked). The person's answers asked for, and the secrets kept off stderr, are checked as in `run.js`.
- **What npm would send.** After each credential the provider releases, the request npm makes with it (a packument read, a publish, a token create, a staging call) goes to the fake and to the server. Where the transcript says the next request was refused, `escalation` and `rejection-revoked-key` need the real server to refuse that very request with that status.
- **Divergences.** The calls of the two runs are lined up. A call that differs (a method, a path, a credential, a body) is a divergence, and so is an answer that differs in status, in `WWW-Authenticate`, `npm-notice`, `Vary`, `Cache-Control`, the media type of `Content-Type`, or in the keys of its JSON body. The run prints each with the request, the fake's answer and the real one.
- **The allowlist.** [`live/verdaccio-divergences.json`](live/verdaccio-divergences.json) lists the known ones, each with its Verdaccio major and a line of reason. A new divergence fails the run, and so does an entry that no longer matches one.
- **Probes.** The same comparison is made for 34 requests no scenario reaches (`probes`): whoami with each kind of credential, the packument and the publish, the token list, create and revoke, the login in each form, a staging read.

A scenario that cannot run against a real server is listed in [`live/verdaccio-skips.json`](live/verdaccio-skips.json) with its reason, and the run prints the list; a scenario neither run nor listed fails it, and so does a listing of a scenario that does not exist. The reasons are in [the Verdaccio page](../verdaccio.md#against-a-real-verdaccio): the 2FA scenarios need a TOTP enrolment, one scenario a server error and one a server that never answers, and two the 7.x staging flag, which 6.10.6 does not have. CI runs the job for 6.10.6 and for 7.0.0-next-7.31 ([`conformance.yml`](../../.github/workflows/conformance.yml), `verdaccio-live`).

Two workflows run it. `conformance.yml` runs the pinned versions above on every push, which checks this repository's code against a server that does not move. [`verdaccio-latest.yml`](../../.github/workflows/verdaccio-latest.yml) runs nightly, and on demand, against what npm serves under the `latest` and `next-7` tags, and prints the exact version it resolved: a failure there with the pinned run green means Verdaccio changed, and the version it names is where.

What the live run found on its first day, and fixed:

- the login (above), in the provider and in the fake;
- the fake's token create, token list, revocation of a key nobody holds (a real 200), packument, publish and 401 headers, which a real server answers otherwise;
- the fake's staging, which was a route (`PUT /-/stage/<package>`) the 7.x line does not have: staging is `POST /-/stage/package/<package>`, answering `stageId`, and a record is read and rejected by its UUID;
- the fake's crash, a 500, on an unauthenticated token create, where Verdaccio answers 401.

## What the reference providers simplify

Each of these is a limit of the example, not a gap in the protocol: the pages describe a fuller provider, and say where the reference one is simpler.

| Simplification | Why | Widened when |
|---|---|---|
| A sign-in that a vendor's CLI would run (`gcloud auth login`, `aws sso login`, the Entra device flow, JFrog web login) is the vendor's device flow spoken in-process against the fake (for Google, its desktop-app flow: a loopback listener, PKCE, a code exchange) | a run cannot depend on a CLI being installed or on a browser | never for the CLIs; the device flows themselves are what the fakes model |
| Azure's `az account get-access-token` is an HTTP address of the fake; AWS's SSO cache is the provider's own store; Google's sign-in is not a `gcloud` configuration directory | the same: no CLI in a run | never |
| A pasted JFrog identity token is not validated; GitHub's `dist-tag` is served on the page's unverified word; Verdaccio sends a password over `http:` | no documented call to check it with; the operator's own configuration | a documented validation call; the vendor documents the endpoint; an opt-in setting |
| What the person typed before a presence or secret prompt is read for 30 ms and discarded, not flushed: Node has no `tcflush`, so a key pressed after that and before the question shows still answers it; where the terminal cannot be put in raw mode nothing is discarded | the platform call is not reachable from Node | a Node API for it, or a native helper |
| The raw mode a secret prompt turns on is turned off again on exit and SIGTERM, not on SIGKILL or on Windows' termination of a process, which run no handler | no handler can run | never; `reset` or a new console repairs it |
| Some branches have no transcript and are reached only by random sessions or by hand | each needs a scenario of its own | a scenario and a transcript per branch; the list of branches is the one the random sessions reach and no transcript does |

## What the transcripts pin

Every behaviour the providers' authors found unpinned on a first pass now has an exchange of its own, and each was seen to fail when the code behind it was broken:

- a GitLab job token asked about another project;
- the deploy token `erase` deletes;
- a read and a stage-only credential refused with 403 on npmjs.com;
- a package with no read token;
- a pasted token in `npm login`;
- `access` in CI;
- `Retry-After` on the web-login poll;
- the corporate gateway refusing a revoked IdP access token;
- a 403 with the user's groups unchanged;
- a CI identity without the publisher role;
- `slow_down` in the device flow;
- a device sign-in nobody approves and a presence prompt nobody answers, both ended by the provider's 4 minutes 30 seconds of synthetic time.

Two things looked unpinned and are settled, not left: the npmjs.com provider now serves `trust` from a granular token bound to the package, and not from the session token that serves `access` ([trust.jsonl](../npmjs/trust.jsonl), [trust-session-only.jsonl](../npmjs/trust-session-only.jsonl)); and a deploy token kept in a CI variable is not read by the GitLab provider by design, since `_authToken=${VAR}` already is that credential and the provider's `not-found` lets the chain fall through to it (the [GitLab page](../gitlab.md) says so).

Time is synthetic only where a provider takes it from its context (`now`, `clockMs`, `sleep`); outside a conformance run [`context.js`](lib/context.js) maps those to the system clock and real timers. [`real-time.test.js`](real-time.test.js) checks that mapping, which a run cannot, on Linux, macOS and Windows in CI (`node --test examples/providers/real-time.test.js`, a few seconds): the clock moves, a sleep waits, no request carries the run's clock, and the npmjs.com provider waits out a real `Retry-After`. Its first run caught the provider writing the sign-in text to a file named `CONOUT$` in its working directory: Node resolves that name against the current directory like any relative path, which takes it out of Windows' device namespace, so a Node provider opens `\\.\CONOUT$` and `\\.\CONIN$`.
