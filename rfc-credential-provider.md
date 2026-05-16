# RFC: Credential Provider Plugin Protocol

> Status: Draft  
> Revision: 2  
> Date: 2026-05-16

> A draft protocol proposal building on the [npm/rfcs#850](https://github.com/npm/rfcs/pull/850) discussion, addressing per-package authentication granularity, bidirectional protocol, provider discovery, and provider execution safety.

## Motivation

The npm ecosystem relies on plaintext tokens in `.npmrc` or environment variables for registry authentication. This design has not changed since 2010. [RFC #850](https://github.com/pwoosam/npm-rfcs/blob/users/pwoosam/credential-provider-plugin/accepted/0000-credential-provider-plugin.md) proposes a credential provider protocol to address this. This draft explores a more explicit protocol and trust model for that direction:

1. **No per-package granularity.** Auth is still per-registry URL. Modern registries (GitLab, GitHub) offer fine-grained tokens scoped to specific projects/packages, but the client cannot leverage this — one registry URL means one token.

2. **No runtime context.** The provider receives nothing on stdin. It only knows the registry URL from hardcoded arguments in `.npmrc`. Compare with Git credential helpers, which receive `protocol`, `host`, and `path` on stdin.

3. **No protocol versioning.** RFC #850 references Cargo's versioned protocol as prior art but does not include a version field itself.

4. **No refresh flow.** Only `expiresAt` is provided. The client re-invokes the provider from scratch — no continuity between invocations.

5. **No discovery.** Providers must be manually configured. Every developer repeats the same setup.

This RFC draft proposes a protocol shape that addresses these gaps while remaining simple to implement and explicit about provider execution boundaries.

## Goals

- Enable **per-package** or **per-scope** token granularity when the registry supports it
- Pass **runtime context** (registry, scope, package) to the provider
- Include **protocol versioning** from day one
- Support **token refresh** without full re-authentication
- Provide a **discovery mechanism** for providers
- Maintain **backward compatibility** with existing `.npmrc` auth

## Non-Goals

- Mandating a specific identity provider or auth flow
- Requiring OS keychain integration (providers may implement it internally)
- Persisting tokens to disk (client holds tokens in-memory only)
- Replacing `.npmrc` — this is an opt-in addition

## Detailed Design

### 1. Configuration

Credential provider execution must be controlled by the user or an administrator, not by project contents. The npm client only accepts `credentialProvider` configuration from user-level or global npm config. Project and workspace `.npmrc` files may configure registries as they do today, but they must not enable or override credential provider execution.

```ini
# ~/.npmrc or global npmrc

# Global provider (fallback for all registries)
credentialProvider=npm-credential-provider-gitlab

# Per-registry provider
//gitlab.example.com:credentialProvider=npm-credential-provider-gitlab

# Per-registry with arguments
//gitlab.example.com:credentialProvider=npm-credential-provider-gitlab --instance https://gitlab.example.com
```

Provider commands are resolved deterministically from trusted sources only:

1. npm-shipped providers for npm-owned registries.
2. Absolute paths configured in user-level or global npm config.
3. Provider names found in npm-managed global bin directories.
4. Enterprise-managed allowlists, where npm is running under such policy.

The current working directory and project-local `node_modules/.bin` are never searched. Arbitrary `PATH` lookup is not used as the trust anchor for project installs. If a provider name is ambiguous across trusted sources, npm fails closed and asks the user to configure a more specific provider path.

Arguments are allowed only in user-level or global configuration.

### 2. Protocol

The client communicates with the provider via **stdin/stdout** using **single-line JSON messages** (no embedded newlines). The provider is invoked as a child process.

#### Version Negotiation (inspired by Cargo)

On startup, the provider sends a hello message listing supported protocol versions:

```json
{"v":[1]}
```

The client selects a compatible version and uses it in all subsequent messages. If no version matches, the client terminates the provider. Legacy auth fallback is used only when no provider was explicitly configured or when the user/global config explicitly allows fallback.

This allows providers to support multiple protocol versions simultaneously, enabling forward-compatible upgrades without breaking changes.

#### Request (client -> provider via stdin)

**Install (read):**
```json
{"v":1,"action":"get","registry":"https://gitlab.example.com/api/v4/projects/123/packages/npm/","scope":"@scope","package":"package","operation":"install","interactive":false}
```

**Publish (write) — includes `version`:**
```json
{"v":1,"action":"get","registry":"https://gitlab.example.com/api/v4/projects/123/packages/npm/","scope":"@scope","package":"package","version":"2.4.1","operation":"publish","interactive":true}
```

Readable form (publish):

```json
{
  "v": 1,
  "action": "get",
  "registry": "https://gitlab.example.com/api/v4/projects/123/packages/npm/",
  "scope": "@scope",
  "package": "package",
  "version": "2.4.1",
  "operation": "publish",
  "interactive": true
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `v` | number | yes | Negotiated protocol version. |
| `action` | string | yes | `"login"`, `"logout"`, `"get"`, `"get-batch"`, `"refresh"`, `"erase"`. |
| `registry` | string | yes | Full registry URL for the request. |
| `scope` | string | no | Package scope (e.g. `@scope`). Null for unscoped packages. |
| `package` | string | no | Package name (e.g. `package`). May be absent for registry-level operations like `npm search`. |
| `version` | string | no | Package version. Sent for `"publish"` operation only. Allows provider to scope tokens or log for audit. |
| `operation` | string | yes | `"install"`, `"publish"`, `"search"`, `"view"`. |
| `interactive` | boolean | yes | Whether the client can display prompts (for MFA flows). |

The client sends all available context: `scope`, `package`, and for publish — `version`. Sending full context costs nothing. Not sending it would permanently prevent future providers from using it. The **provider** decides the granularity via the `granularity` response field — a simple provider ignores everything and returns `"granularity": "registry"`, a scope-aware provider returns `"granularity": "scope"`, etc.

Install and publish are fundamentally different: install is read-only and batched (many packages, speed matters), publish is write and singular (one package, security matters). The protocol reflects this — `get-batch` optimizes install, while publish sends maximum context (`scope` + `package` + `version`) for fine-grained authorization.

#### Success Response (provider -> client via stdout)

```json
{"Ok":{"auth":{"type":"bearer","token":"glpat-xxxxxxxxxxxx"},"cache":"expires","expiresAt":1744200000,"operationIndependent":true,"refreshToken":"rt-xxxxxxxxxxxx","granularity":"scope"}}
```

Readable form:

```json
{
  "Ok": {
    "auth": {
      "type": "bearer",
      "token": "glpat-xxxxxxxxxxxx"
    },
    "cache": "expires",
    "expiresAt": 1744200000,
    "operationIndependent": true,
    "refreshToken": "rt-xxxxxxxxxxxx",
    "granularity": "scope"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `Ok.auth` | object | yes | Auth credentials. See Auth Types below. |
| `Ok.auth.type` | string | yes | `"bearer"` or `"basic"`. |
| `Ok.cache` | string | no | `"never"` — do not cache. `"session"` — cache for current process. `"expires"` — cache until `expiresAt`. Default: `"session"`. |
| `Ok.expiresAt` | number | no | Unix timestamp (seconds). Required if `cache` is `"expires"`. |
| `Ok.operationIndependent` | boolean | no | If `true`, token works for any operation (install, publish, etc.). If `false`, client re-requests for different operations. Default: `true`. The client does not enforce operation separation — it's the provider's and registry's responsibility to scope tokens. The `operation` field in the request is informational. |
| `Ok.refreshToken` | string | no | Opaque string passed back in `"refresh"` action. Provider-defined format. |
| `Ok.granularity` | string | no | `"registry"`, `"scope"`, or `"package"`. Tells the client how broadly to cache this token. Default: `"registry"`. |

#### Auth Types

Explicit `type` field — no guessing by field presence. The client constructs the HTTP `Authorization` header based on the type.

**Bearer token** — client sends `Authorization: Bearer <token>`:
```json
{ "type": "bearer", "token": "glpat-xxxxxxxxxxxx" }
```

**Basic auth** — client encodes `username:password` to base64 and sends `Authorization: Basic <base64>`:
```json
{ "type": "basic", "username": "deploy-token", "password": "glpat-xxxxxxxxxxxx" }
```

No legacy `_` prefixes, no pre-encoded base64. Provider returns plain values, client handles encoding.

> **Note:** RFC #850 also has `_auth` (pre-encoded base64 string). Intentionally omitted here — if provider knows the credentials, it should return them as `"basic"` with plain `username`/`password`, and the client encodes. The `_auth` format exists only for legacy `.npmrc` compatibility, which a new protocol does not need.

#### Error Response

```json
{"Err":{"kind":"url-not-supported"}}
```

| Error kind | Meaning | Client behavior |
|---|---|---|
| `"url-not-supported"` | Provider does not handle this registry. | Try next provider in chain (see below). |
| `"not-found"` | No credentials stored for this registry/scope. | Fail by default if a provider was explicitly configured. Legacy fallback is allowed only through an explicit user/global opt-in. |
| `"operation-not-supported"` | Provider does not support this action (e.g. `refresh`). | For `refresh`, fall back to `"get"`. For `login`/`logout`, show an unsupported-operation error. |
| `"other"` | Generic error. Includes `message` and optional `causedBy` array. | Show error to user. Do not silently fall back to legacy credentials unless explicit fallback is enabled. |

**Provider chaining:** Multiple providers can be configured. The client tries them in order — first `Ok` wins, `url-not-supported` means "skip me, try next". Any other error stops the chain.

```ini
# ~/.npmrc — two providers, tried in order
credentialProvider=npm-credential-provider-gitlab
credentialProvider=npm-credential-provider-github
```

This enables a fallback pattern: a primary OAuth provider + a secondary file-based provider as fallback.

Legacy `.npmrc` auth remains the default behavior when no provider is configured. Once a provider is explicitly configured for a registry, silent fallback to plaintext token sources should be avoided because it can mask provider failures and reintroduce the secret-storage behavior the user was trying to remove. A user or administrator may opt into legacy fallback explicitly for migration.

Example of a detailed error:
```json
{
  "Err": {
    "kind": "other",
    "message": "Token has expired. Re-authenticate with your credential provider.",
    "causedBy": ["OAuth refresh token was revoked"]
  }
}
```

Provider writes diagnostic info to stderr (for `--loglevel verbose`).

#### Session Lifecycle

The client keeps the provider process alive for the duration of the npm command. Multiple requests can be sent within one session (e.g., tokens for different scopes during a single `npm install`).

The client **closes stdin** to signal end of session. The provider should exit cleanly.

**Timeouts per action:**

| Action | Timeout | Rationale |
|---|---|---|
| `get` | 30 seconds | Network call to credential store or API. |
| `get-batch` | 60 seconds | Multiple token requests, may involve several API calls. |
| `refresh` | 30 seconds | Same as `get`. |
| `erase` | 10 seconds | Local cleanup, near-instant. |
| `login` | 5 minutes | User interaction: browser OAuth, SSO redirect, MFA prompt. |
| `logout` | 30 seconds | May include server-side token revocation. |

If a provider exceeds the timeout, the client kills the process. For `get`, npm fails by default unless explicit legacy fallback is enabled. For `login`/`logout`, npm shows an error.

#### Non-interactive and CI behavior

When `interactive` is `false`, providers must not open browsers, prompt for MFA, wait for device-code approval, or ask the user to approve a new trust decision. They may only use credentials and trust decisions that already exist.

In CI, provider execution should be deterministic: the provider must already be configured through user/global config, a machine image, or enterprise policy, and it must resolve from a trusted source. If no usable credential is available, npm should fail with a clear error rather than prompting or falling back silently.

### 3. Actions

#### `login` — Authenticate with Registry

Triggered by `npm login --registry gitlab.example.com`. The client delegates authentication entirely to the provider, enabling OAuth, SSO, device code flow, MFA, and other modern auth methods that `npm login` cannot handle natively.

```json
{"v":1,"action":"login","registry":"https://gitlab.example.com/api/v4/packages/npm/","interactive":true}
```

Optional fields the client may include:

| Field | Type | Description |
|---|---|---|
| `token` | string | If the user provides a token directly (e.g. `npm login --token glpat-xxx`), it is passed here. Provider should store it. |
| `loginUrl` | string | URL the user can visit to obtain a token (if known from registry metadata). |

The provider performs the auth flow (e.g. opens browser for OAuth, waits for callback) and stores the resulting credentials in its own secure storage (OS keychain, encrypted file, etc.).

Response:
```json
{"Ok":{"kind":"login"}}
```

If the provider does not support interactive login:
```json
{"Err":{"kind":"operation-not-supported"}}
```

**Supported auth flows:**

| Flow | How provider handles it |
|---|---|
| **OAuth 2.0 / OIDC** | Opens browser → authorization code → exchange for token → store in keychain |
| **Device Code** | Displays URL + code in stderr → polls for approval → store token |
| **SSO / SAML** | Opens browser → SSO redirect → callback → store token |
| **MFA / 2FA** | Prompts via stderr (if `interactive: true`) → validates → store token |
| **Static token** | Receives `token` field → stores in keychain |

#### `logout` — Remove Stored Credentials

Triggered by `npm logout --registry gitlab.example.com`. The provider removes all stored credentials for this registry from its secure storage.

```json
{"v":1,"action":"logout","registry":"https://gitlab.example.com/api/v4/packages/npm/"}
```

Response:
```json
{"Ok":{"kind":"logout"}}
```

If nothing to remove:
```json
{"Err":{"kind":"not-found"}}
```

The provider should follow a two-step approach:

1. **Attempt** server-side revocation (e.g. call `POST /oauth/revoke`). Best-effort — a network failure must not block logout.
2. **Always** remove local credentials, regardless of revocation result.

Response is `{"Ok":{"kind":"logout"}}` even if server-side revocation failed. The provider logs a warning to stderr but does not return an error — the user's intent is to remove local credentials, and that must always succeed.

#### `get` — Request Token

Client sends context, provider returns a token. The primary runtime flow. See request/response format above.

#### `refresh` — Refresh Token

When a cached token approaches `expiresAt`, the client sends:

```json
{"v":1,"action":"refresh","registry":"https://gitlab.example.com/api/v4/projects/123/packages/npm/","refreshToken":"rt-xxxxxxxxxxxx"}
```

The provider uses the refresh token to obtain a new access token without full re-authentication. Returns the same `Ok` response as `get`.

If provider returns `{"Err":{"kind":"operation-not-supported"}}`, the client falls back to `"get"`.

#### `get-batch` — Request Tokens in Bulk

When the client needs tokens for multiple packages from the same registry (e.g. `npm install` resolving 50 packages from one private registry), it can send a single batch request instead of 50 individual `get` calls:

```json
{"v":1,"action":"get-batch","registry":"https://gitlab.example.com/api/v4/packages/npm/","operation":"install","interactive":false,"packages":[{"scope":"@scope","package":"api-client"},{"scope":"@scope","package":"ui"},{"scope":"@other","package":"config"}]}
```

The provider returns an array of results, one per package (same order):

```json
{"Ok":{"kind":"get-batch","results":[{"auth":{"type":"bearer","token":"glpat-aaa"},"granularity":"scope"},{"auth":{"type":"bearer","token":"glpat-aaa"},"granularity":"scope"},{"auth":{"type":"bearer","token":"glpat-bbb"},"granularity":"scope"}],"cache":"session"}}
```

The provider may return the same token for multiple packages (as above — `@scope/*` shares one token). Cache fields (`cache`, `expiresAt`, `operationIndependent`) apply to all tokens in the batch. Per-token overrides are not supported — if tokens have different lifetimes, use individual `get` calls.

If provider returns `{"Err":{"kind":"operation-not-supported"}}`, the client falls back to individual `get` calls. This keeps simple providers simple — `get-batch` is an optimization, not a requirement.

#### `erase` — Token Rejected

If the registry returns 401/403, the client notifies the provider:

```json
{"v":1,"action":"erase","registry":"https://gitlab.example.com/api/v4/projects/123/packages/npm/","scope":"@scope"}
```

The provider should invalidate cached credentials. Response: `{"Ok":{"kind":"erase"}}` or an error.

### 4. Caching

The client caches tokens in-memory based on the `granularity` field:

| Granularity | Cache key | Effect |
|---|---|---|
| `"registry"` | registry URL | One token for all packages on this registry. Same behavior as today. |
| `"scope"` | registry URL + scope | Different tokens for `@scope-a/*` and `@scope-b/*` on the same registry. |
| `"package"` | registry URL + scope + package | Different tokens per individual package. Maximum granularity. |

When the client needs a token, it checks the cache from most specific to least specific. On cache miss, it invokes the provider.

Tokens are **never persisted to disk** by the client.

### 5. Provider Discovery

#### Convention-based discovery (suggestion only)

If no `credentialProvider` is configured for a registry and authentication fails, the client may look for a provider matching the naming convention `npm-credential-provider-<registry-host>` in trusted global discovery locations only. If found, the client **suggests** it to the user but **never auto-installs or auto-executes** it:

```
$ npm install @scope/package
npm ERR! 401 Unauthorized: @scope/package from https://gitlab.example.com/...
npm WARN found npm-credential-provider-gitlab installed globally
npm WARN to use it, add to ~/.npmrc:
npm WARN   //gitlab.example.com:credentialProvider=npm-credential-provider-gitlab
```

The user must explicitly add the line to user-level or global npm config. Project-local discovery is not performed. This limits typosquatting and shadowing attacks: a malicious `npm-credential-provider-gitlba` package or project-local binary may be present, but it is never executed without explicit trusted configuration.

#### Explicit configuration (required for execution)

```ini
//gitlab.example.com:credentialProvider=npm-credential-provider-gitlab
```

Explicit trusted configuration takes priority over discovery.

### 6. Security Model

This feature must not become a project-controlled install hook. Install scripts are selected by package authors and the dependency graph. Credential providers are selected by the user, the machine owner, or an enterprise administrator. A cloned repository, dependency package, lockfile, or project `.npmrc` must not be able to introduce a new credential provider executable.

**Trust boundaries:**

1. **Project `.npmrc`**: May not configure `credentialProvider`. If this key appears in a project or workspace `.npmrc`, npm ignores it and warns. Project config may continue to configure registry URLs and scopes.

2. **User `~/.npmrc` and global npm config**: May reference providers by absolute path or by a provider name resolved from trusted global locations.

3. **Provider resolution**: The current working directory and project `node_modules` are not searched. Local packages cannot shadow global providers. Ambiguous provider names fail closed.

4. **Provider output**: Validated by the client. Only expected JSON fields are accepted. Unexpected fields are ignored.

5. **Token storage**: In-memory only. The client never writes tokens to disk. The provider is responsible for its own credential storage (keychain, encrypted file, etc.).

6. **Stdin input**: The client sends only the fields defined in the protocol. No environment variables or filesystem paths are leaked to the provider.

### 7. Provider Lifecycle

```
npm install @scope/package
  |
  |-- Spawn provider as child process
  |     |-- Provider sends hello: {"v":[1]}
  |     |-- Client selects version
  |
  |-- Need token for registry X, scope Y, package Z
  |     |
  |     |-- Check in-memory cache (by granularity + operationIndependent)
  |     |     |-- Hit + cache:"session" -> use cached token
  |     |     |-- Hit + cache:"expires" + not expired -> use cached token
  |     |     |-- Hit + cache:"expires" + near expiry + has refreshToken -> action: "refresh"
  |     |     |-- Miss -> action: "get"
  |     |
  |     |-- Send JSON request to provider stdin (single line)
  |     |-- Read JSON response from provider stdout (single line)
  |     |     |-- "Ok" -> cache token, use for HTTP request
  |     |     |-- "Err: url-not-supported" -> try next provider
  |     |     |-- "Err: not-found" -> fail unless explicit legacy fallback is enabled
  |     |     |-- "Err: other" -> show error to user
  |     |
  |     |-- Use token for HTTP request
  |     |     |-- 401/403 -> action: "erase", then retry with "get"
  |
  |-- Need token for another scope/package (same session)
  |     |-- Reuse same provider process, send another request
  |
  |-- All requests complete
  |     |-- Close stdin -> provider exits
  |     |-- Cache discarded
```

### 8. Example: GitLab Provider

A hypothetical `npm-credential-provider-gitlab` that leverages GitLab fine-grained tokens:

**Setup (one-time):**
```bash
# 1. Install provider
npm install -g npm-credential-provider-gitlab

# 2. Configure in ~/.npmrc
# //gitlab.example.com:credentialProvider=npm-credential-provider-gitlab --instance https://gitlab.example.com

# 3. Login — provider handles OAuth automatically
npm login --registry https://gitlab.example.com
# Opens browser → GitLab OAuth → stores refresh token in OS keychain
```

No custom CLI commands needed. Standard `npm login` delegates to the provider's `login` action.

**What happens on `npm install`:**

1. npm spawns provider, provider sends `{"v":[1]}`
2. npm needs `@scope/package` from `gitlab.example.com`, sends:
   ```
   {"v":1,"action":"get","registry":"https://gitlab.example.com/api/v4/projects/42/packages/npm/","scope":"@scope","package":"package","operation":"install","interactive":false}
   ```
3. Provider reads refresh token from OS keychain
4. Provider requests a short-lived token from GitLab API, scoped to project 42 with `read_package_registry` permission
5. Provider responds:
   ```
   {"Ok":{"auth":{"type":"bearer","token":"glpat-short-lived"},"cache":"expires","expiresAt":1744201800,"operationIndependent":true,"refreshToken":"stored-in-keychain","granularity":"scope"}}
   ```
6. npm caches token for `@scope` scope (`granularity: "scope"`), uses it for all packages in that scope
7. npm needs another package from same scope — cache hit, no provider invocation
8. All done — npm closes stdin, provider exits

**Result:** Fine-grained GitLab token, short-lived, per-scope, stored in OS keychain. Developer configured it once. Provider process stayed alive for the whole session.

## Comparison with RFC #850

| Aspect | RFC #850 | This proposal |
|---|---|---|
| **Actions** | get only | login, logout, get, get-batch, refresh, erase |
| **Auth flows** | Not specified | OAuth, SSO, device code, MFA via `login` action |
| **Granularity** | Per-registry only | Per-registry, per-scope, or per-package |
| **Provider input** | No stdin, args only | JSON on stdin with full context |
| **Protocol versioning** | None | Hello message `{"v":[1]}` + `v` in every message |
| **Refresh flow** | None (re-invoke from scratch) | `"refresh"` action with refresh token |
| **Token rejection** | Not specified | `"erase"` action (like git credential helpers) |
| **Cache control** | `expiresAt` only | `cache` (`never`/`session`/`expires`) + `operationIndependent` + `granularity` |
| **Provider chaining** | Not specified | `"url-not-supported"` error → try next provider |
| **Session model** | One process per request | Provider stays alive, multiple requests per session |
| **Discovery** | None (explicit config only) | Convention-based + explicit config |
| **Complexity** | Lower | Higher (more protocol surface) |

## Backward Compatibility

- If no `credentialProvider` is configured, behavior is identical to current npm
- `credentialProvider` entries in project or workspace `.npmrc` are ignored by design
- If a provider is configured and fails, legacy auth fallback requires explicit user/global opt-in
- Providers that only support registry-level auth can ignore `scope` and `package` fields and return `"granularity": "registry"`

## Prior Art

### Protocol Comparison

| | Git | Docker | pnpm tokenHelper | Cargo | npm RFC #850 | This proposal |
|---|---|---|---|---|---|---|
| **Year** | 2012 | 2016 | 2022 | 2023 | 2025 | 2026 |
| **Format** | key=value | JSON | Plain string | JSON (single-line) | JSON | JSON (single-line) |
| **Direction** | Bidirectional | Bidirectional | Unidirectional | Bidirectional | Unidirectional | Bidirectional |
| **Actions** | get, store, erase | get, store, erase | get only | get, login, logout | get only | login, logout, get, get-batch, refresh, erase |
| **Auth flows (OAuth/SSO)** | No | No | No | Yes (via login) | No | Yes (via login) |
| **Context on input** | protocol, host, path | ServerURL | None | registry, name, operation, package | None (args only) | registry, scope, package, operation |
| **Granularity** | Per-host | Per-ServerURL | Per-registry | Per-registry | Per-registry | Per-registry, per-scope, or per-package |
| **Versioning** | None | None | None | Hello message `{"v":[1]}` | None | Hello message + `v` in every message |
| **Auth type** | Implicit (key=value) | Implicit (field presence) | Plain string | Raw token string | Implicit (`_authToken`/`_auth`/`_password`) | Explicit `type: bearer/basic` |
| **Refresh tokens** | No | No | No | No | No | Yes (`refresh` action) |
| **Cache control** | None (helper stores) | None (helper stores) | None | `never`/`session`/`expires` | `expiresAt` only | `cache` + `expiresAt` + `granularity` + `operationIndependent` |
| **Provider chaining** | Yes (try next on fail) | No | No | Yes (`url-not-supported`) | No | Yes (`url-not-supported`) |
| **Session (process reuse)** | No (new process per action) | No | No | Yes (stdin/stdout) | No | Yes (stdin/stdout) |
| **Batch requests** | No | No | No | No | No | Yes (`get-batch`) |
| **Discovery** | `git-credential-*` (auto) | `docker-credential-*` (auto) | Explicit config | Explicit config | Explicit config | `npm-credential-provider-*` (suggest only) + explicit |
| **Structured errors** | No | No | No | Yes (`kind`) | No | Yes (`kind` + `message` + `causedBy`) |
| **Arguments** | Action as CLI arg | Action as CLI arg | Forbidden | `--cargo-plugin` + args | Allowed in config | Allowed in config |
| **Production-tested** | Yes (13 years) | Yes (10 years) | Yes (4 years) | Yes (3 years) | No (RFC stage) | No (proposal) |

### Git Credential Helpers (2012)

The oldest and most battle-tested. Protocol is key=value pairs on stdin/stdout (not JSON):

```
protocol=https
host=github.com
username=user
password=token
```

Three actions: `get` (read credential), `store` (save after success), `erase` (delete after rejection). Multiple helpers can be chained — if one doesn't know, the next is tried.

Simple, but the format is flat and not extensible. No versioning — changes require new helpers.

### Docker Credential Helpers (2016)

JSON protocol. Action passed as CLI argument (`docker-credential-osxkeychain get`). Input/output on stdin/stdout.

`get` receives ServerURL as plain string, returns JSON:
```json
{ "ServerURL": "https://index.docker.io/v1", "Username": "user", "Secret": "token" }
```

Convention-based naming: `docker-credential-<backend>` (osxkeychain, secretservice, wincred). Docker auto-discovers by name in `~/.docker/config.json`.

No versioning, no cache control. Provider manages its own storage.

### Cargo Credential Providers (2023)

The most sophisticated. JSON messages on stdin/stdout (one line per message). Provider is invoked with `--cargo-plugin`.

**Version negotiation:** Provider sends `{"v": [1]}` on startup. Cargo picks a compatible version. Forward-compatible by design.

**Rich context:** Cargo sends registry URL, registry name, operation (`read`/`publish`), and for publish — package name, version, checksum.

**Cache control:** Provider specifies `"cache": "never" | "session" | "expires"` with optional `expiration` timestamp. Also `operation_independent: true/false` — whether the same token works for both read and publish.

**Provider chaining:** If provider returns `"Err": {"kind": "url-not-supported"}`, Cargo tries the next provider.

```json
// Request
{"v":1, "kind":"get", "operation":"read", "registry":{"index-url":"https://...", "name":"my-registry"}}

// Response
{"Ok": {"kind":"get", "token":"...", "cache":"session", "operation_independent":true}}
```

**This proposal is closest to Cargo's approach**, with the addition of: scope/package-level granularity, refresh flow, batch requests, explicit auth types, and login/logout with OAuth support. Cargo's publish context (name + version + checksum) inspired our `version` field for publish operations.

### pnpm tokenHelper (2022)

Minimal: run executable, read stdout as token string. No stdin, no arguments, no JSON, no versioning, no cache. Absolute path only, user `.npmrc` only. First attempt at dynamic auth in npm, but limited by design.

### npm RFC #850 (2025)

Improvement over tokenHelper: JSON response with `expiresAt`, arguments allowed, command resolved via PATH. But still unidirectional — provider receives no context from npm, only from its own hardcoded arguments.
