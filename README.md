# Unofficial npm credential provider RFC draft

An independent proposal for letting npm get registry credentials from a user-configured program at the moment it needs them, instead of reading a long-lived secret from `.npmrc` or the environment. It builds on the [npm/rfcs#850](https://github.com/npm/rfcs/pull/850) discussion and answers [npm/cli#8141](https://github.com/npm/cli/issues/8141). It is not an accepted npm RFC.

## Roadmap

The proposal goes upstream in three phases. Each phase has two documents. The **proposal** says what and why, in the sections of the npm/rfcs template. The **implementation** document says what is submitted where, which submission carries each rule and which test pins it, what is not claimed, how to run the checks, and what the reviews found.

Phase 1a lands on its own: it does not wait for 1b, and the helper needs no change when 1b lands. Phase 2 builds on the seam that 1a adds to npm-registry-fetch.

Phase 1a changes nothing for anyone who has not configured a helper, and Phase 2 nothing for anyone who has not configured a provider; both are configured only in the user's own user or global npm config. Phase 1b changes nothing that npm sends while its setting, `strict-credentials`, is off, but does warn at the default level wherever the setting would change something ([The setting](phase-1b-credential-hardening.md#the-setting)); the next major turns it on.

### Phase 1a: `tokenHelper`

[Proposal](phase-1a-token-helper.md): pnpm's per-registry `tokenHelper` for npm. An executable prints a token and npm sends it as a stored token is sent. It holds the motivation and the trust rule that every phase follows. [Implementation](phase-1a-implementation.md). Done when one helper serves npm and pnpm from the same `~/.npmrc`, where it prints a Bearer token for an `https:` registry and its path has no spaces, `$`, `%` or quotes; Phase 2 and pnpm do not mix for one registry. The proposal also says [what it protects against, and what it does not](phase-1a-token-helper.md#what-this-protects-against-and-what-it-does-not): a repository's config when no repository code runs, not code already running as the user or in the job.

| Submission | State | Condition to move on |
|---|---|---|
| [1. npm-registry-fetch: `opts.getAuthorization`](phase-1a-implementation.md#1-npm-registry-fetch-optsgetauthorization) | Ready for review | Released as 20.1.0 |
| [2. npm/cli: the token helper](phase-1a-implementation.md#2-npmcli-the-token-helper) | Draft until npm-registry-fetch 20.1.0 is published | Merged and released |
| [3. npm/cli: the `profile` guard, the 401 hint and the runner's diagnostics](phase-1a-implementation.md#3-npmcli-the-profile-guard-the-401-hint-and-the-runners-diagnostics) | Written; opened after 2 | Merged |

### Phase 1b: credential hardening

[Proposal](phase-1b-credential-hardening.md): how every credential travels, stored tokens, helpers and providers alike. `https:` or loopback only (a per-registry `allow-http-credential` allowance for stored tokens, never for a helper's), transport from config a project cannot write, no `${VAR}` expansion in project files under strict mode, a user or global file that was chosen inside a project counts as the project layer, redirects (make-fetch-happen and minipass-fetch compare the host), the cache index, error responses, and no project-chosen user or global file. One opt-in setting, `strict-credentials`, the default in the next major. [Implementation](phase-1b-implementation.md). Done when no credential travels outside the rules unless the user turned them off.

| Submission | State | Condition to move on |
|---|---|---|
| [1. make-fetch-happen and minipass-fetch: `Authorization` out of the cache index, redirects compare host](phase-1b-implementation.md#1-make-fetch-happen-and-minipass-fetch-authorization-out-of-the-cache-index-redirects-compare-host) | Design only | Released |
| [2. npm-registry-fetch: the route and the answer of a credentialed request](phase-1b-implementation.md#2-npm-registry-fetch-the-route-and-the-answer-of-a-credentialed-request) | Design only | Released |
| [3. npm/cli: `strict-credentials`](phase-1b-implementation.md#3-npmcli-strict-credentials) | Design only | Submission 2 released; then shipped in a minor |
| [4. npm/cli, next major: on by default](phase-1b-implementation.md#4-npmcli-next-major-strict-credentials-on-by-default) | Design only | Submission 3 shipped in a minor |

### Phase 2: credential provider protocol

[Proposal](phase-2-credential-provider.md): a versioned JSON protocol modelled on Cargo's. npm says which registry, package and action it needs a credential for, the provider answers with the credential and how long to cache it, and is told when the registry rejects it. Chaining, `npm login` and `logout` delegation, the security model, prior art. [Implementation](phase-2-implementation.md). Done when a provider written against the vectors alone works with npm.

| Submission | State | Condition to move on |
|---|---|---|
| [1. npm/rfcs: the credential provider RFC](phase-2-implementation.md#1-npmrfcs-the-credential-provider-rfc) | Draft | Accepted |
| [2. npm-registry-fetch: a second `getAuthorization` call after a rejection](phase-2-implementation.md#2-npm-registry-fetch-a-second-getauthorization-call-after-a-rejection) | Design only | 1 accepted and Phase 1a submission 1 released; then released itself |
| [3. npm/cli: provider sessions, the chain and the cache](phase-2-implementation.md#3-npmcli-provider-sessions-the-chain-and-the-cache) | Design only | 1 accepted and 2 released |

### Shared material

- [Examples](examples/README.md): how providers for real registries would answer, and where each is easy to get wrong.
- [sources.md](sources.md): is what the RFC says about npm, pnpm, Cargo and registries true? Each fact with its source and the date it was checked, what is not verified, and where the saved copies of the sources are.
- [poc/patches](poc/patches): the Phase 1a prototype as patches against upstream npm/cli and npm-registry-fetch.
- [poc/retired](poc/retired/README.md): the mechanisms a review retired, each one `git apply` away and proved by CI to still apply.
- The old address, [rfc-credential-provider.md](rfc-credential-provider.md), says where each of its sections went.

## Running the checks

The Phase 2 conformance artifacts (schema, policy, vectors, Python model, Rust pair) are listed in [phase-2-implementation.md](phase-2-implementation.md#how-it-is-checked).

Prerequisites, as the CI workflows have them:

- Python 3.12 (the runner's `python3`) with `jsonschema` (`pip install jsonschema`).
- Node 24; the Phase 1 checks also run on 22.22.2 and 26.x.
- A Rust toolchain for edition 2024 (1.85 or newer) with `rustfmt` and `clippy`; a nightly with `cargo-fuzz` only for the coverage fuzzing below.

A missing tool makes these tests **skip, not fail**:

| Missing | Skipped |
|---|---|
| `jsonschema` | `test_json_schema`, `test_examples`, the schema half of `test_model_schema_agreement` |
| `cargo` or `node` | `test_differential` |
| `node` | `test_provider_harness`, `test_provider_hostile`, `test_provider_sessions` |
| `NPM_CLI` naming a checkout with the Phase 1a prototype ([phase-1a-implementation.md](phase-1a-implementation.md#reproducing-the-checks)) | the helper comparison of `test_helper_differential` |

With `REQUIRE_TOOLS=1` ([tests/tools_required.py](tests/tools_required.py)) a missing tool fails the run instead. The `conformance` and `fuzz` workflows set it; a plain run does not. The one exception is `RunnerTests` in `test_helper_differential`, which skips without `NPM_CLI` either way; the `prototype` workflow runs that comparison through `tests.fuzz_helper`. `python -m unittest discover -v` shows every skip and its reason: a run with skips has not run those checks.

```sh
python tools/generate_from_policy.py --check
python -m unittest discover -v
cargo test --manifest-path poc/rust/Cargo.toml
node tools/check-links.js
```

Fuzzing, for as long as you like (each prints its seed, shrinks what it finds and writes a repro; they are also what the nightly workflow runs):

```sh
python -m tests.fuzz_providers --seconds 600   # random and hostile sessions against the reference providers
python -m tests.fuzz_messages --seconds 600    # the schema, the Python model, the Rust crate and the JS providers against each other
```

and, with a nightly toolchain and `cargo install cargo-fuzz`, the Rust parser by coverage (on Windows, with the directory of `clang_rt.asan_dynamic-x86_64.dll` from Visual Studio on `PATH`):

```sh
python tools/seed_fuzz_corpus.py poc/rust/fuzz/corpus/message
cd poc/rust && cargo +nightly fuzz run message -- -max_total_time=600 -dict=fuzz/message.dict
cd poc/rust && cargo +nightly fuzz run line_limit -- -max_total_time=300 -max_len=64
```

End-to-end check of the Phase 1a prototype, given local checkouts of npm/cli and npm/npm-registry-fetch carrying the prototype (it lays the prototype over npm's bundled npm-registry-fetch and restores it on exit). The `token-helper` branches are not published: the checkouts are made by applying the patches of `poc/patches` to the upstream commits they were made on, with the steps CI runs, in [phase-1a-implementation.md](phase-1a-implementation.md#reproducing-the-checks):

```sh
node poc/npm-e2e/run.js <npm-cli checkout> <npm-registry-fetch checkout>
```

## Prior art

- [pnpm `tokenHelper`](https://pnpm.io/settings#urltokenhelper): the Phase 1a model.
- [Cargo credential provider protocol](https://doc.rust-lang.org/cargo/reference/credential-provider-protocol.html): version negotiation, JSON over stdin/stdout, cache policy, operation context, chaining.
- [Git credential helpers](https://git-scm.com/docs/gitcredentials) and [Docker credential helpers](https://docs.docker.com/reference/cli/docker/login/#credential-stores): a decade of external credential programs.
- [NuGet cross-platform plugins](https://learn.microsoft.com/en-us/nuget/reference/extensibility/nuget-cross-platform-plugins) and [authentication plugins](https://learn.microsoft.com/en-us/nuget/reference/extensibility/nuget-cross-platform-authentication-plugin): the closest prior art to Phase 2.
- [pip keyring support](https://pip.pypa.io/en/stable/topics/authentication/), [AWS SDK credential providers](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-credential-providers.html), [Azure Identity `DefaultAzureCredential`](https://learn.microsoft.com/en-us/javascript/api/%40azure/identity/defaultazurecredential): credential chains in other ecosystems.
