# Unofficial npm Credential Provider RFC Draft

This repository contains an independent draft proposal for an npm credential provider protocol, intended for discussion and iteration with the npm RFC process: [rfc-credential-provider.md](./rfc-credential-provider.md).

It is not yet an accepted npm RFC.

Related discussion:

- [npm/rfcs#850](https://github.com/npm/rfcs/pull/850)

Executable protocol checks:

```sh
python -m unittest discover -v
cargo test --manifest-path poc/rust/Cargo.toml
```
