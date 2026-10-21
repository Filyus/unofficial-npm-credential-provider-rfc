# Unofficial npm credential provider RFC draft

An independent proposal for letting npm get registry credentials from a user-configured program at the moment it needs them, instead of reading a long-lived secret from `.npmrc` or the environment. It builds on the [npm/rfcs#850](https://github.com/npm/rfcs/pull/850) discussion and answers [npm/cli#8141](https://github.com/npm/cli/issues/8141). It is not an accepted npm RFC.

## The proposal

| Document | What it is |
|---|---|
| [Phase 1: `tokenHelper`](phase-1-token-helper.md) | pnpm's per-registry `tokenHelper` for npm: an executable prints a token, npm sends it. The motivation, and the trust rule both phases follow. Lands on its own, without Phase 2 |
| [Phase 2: credential provider protocol](phase-2-credential-provider.md) | A versioned JSON protocol modelled on Cargo's: npm says which registry, package and action it needs a credential for, the provider answers with the credential and how long to cache it, and is told when the registry rejects it. Chaining, `npm login`/`logout` delegation, the security model, prior art |
| [Examples](examples/README.md) | How providers for real registries would answer, and where each is easy to get wrong |

The old address, [rfc-credential-provider.md](rfc-credential-provider.md), says where each of its sections went.

Phase 1 changes nothing for anyone who has not configured a helper, Phase 2 nothing for anyone who has not configured a provider, and both are configured only in the user's own user or global npm config.

## Evidence

| Document | What it holds |
|---|---|
| [prototype.md](prototype.md) | The Phase 1 prototype in npm/cli and npm-registry-fetch, how it is checked, and what each review round found |
| [claims.md](claims.md) | Every checkable statement in the two documents and what backs it: a source, a test, a measurement |
| [stage-tiers-test.md](stage-tiers-test.md) | The live test of which npmjs.com tokens read `/-/stage`, and its result |
| [poc/patches](poc/patches) | The prototype as patches against upstream npm/cli and npm-registry-fetch |

## Conformance material for Phase 2

| Artifact | What it is |
|---|---|
| [spec/protocol-v1.schema.json](spec/protocol-v1.schema.json) | JSON Schema of every message |
| [spec/policy-v1.json](spec/policy-v1.json), [summary](spec/generated-policy-summary.md) | The rules as data: timeouts, cache, fallback, chain, rejection |
| [tests/generated_protocol_vectors.json](tests/generated_protocol_vectors.json) | Valid and invalid messages generated from the policy |
| [tests/](tests) | An executable Python model of the client, with transcripts; [conformance matrix](tests/conformance_matrix.md) |
| [poc/rust](poc/rust) | A Rust client and mock provider pair |

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
| `NPM_REGISTRY_FETCH` naming a checkout with the Phase 1 prototype ([prototype.md](prototype.md#reproducing-the-checks)) | the helper comparison of `test_helper_differential` |

With `REQUIRE_TOOLS=1` ([tests/tools_required.py](tests/tools_required.py)) a missing tool fails the run instead. The `conformance` and `fuzz` workflows set it; a plain run does not. The one exception is `PrototypeTests` in `test_helper_differential`, which skips without `NPM_REGISTRY_FETCH` either way; the `prototype` workflow runs that comparison through `tests.fuzz_helper`. `python -m unittest discover -v` shows every skip and its reason: a run with skips has not run those checks.

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

End-to-end check of the Phase 1 prototype, given local checkouts of npm/cli and npm/npm-registry-fetch carrying the prototype (it lays the prototype over npm's bundled npm-registry-fetch and restores it on exit). The `token-helper` branches are not published: the checkouts are made by applying the patches of `poc/patches` to the upstream commits they were made on, with the steps CI runs, in [prototype.md](prototype.md#reproducing-the-checks):

```sh
node poc/npm-e2e/run.js <npm-cli checkout> <npm-registry-fetch checkout>
```

## Prior art

- [pnpm `tokenHelper`](https://pnpm.io/settings#urltokenhelper): the Phase 1 model.
- [Cargo credential provider protocol](https://doc.rust-lang.org/cargo/reference/credential-provider-protocol.html): version negotiation, JSON over stdin/stdout, cache policy, operation context, chaining.
- [Git credential helpers](https://git-scm.com/docs/gitcredentials) and [Docker credential helpers](https://docs.docker.com/reference/cli/docker/login/#credential-stores): a decade of external credential programs.
- [NuGet cross-platform plugins](https://learn.microsoft.com/en-us/nuget/reference/extensibility/nuget-cross-platform-plugins) and [authentication plugins](https://learn.microsoft.com/en-us/nuget/reference/extensibility/nuget-cross-platform-authentication-plugin): the closest prior art to Phase 2.
- [pip keyring support](https://pip.pypa.io/en/stable/topics/authentication/), [AWS SDK credential providers](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-credential-providers.html), [Azure Identity `DefaultAzureCredential`](https://learn.microsoft.com/en-us/javascript/api/%40azure/identity/defaultazurecredential): credential chains in other ecosystems.

## Sources

Every address the documents cite is in [refs.json](refs.json), with its kind, the day it was first cited and, for a page, the sha256 of the text saved from it. Links to source code name a commit. The saved texts stay on the machine that made them, in `.refs/` (not tracked); `python tools/refs.py fetch N` saves the pages not saved yet, and fetching a page yourself and comparing the hash checks a claim against the page as it was.
