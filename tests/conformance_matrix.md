# Protocol Conformance Matrix

This matrix keeps the executable checks grouped by protocol layer.

| Layer | Cases |
|---|---|
| Handshake | valid v1, capabilities recorded, malformed hello, malformed capabilities, no compatible version, fallback-enabled version mismatch, close-before-ready |
| Request schema | unknown request kind, removed kinds (`get-batch`, `refresh`) rejected, missing registry, missing operation, missing interactive, every npm write action accepted as an operation, coarse or unknown operation rejected, `publish` and `stage` without version, `retry` without `httpStatus`, invalid `httpStatus`, invalid `authChallenges`, unlisted `command` accepted, unknown fields ignored |
| Response schema | exactly one of `Ok`/`Err`, required `Ok.kind`, invalid `Ok`, `Ok` for a removed kind, invalid `Err`, bearer/basic auth validation, unknown auth type, invalid cache, missing `expiresAt`, invalid granularity, invalid `operationIndependent`, unknown fields ignored |
| JSON Schema | schema artifact is valid draft 2020-12 JSON Schema, generated positive and negative protocol vectors validate when `jsonschema` is installed |
| Spec consistency | schema enums, operations that require `version`, hello capabilities, policy values, and Python model constants stay in sync |
| Codegen | generated Python/Rust constants, policy summary, and protocol vectors are fresh relative to `spec/policy-v1.json` |
| Errors | `url-not-supported`, `not-found` fail-closed, explicit legacy fallback, `operation-not-supported` fails for every kind, `other` |
| Cache | `registry`, `scope`, `package`, `cache=never`, `cache=session`, `cache=expires`, `operationIndependent=false`, lookup most-specific-first, operation-bound before operation-independent, a `stage` token never serves `publish`, expiry margin, no key collision between levels |
| Token helper (Phase 1) | raw token sent as `Bearer`, output with a scheme used as the header, empty output and non-zero exit fail, user/global config only, absolute path without arguments only |
| Resolution | project config rejected, workspace config rejected, global/user config accepted, project `node_modules` ignored, current directory ignored, PATH-like locations ignored, ambiguous trusted providers fail closed |
| Transcripts | get success, provider chain, not-found, version mismatch, erase followed by one retry with `httpStatus` |
| Subprocess | valid get, expiring token re-acquired with a plain `get`, login/logout/erase, malformed auth, invalid JSON, no hello, both `Ok`/`Err`, provider timeout |
| Rust PoC | real client/provider exchange for get and publish, fail-closed errors, malformed wire responses, provider chaining, several sequential requests in one provider process, unknown request kind and unknown operation refused without ending the session, oversized line rejected whole, secrets redacted from `Debug` |
