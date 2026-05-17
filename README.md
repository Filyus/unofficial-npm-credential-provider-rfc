# Unofficial npm Credential Provider RFC Draft

This repository contains an independent draft proposal for an npm credential provider protocol, intended for discussion and iteration with the npm RFC process: [rfc-credential-provider.md](./rfc-credential-provider.md).

It is not yet an accepted npm RFC.

Related discussion:

- [npm/rfcs#850](https://github.com/npm/rfcs/pull/850)

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
