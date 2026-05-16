# Rust Protocol PoC

This workspace exercises the draft credential provider protocol with real stdin/stdout process exchange.

Crates:

- `credential-provider-protocol`: shared wire types and JSONL helpers.
- `mock-provider`: a provider process that sends hello and answers requests.
- `mock-client`: an npm-like client that spawns the provider and validates behavior.

Run:

```sh
cargo test --manifest-path poc/rust/Cargo.toml
```

Run the client manually:

```sh
cargo run --manifest-path poc/rust/Cargo.toml -p mock-client -- --provider cargo --provider-arg run --provider-arg --quiet --provider-arg --manifest-path --provider-arg poc/rust/Cargo.toml --provider-arg -p --provider-arg mock-provider --provider-arg -- --provider-arg --scenario --provider-arg get-success
```
