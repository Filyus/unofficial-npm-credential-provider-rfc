# Unofficial npm credential provider RFC draft

An independent proposal for letting npm get registry credentials from a user-configured program at the moment it needs them, instead of reading a long-lived secret from `.npmrc` or the environment. It builds on the [npm/rfcs#850](https://github.com/npm/rfcs/pull/850) discussion and answers [npm/cli#8141](https://github.com/npm/cli/issues/8141). It is not an accepted npm RFC.

## The proposal

| Document | What it is |
|---|---|
| [Phase 1: `tokenHelper`](phase-1-token-helper.md) | pnpm's per-registry `tokenHelper` for npm: an executable prints a token, npm sends it. The motivation, and the trust rule both phases follow. Small enough to land on its own |
| [Phase 2: credential provider protocol](phase-2-credential-provider.md) | A versioned JSON protocol modelled on Cargo's: npm says which registry, package and action it needs a credential for, the provider answers with the credential and how long to cache it, and is told when the registry rejects it. Chaining, `npm login`/`logout` delegation, the security model, prior art |
| [Examples](examples/README.md) | How providers for real registries would answer, and where each is easy to get wrong |

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

```sh
python tools/generate_from_policy.py --check
python -m unittest discover -v
cargo test --manifest-path poc/rust/Cargo.toml
node tools/check-links.js
```

End-to-end check of the Phase 1 prototype, given local checkouts of npm/cli and npm/npm-registry-fetch on their `token-helper` branches (it lays the prototype over npm's bundled npm-registry-fetch and restores it on exit):

```sh
node poc/npm-e2e/run.js <npm-cli checkout> <npm-registry-fetch checkout>
```

## Prior art

- [pnpm `tokenHelper`](https://pnpm.io/settings#urltokenhelper): the Phase 1 model.
- [Cargo credential provider protocol](https://doc.rust-lang.org/cargo/reference/credential-provider-protocol.html): version negotiation, JSON over stdin/stdout, cache policy, operation context, chaining.
- [Git credential helpers](https://git-scm.com/docs/gitcredentials) and [Docker credential helpers](https://docs.docker.com/reference/cli/docker/login/#credential-stores): a decade of external credential programs.
- [NuGet cross-platform plugins](https://learn.microsoft.com/en-us/nuget/reference/extensibility/nuget-cross-platform-plugins) and [authentication plugins](https://learn.microsoft.com/en-us/nuget/reference/extensibility/nuget-cross-platform-authentication-plugin): the closest prior art to Phase 2.
- [pip keyring support](https://pip.pypa.io/en/stable/topics/authentication/), [AWS SDK credential providers](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-credential-providers.html), [Azure Identity `DefaultAzureCredential`](https://learn.microsoft.com/en-us/javascript/api/%40azure/identity/defaultazurecredential): credential chains in other ecosystems.
