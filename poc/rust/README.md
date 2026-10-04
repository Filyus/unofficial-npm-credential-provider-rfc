# Rust Protocol PoC

This workspace exercises the draft credential provider protocol with real stdin/stdout process exchange.

Crates:

- `credential-provider-protocol`: shared wire types and JSONL helpers. Lines are capped at `MAX_LINE_BYTES`; tokens, passwords and `refreshState` are `Secret` values that `Debug` never prints.
- `mock-provider`: a provider process that sends hello and answers requests, refusing unknown request kinds with `operation-not-supported`.
- `mock-client`: an npm-like client. `ProviderSession` keeps one provider process for a whole command and sends it strictly sequential requests; `run_provider_chain` demonstrates chaining.

Run:

```sh
cargo test --manifest-path poc/rust/Cargo.toml
```

Run the client manually:

```sh
cargo run --manifest-path poc/rust/Cargo.toml -p mock-client -- --provider cargo --provider-arg run --provider-arg --quiet --provider-arg --manifest-path --provider-arg poc/rust/Cargo.toml --provider-arg -p --provider-arg mock-provider --provider-arg -- --provider-arg --scenario --provider-arg get-success
```
