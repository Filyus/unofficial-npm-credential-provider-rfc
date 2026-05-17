# Unofficial npm Credential Provider RFC Draft

This repository contains an independent draft proposal for an npm credential provider protocol, intended for discussion and iteration with the npm RFC process: [rfc-credential-provider.md](./rfc-credential-provider.md).

It is not yet an accepted npm RFC.

Related discussion:

- [npm/rfcs#850](https://github.com/npm/rfcs/pull/850)

Prior art and related credential models considered:

- [Cargo credential provider protocol](https://doc.rust-lang.org/cargo/reference/credential-provider-protocol.html) — version negotiation, JSON over stdin/stdout, cache policy, operation context, provider chaining.
- [Git credential helpers](https://git-scm.com/docs/gitcredentials) — long-running precedent for `get`/`store`/`erase`-style helper workflows and helper chaining.
- [Docker credential helpers](https://docs.docker.com/reference/cli/docker/login/#credential-stores) — external credential-store executables and `docker-credential-*` naming convention.
- [pnpm `tokenHelper`](https://pnpm.io/settings#urltokenhelper) — npm-compatible config surface with a deliberately narrow, user-level helper model.
- [NuGet cross-platform plugins](https://learn.microsoft.com/en-us/nuget/reference/extensibility/nuget-cross-platform-plugins) and [authentication plugins](https://learn.microsoft.com/en-us/nuget/reference/extensibility/nuget-cross-platform-authentication-plugin) — process-isolated plugins, discovery, protocol negotiation, and authenticated-feed use cases.
- [pip authentication / keyring provider](https://pip.pypa.io/en/stable/topics/authentication/) — package-manager integration with external secret storage.
- [AWS SDK credential providers](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-credential-providers.html) — ordered credential-provider chains, fallback behavior, and automatic refresh expectations.
- [Azure Identity `DefaultAzureCredential`](https://learn.microsoft.com/en-us/javascript/api/%40azure/identity/defaultazurecredential) — developer-friendly credential chains across local, CI, managed identity, and CLI-auth contexts.

Test coverage matrix:

- [tests/conformance_matrix.md](./tests/conformance_matrix.md)

Spec artifacts:

- [spec/protocol-v1.schema.json](./spec/protocol-v1.schema.json)
- [spec/policy-v1.json](./spec/policy-v1.json)
- [spec/generated-policy-summary.md](./spec/generated-policy-summary.md)
- [tests/generated_protocol_vectors.json](./tests/generated_protocol_vectors.json)

Executable protocol checks:

```sh
python tools/generate_from_policy.py --check
python -m unittest discover -v
cargo test --manifest-path poc/rust/Cargo.toml
```
