# Protocol Conformance Matrix

This matrix keeps the executable checks grouped by protocol layer.

| Layer | Cases |
|---|---|
| Handshake | valid v1, malformed hello, no compatible version, fallback-enabled version mismatch, close-before-ready |
| Request schema | unknown action, missing registry, missing operation, missing interactive, missing `refreshToken`, publish without version, `get-batch` without packages, unknown fields ignored |
| Response schema | exactly one of `Ok`/`Err`, invalid `Ok`, invalid `Err`, bearer/basic auth validation, unknown auth type, invalid cache, missing `expiresAt`, invalid granularity, invalid `operationIndependent`, unknown fields ignored |
| JSON Schema | schema artifact is valid draft 2020-12 JSON Schema, generated positive and negative protocol vectors validate when `jsonschema` is installed |
| Spec consistency | schema enums, policy values, and Python model constants stay in sync |
| Codegen | generated Python/Rust constants, policy summary, and protocol vectors are fresh relative to `spec/policy-v1.json` |
| Errors | `url-not-supported`, `not-found` fail-closed, explicit legacy fallback, `operation-not-supported` for `refresh`, `operation-not-supported` for `get`, `other` |
| Cache | `registry`, `scope`, `package`, `cache=never`, `cache=session`, `cache=expires`, `operationIndependent=false`, batch result count |
| Resolution | project config rejected, workspace config rejected, global/user config accepted, project `node_modules` ignored, current directory ignored, PATH-like locations ignored, ambiguous trusted providers fail closed |
| Subprocess | valid get, refresh, batch, login/logout/erase, malformed auth, invalid JSON, no hello, both `Ok`/`Err`, batch mismatch, provider timeout |
| Rust PoC | real client/provider exchange for get, refresh, batch, fail-closed errors, malformed wire responses, provider chaining |
