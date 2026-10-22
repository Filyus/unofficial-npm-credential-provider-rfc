# Unofficial npm credential provider RFC draft

An independent proposal for letting npm get registry credentials from a user-configured program at the moment it needs them, instead of reading a long-lived secret from `.npmrc` or the environment. It builds on the [npm/rfcs#850](https://github.com/npm/rfcs/pull/850) discussion and answers [npm/cli#8141](https://github.com/npm/cli/issues/8141). It is not an accepted npm RFC.

## The proposal

| Document | What it is |
|---|---|
| [Phase 1a: `tokenHelper`](phase-1-token-helper.md) | pnpm's per-registry `tokenHelper` for npm: an executable prints a token, npm sends it as a stored token is sent. The motivation, and the trust rule both phases follow. Lands on its own, without 1b or Phase 2 |
| [Phase 1b: credential hardening](phase-1b-credential-hardening.md) | How every credential travels, stored tokens, helpers and providers alike: `https:` or loopback only, transport from config a project cannot write, redirects, the cache index, error responses, and no project-chosen user or global file. One opt-in setting, `strict-credentials`, the default in the next major |
| [Phase 2: credential provider protocol](phase-2-credential-provider.md) | A versioned JSON protocol modelled on Cargo's: npm says which registry, package and action it needs a credential for, the provider answers with the credential and how long to cache it, and is told when the registry rejects it. Chaining, `npm login`/`logout` delegation, the security model, prior art |
| [Examples](examples/README.md) | How providers for real registries would answer, and where each is easy to get wrong |

The old address, [rfc-credential-provider.md](rfc-credential-provider.md), says where each of its sections went.

Phase 1a changes nothing for anyone who has not configured a helper, Phase 1b nothing until its setting is turned on, Phase 2 nothing for anyone who has not configured a provider, and both are configured only in the user's own user or global npm config.

## Evidence

| Document | What it holds |
|---|---|
| [sources.md](sources.md) | Is what the RFC says about npm, pnpm, Cargo and registries true? Each fact with its source and the date it was checked, what is not verified, and where the saved copies of the sources are |
| [phase-1-implementation.md](phase-1-implementation.md) | Does the npm patch do what Phase 1a says, and how do we know? The code, the checks, each Phase 1 rule with its test, the review rounds and the limits |
| [phase-2-conformance.md](phase-2-conformance.md) | What does the conformance material check, rule by rule, and what can only an npm client show? The artifacts, each Phase 2 rule with its test, the fuzzing history |
| [stage-tiers-test.md](stage-tiers-test.md) | The live test of which npmjs.com tokens read `/-/stage`, and its result |
| [poc/patches](poc/patches) | The prototype as patches against upstream npm/cli and npm-registry-fetch |

## Running the checks

The Phase 2 conformance artifacts (schema, policy, vectors, Python model, Rust pair) are listed in [phase-2-conformance.md](phase-2-conformance.md).

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
| `NPM_CLI` naming a checkout with the Phase 1a prototype ([phase-1-implementation.md](phase-1-implementation.md#reproducing-the-checks)) | the helper comparison of `test_helper_differential` |

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

End-to-end check of the Phase 1a prototype, given local checkouts of npm/cli and npm/npm-registry-fetch carrying the prototype (it lays the prototype over npm's bundled npm-registry-fetch and restores it on exit). The `token-helper` branches are not published: the checkouts are made by applying the patches of `poc/patches` to the upstream commits they were made on, with the steps CI runs, in [phase-1-implementation.md](phase-1-implementation.md#reproducing-the-checks):

```sh
node poc/npm-e2e/run.js <npm-cli checkout> <npm-registry-fetch checkout>
```

## Prior art

- [pnpm `tokenHelper`](https://pnpm.io/settings#urltokenhelper): the Phase 1a model.
- [Cargo credential provider protocol](https://doc.rust-lang.org/cargo/reference/credential-provider-protocol.html): version negotiation, JSON over stdin/stdout, cache policy, operation context, chaining.
- [Git credential helpers](https://git-scm.com/docs/gitcredentials) and [Docker credential helpers](https://docs.docker.com/reference/cli/docker/login/#credential-stores): a decade of external credential programs.
- [NuGet cross-platform plugins](https://learn.microsoft.com/en-us/nuget/reference/extensibility/nuget-cross-platform-plugins) and [authentication plugins](https://learn.microsoft.com/en-us/nuget/reference/extensibility/nuget-cross-platform-authentication-plugin): the closest prior art to Phase 2.
- [pip keyring support](https://pip.pypa.io/en/stable/topics/authentication/), [AWS SDK credential providers](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-credential-providers.html), [Azure Identity `DefaultAzureCredential`](https://learn.microsoft.com/en-us/javascript/api/%40azure/identity/defaultazurecredential): credential chains in other ecosystems.
