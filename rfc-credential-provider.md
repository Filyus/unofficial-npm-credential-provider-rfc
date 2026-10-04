# RFC: Credential Provider Protocol

> Status: Draft
> Revision: 5
> Date: 2026-10-04

> A draft proposal building on the [npm/rfcs#850](https://github.com/npm/rfcs/pull/850) discussion. It lets npm obtain registry credentials from a user-configured program at the moment it needs them, instead of reading a long-lived secret from `.npmrc` or the environment.

## Summary

npm gains two ways to ask an external program for registry credentials, delivered in phases:

1. **Phase 1: `tokenHelper`**, compatible with pnpm's setting of the same name. A user-configured executable prints a token; npm sends it as the `Authorization` header. This is what [npm/cli#8141](https://github.com/npm/cli/issues/8141) asks for, and it lets one helper serve both package managers.
2. **Phase 2: `credentialProvider`**, a small versioned JSON protocol over stdin/stdout, modelled on [Cargo's credential providers](https://doc.rust-lang.org/cargo/reference/credential-provider-protocol.html). npm tells the provider which registry, package and npm action it needs a credential for; the provider answers with the credential and how long npm may cache it, and is told when the registry rejects it.

Both are configured only in user-level or global npm config. Neither changes anything for a user who has not configured it.

## Motivation

### Registry credentials are standing secrets

npm registry authentication ends in a bearer secret stored in `.npmrc` (where `npm login` writes it) or passed through an environment variable. Every lifecycle script that runs during an install can read both. [RFC 0054](https://github.com/npm/rfcs/blob/main/accepted/0054-make-scripts-install-opt-in.md) records what that costs: the Shai-Hulud worm (September 2025) spread by stealing maintainer tokens from compromised machines and publishing infected versions of the victims' other packages.

### Registries already issue short-lived tokens, and npm cannot ask for them

The registries companies run next to npmjs.com already hand out short-lived credentials, but only to a tool that writes them somewhere npm will read:

- **AWS CodeArtifact**: tokens last 12 hours by default and 15 minutes at least; "When the lifetime expires, you must fetch another token." `aws codeartifact login --tool npm` writes the token into npm's config ([docs](https://docs.aws.amazon.com/codeartifact/latest/ug/tokens-authentication.html)).
- **Google Artifact Registry**: "Access tokens are valid for 60 minutes … If your access token has expired, you must generate a new access token" ([docs](https://docs.cloud.google.com/artifact-registry/docs/nodejs/authentication)).
- **Azure Artifacts**: `vsts-npm-auth` writes a personal access token into the user `.npmrc`.

So the trust in the third party already exists; what this proposal removes is the step that turns a short-lived credential into a file on disk, renewed by hand.

### npmjs.com itself is moving away from long-lived publish tokens

npm now offers stage-only granular tokens: they can `npm stage publish` a version for a maintainer to approve with 2FA, but cannot publish directly. Direct publishing with a granular access token is scheduled for removal in January 2027, and since August 2026 bypass-2FA tokens can no longer perform account-governance actions ([npm docs](https://docs.npmjs.com/about-access-tokens)). Credentials are becoming shorter-lived and more finely split by action. A client that can only read one static token per registry fits that direction poorly.

### npm is behind its neighbours

pnpm ships `tokenHelper` in both its TypeScript CLI and its Rust rewrite. Cargo has a versioned credential-provider protocol, Git and Docker have had credential helpers for a decade, NuGet has cross-platform authentication plugins, and pip delegates to keyring. In npm the request for the same thing, [npm/cli#8141](https://github.com/npm/cli/issues/8141), has 40 👍 and no maintainer reply since March 2025, and a `~/.npmrc` written for pnpm's `tokenHelper` silently gives npm no credentials at all.

## Scope

In scope:

- How npm obtains credentials for its own HTTP requests to registries.
- Delegating `npm login` and `npm logout` to a configured provider.

Out of scope:

- Credentials for lifecycle scripts. Scripts never receive provider credentials.
- Trusted publishing (OIDC) and the registry's own token model; both are unchanged.
- Git dependencies, proxies, and client certificates (`certfile`/`keyfile`).
- Protecting credentials from code that already runs as the same user. Such code can invoke a helper or provider exactly as npm does, just as any process can run `git credential fill`. What this design changes is what that code finds: no standing secret on disk or in the environment, short-lived tokens, and write credentials gated by the provider (see [Threat model](#threat-model)).

## Detailed Explanation

### Phase 1: `tokenHelper`

`tokenHelper` behaves as it does in pnpm, so an existing helper and an existing `~/.npmrc` work unchanged:

```ini
# ~/.npmrc or global npmrc only
tokenHelper=/usr/local/bin/default-registry-token
//npm.corp.example.com/:tokenHelper=/usr/local/bin/corp-registry-token
```

- **Where it may be set.** User-level or global npm config only. In a project or workspace `.npmrc` the key is ignored with a warning, and it is never read from `npm_config_*` environment variables.
- **What it may name.** An absolute path, with no arguments. On Windows a `.cmd` or `.bat` helper is run through `cmd.exe`, as pnpm does; anything else is executed directly, never through a shell.
- **When it runs.** Lazily, the first time a request needs a credential for that registry, and at most once per registry per npm process. A command that never touches the registry never runs the helper.
- **What it prints.** The token on stdout. npm trims trailing whitespace and sends `Authorization: Bearer <token>`. If the output already starts with an auth scheme (ASCII letters followed by a space, such as `Bearer …` or `Basic …`), npm uses it as the header value as is.
- **When it fails.** A non-zero exit, empty output, or running longer than 60 seconds fails the request with an error naming the helper. npm does not fall back to another credential for that registry. stderr is shown to the user as warnings.

A helper is often a two-line script around a vendor CLI, for example `aws codeartifact get-authorization-token --domain my-domain --query authorizationToken --output text`, or `gh auth token` for GitHub Packages. Phase 1 has no context, no cache control and no way to learn that a token was rejected; those are what Phase 2 adds.

### Phase 2: `credentialProvider`

#### 1. Configuration

Credential provider execution must be controlled by the user or an administrator, not by project contents. The npm client only accepts `credentialProvider` configuration from user-level or global npm config. Project and workspace `.npmrc` files may configure registries as they do today, but they must not enable or override credential provider execution.

```ini
# ~/.npmrc or global npmrc

# Global provider chain (fallback for all registries)
credentialProvider[]=npm-credential-provider-gitlab

# Per-registry provider
//gitlab.example.com/:credentialProvider[]=npm-credential-provider-gitlab

# Per-registry with arguments
//gitlab.example.com/:credentialProvider[]=npm-credential-provider-gitlab --instance https://gitlab.example.com
```

Provider commands are resolved deterministically from trusted sources only:

1. npm-shipped providers for npm-owned registries.
2. Absolute paths configured in user-level or global npm config.
3. Provider names found in npm-managed global bin directories.
4. Enterprise-managed allowlists, where npm is running under such policy.

The current working directory and project-local `node_modules/.bin` are never searched. Arbitrary `PATH` lookup is not used as the trust anchor for project installs. If a provider name is ambiguous across trusted sources, npm fails closed and asks the user to configure a more specific provider path.

Arguments are allowed only in user-level or global configuration. The configured value is split into argv on whitespace; a double-quoted segment is one argument, so a path such as `"C:\Program Files\gitlab\provider.exe"` survives intact. No other quoting, escaping, variable expansion or globbing is applied.

The most specific per-registry `credentialProvider` list that matches the request URL replaces the default list; lists are never merged. Between config files the usual npm precedence applies, so a user-level list replaces a global one for the same key. Configuring both `tokenHelper` and `credentialProvider` for the same registry is an error.

The client must spawn the resolved provider executable directly with an argv vector and must not invoke it through a shell. npm passes the sentinel argument `--npm-credential-provider` before configured provider arguments, as Cargo passes `--cargo-plugin`, so providers can distinguish protocol mode from any standalone CLI mode.

#### 2. Protocol

The client communicates with the provider via **stdin/stdout** using **single-line JSON messages** (no embedded newlines). The provider is invoked as a child process. Stdin is reserved for protocol JSON only; providers must not read interactive secrets, MFA codes, or device-code confirmations from stdin.

##### Version negotiation

On startup, the provider sends a hello message listing supported protocol versions, optionally with capabilities:

```json
{"v":[1]}
{"v":[1],"capabilities":["login","logout","erase","auth-challenges","retry-context"]}
```

The client selects a compatible version and uses it in all subsequent messages. If no version matches, the client terminates the provider. Legacy auth fallback is used only when no provider was explicitly configured or when the user/global config explicitly allows fallback.

Capabilities are advisory. The client may use them to avoid probing unsupported flows, but it must still handle `{"Err":{"kind":"operation-not-supported"}}`. Unknown capabilities and unknown fields are ignored. In the other direction, a provider answers a request `kind` or an `operation` it does not recognize with `operation-not-supported` and keeps serving the session; it must never treat an unknown operation as `read`. Newer clients can therefore add request kinds and operations without breaking older providers.

##### Request (client → provider)

```json
{"v":1,"kind":"get","registry":"https://gitlab.example.com/api/v4/projects/123/packages/npm/","scope":"@scope","package":"package","operation":"read","command":"install","interactive":false}
```

Publish, readable form:

```json
{
  "v": 1,
  "kind": "get",
  "registry": "https://gitlab.example.com/api/v4/projects/123/packages/npm/",
  "scope": "@scope",
  "package": "package",
  "version": "2.4.1",
  "operation": "publish",
  "command": "publish",
  "interactive": true
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `v` | number | yes | Negotiated protocol version. |
| `kind` | string | yes | `"get"`, `"erase"`, `"login"`, or `"logout"`. |
| `registry` | string | yes | Full registry URL for the request. |
| `scope` | string | no | Package scope (e.g. `@scope`). Absent for unscoped packages. |
| `package` | string | no | Package name without the scope. Absent for registry-level requests such as `npm search`. |
| `version` | string | for `publish` and `stage` | Package version. Lets a provider scope or audit write credentials. |
| `operation` | string | for `get` | The npm action the credential must authorize; see [Operations](#4-operations). |
| `command` | string | no | npm command that caused the request, such as `"install"`, `"ci"`, `"publish"`, `"search"`, or `"view"`. Informational, not the permission class; the set is open, and providers must accept command names they do not know. |
| `interactive` | boolean | for `get` | Whether the client can display prompts (for MFA flows). |
| `retry` | boolean | no | `true` when this request follows a rejected registry request. |
| `httpStatus` | number | when `retry` is `true` | HTTP status of the rejected request, 100–599. |
| `authChallenges` | string[] | no | `WWW-Authenticate` header values (without the header name) from the rejected request. Sent with `erase` and retry requests. |

The client sends all the context it has. A provider that issues one token per registry ignores `scope` and `package`; one that issues finer tokens uses them, and says so in `granularity`.

##### Success response (provider → client)

```json
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"glpat-xxxxxxxxxxxx"},"cache":"expires","expiresAt":1744200000,"operationIndependent":true,"granularity":"scope"}}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `Ok.kind` | string | yes | Must match the request `kind`. |
| `Ok.auth` | object | for `get` | Credentials; see Auth types. |
| `Ok.auth.type` | string | yes | `"bearer"` or `"basic"`. |
| `Ok.cache` | string | no | `"never"`: do not cache. `"session"`: cache for this npm process. `"expires"`: cache until `expiresAt`. Default `"session"`. |
| `Ok.expiresAt` | number | when `cache` is `"expires"` | Unix timestamp in seconds. |
| `Ok.operationIndependent` | boolean | no | `true` (default): the credential serves every operation. `false`: npm asks again for a different operation. |
| `Ok.granularity` | string | no | `"registry"` (default), `"scope"`, or `"package"`: how broadly npm may reuse the credential. |

##### Auth types

The type is explicit; nothing is inferred from which fields are present, and nothing arrives pre-encoded:

```json
{ "type": "bearer", "token": "glpat-xxxxxxxxxxxx" }
{ "type": "basic", "username": "deploy-token", "password": "glpat-xxxxxxxxxxxx" }
```

npm sends `Authorization: Bearer <token>`, or base64-encodes `username:password` for `Authorization: Basic`. The legacy `_auth` form is deliberately not carried over.

##### Error response

```json
{"Err":{"kind":"other","message":"Token has expired. Re-authenticate with your credential provider.","causedBy":["OAuth refresh token was revoked"]}}
```

| Error kind | Meaning | Client behavior |
|---|---|---|
| `"url-not-supported"` | Provider does not handle this registry. | Try the next provider in the chain. |
| `"not-found"` | No credentials stored for this registry or scope. | Fail. Legacy fallback only through an explicit user/global opt-in. |
| `"operation-not-supported"` | Provider does not support this request kind or operation. | Fail with an unsupported-operation error. |
| `"other"` | Anything else; carries `message` and optional `causedBy`. | Show the error. No silent legacy fallback. |

**Provider chaining:** providers are tried in order; the first `Ok` wins, `url-not-supported` means "try the next one", and any other error stops the chain.

```ini
# ~/.npmrc — two providers, tried in order
credentialProvider[]=npm-credential-provider-gitlab
credentialProvider[]=npm-credential-provider-github
```

Legacy `.npmrc` auth remains the default when no provider is configured. Once a provider is configured for a registry, silent fallback to plaintext token sources is avoided: it would mask provider failures and bring back the secret-storage behavior the user was trying to remove. A user or administrator may opt into legacy fallback explicitly for migration.

Providers write diagnostics to stderr (shown with `--loglevel verbose`). They must not write tokens, passwords, authorization headers, or other bearer-equivalent secrets to stderr or any ordinary log. Stdout carries protocol JSON only.

##### Session lifecycle

The client spawns a provider lazily, the first time a request needs a credential for a registry that provider is configured for. A command that is served entirely from cache, or that never touches a provider-backed registry, executes no provider at all.

The provider process then lives for the rest of the npm command and serves every request for it. Requests within a session are strictly sequential: the client sends a request only after reading the response to the previous one, and messages carry no request id. npm fetches in parallel, so the client serializes provider requests and coalesces concurrent cache misses for the same cache key into one request.

The client closes stdin to end the session, and the provider exits.

Clients and providers enforce an implementation-defined maximum line size. An oversized line fails closed: it is rejected whole, not partially processed, and does not trigger legacy fallback.

| Request kind | Timeout | Rationale |
|---|---|---|
| `get` | 30 seconds | Network call to a credential store or API. |
| `erase` | 10 seconds | Local cleanup. |
| `login` | 5 minutes | User interaction: browser OAuth, SSO redirect, MFA. |
| `logout` | 30 seconds | May include server-side revocation. |

A provider that exceeds its timeout is killed and the request fails.

##### Non-interactive and CI behavior

When `interactive` is `false`, providers must not open browsers, prompt for MFA, wait for device-code approval, or ask the user to approve a new trust decision. They may only use credentials and trust decisions that already exist.

When `interactive` is `true`, providers may use browser flows, OS-native prompts, or stderr status text. They still must not read from stdin, which belongs to the protocol; a provider that needs typed input opens the controlling terminal directly (`/dev/tty`, or `CONIN$` on Windows). While an interactive request is outstanding, npm pauses its own progress output, as it already does for OTP prompts.

In CI the provider must already be configured through user/global config, a machine image, or enterprise policy, and resolve from a trusted source. If no usable credential is available, npm fails with a clear error rather than prompting or falling back silently.

#### 3. Request kinds

##### `get`: request a credential

The primary runtime flow, described above.

##### `erase`: a credential was rejected

When the registry rejects a provider-supplied credential with a 401, the client tells the provider:

```json
{"v":1,"kind":"erase","registry":"https://gitlab.example.com/api/v4/projects/123/packages/npm/","scope":"@scope","authChallenges":["Bearer realm=\"https://gitlab.example.com\""]}
```

The provider invalidates whatever it cached and answers `{"Ok":{"kind":"erase"}}` or an error. The client may then retry once with the rejection as context:

```json
{"v":1,"kind":"get","registry":"https://gitlab.example.com/api/v4/projects/123/packages/npm/","scope":"@scope","package":"package","operation":"read","command":"install","interactive":false,"retry":true,"httpStatus":401,"authChallenges":["Bearer realm=\"https://gitlab.example.com\""]}
```

Not every 401 rejects the credential. npm already turns a 401 whose `WWW-Authenticate` names `otp` into its one-time-password prompt (`EOTP`), and one naming `ipaddress` into `EAUTHIP`. Those challenges keep their existing handling and never trigger `erase`: erasing there would discard a valid credential on every 2FA publish. A 403 means the credential was accepted but lacks permission, so it does not trigger `erase` either; the client may still retry `get` once with `retry: true` and `httpStatus: 403`, in case the provider can supply a more privileged credential.

Each registry request gets at most one provider retry. If the retried credential is rejected again, npm reports the failure instead of looping.

##### `login`: authenticate with a registry

`npm login --registry https://gitlab.example.com/` delegates to the configured provider, which can run OAuth, SSO, device-code or MFA flows that `npm login` cannot:

```json
{"v":1,"kind":"login","registry":"https://gitlab.example.com/api/v4/packages/npm/","interactive":true}
```

| Optional field | Description |
|---|---|
| `token` | A token the user supplied directly; the provider should store it. npm reads it from a hidden prompt or from its own stdin, never from a command-line argument, which would leave it in shell history and process listings. |
| `loginUrl` | A URL where the user can obtain a token, if registry metadata provides one. |

The provider stores the result in its own secure storage and answers `{"Ok":{"kind":"login"}}`, or `operation-not-supported` if it has no interactive login. Typical flows:

| Flow | Provider behavior |
|---|---|
| OAuth 2.0 / OIDC | Opens a browser, exchanges the authorization code, stores the result in the OS keychain. |
| Device code | Prints URL and code on stderr, polls for approval, stores the token. |
| SSO / SAML | Opens a browser for the SSO redirect, stores the token. |
| MFA / 2FA | Prompts on stderr and reads the code from the controlling terminal. |
| Static token | Stores the supplied `token`. |

##### `logout`: remove stored credentials

`npm logout --registry https://gitlab.example.com/` sends:

```json
{"v":1,"kind":"logout","registry":"https://gitlab.example.com/api/v4/packages/npm/"}
```

The provider attempts server-side revocation as a best effort, always removes its local credentials, and answers `{"Ok":{"kind":"logout"}}` even if revocation failed, warning on stderr. `not-found` means there was nothing to remove.

#### 4. Operations

`operation` names the npm action, and the provider decides which credential satisfies it. npm does not impose tiers because registries draw them differently:

| Operation | npm commands | `version` |
|---|---|---|
| `read` | `install`, `ci`, `update`, `view`, `search`, `outdated`, … | — |
| `publish` | `publish`, and promoting a staged version (`npm stage approve`) | required |
| `stage` | `npm stage publish` | required |
| `deprecate` | `deprecate` | optional |
| `dist-tag` | `dist-tag add`, `dist-tag rm` | optional |
| `unpublish` | `unpublish` | optional (absent: the whole package) |
| `owner` | `owner add`, `owner rm` | — |
| `access` | `access`, `team`, `org` | — |

How some registries split these:

| Registry | Credential tiers relevant to npm |
|---|---|
| npmjs.com | Read-only; read and write, either publish-and-stage or stage-only; owner, team and org changes always need an interactive 2FA challenge ([docs](https://docs.npmjs.com/about-access-tokens)). |
| GitHub Packages | `read:packages`, `write:packages`, `delete:packages` ([docs](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages)). |
| Azure Artifacts | Packaging read; read and write; read, write and manage, the last required to delete ([scopes](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/oauth)). |
| Cargo (prior art) | Operations `read`, `publish`, `yank`, `unyank`, `owners`, plus an `Unknown` fallback for forward compatibility. |

A provider returning a stage-only token for `stage` sets `operationIndependent: false`, so npm never reuses it for `publish`.

#### 5. Caching

The client caches credentials in memory, keyed by the `granularity` the provider returned:

| Granularity | Cache key | Effect |
|---|---|---|
| `"registry"` | registry URL | One credential for every package on the registry, as today. |
| `"scope"` | registry URL + scope | Different credentials for `@scope-a/*` and `@scope-b/*` on one registry. |
| `"package"` | registry URL + scope + package | A credential per package. |

The key also records the granularity level itself, and the operation when `operationIndependent` is `false`, so entries from different levels never collide (an unscoped package named `read` must not match a scope-level entry bound to operation `read`).

Lookups go from most to least specific: package, then scope, then registry, and at each level an entry bound to the requested operation before an operation-independent one. An entry with `cache: "expires"` stops matching 60 seconds before `expiresAt`, so a request never leaves with a credential about to lapse. If nothing matches, the client sends `get`.

The client never persists credentials to disk.

#### 6. Provider discovery

If no provider is configured for a registry and authentication fails, npm may look for a provider named `npm-credential-provider-<registry-host>` in trusted global locations only. If it finds one, it **suggests** it and never installs or executes it:

```
$ npm install @scope/package
npm ERR! 401 Unauthorized: @scope/package from https://gitlab.example.com/...
npm WARN found npm-credential-provider-gitlab installed globally
npm WARN to use it, add to ~/.npmrc:
npm WARN   //gitlab.example.com/:credentialProvider[]=npm-credential-provider-gitlab
```

Project-local discovery is not performed, so a lookalike package or a project-local binary may be present but is never executed without explicit trusted configuration.

#### 7. Security model

This feature must not become a project-controlled install hook. Install scripts are selected by package authors and the dependency graph; credential helpers and providers are selected by the user, the machine owner, or an administrator. A cloned repository, a dependency, a lockfile, or a project `.npmrc` must not be able to introduce one.

Trust boundaries:

1. **Project and workspace `.npmrc`**: may not set `tokenHelper` or `credentialProvider`. npm ignores either key there and warns. Registry URLs and scopes are configured there as today.
2. **User `~/.npmrc` and global config**: may name a helper by absolute path, or a provider by absolute path or by a name resolved from trusted global locations.
3. **Resolution**: the current directory and project `node_modules` are never searched; local packages cannot shadow global providers; ambiguous names fail closed.
4. **Provider output**: validated by the client. Unknown fields are ignored. Stdout is protocol JSON only; stderr must not contain secrets.
5. **Storage**: npm keeps credentials in memory only. Providers own their storage (OS keychain, encrypted file) and must not write credentials or provider configuration into any `.npmrc` as a side effect of a request.
6. **Input**: npm sends only the protocol fields; no environment variables or file paths. Stdin is not an interactive channel.

##### Threat model

The npm ecosystem is actively reducing install-time code execution, and automation makes it cheap to mass-produce lookalike packages and probe for weak trust boundaries. Anything that executes before or during an install therefore fails closed and requires explicit user or administrator trust.

| Threat | Risk | Mitigation |
|---|---|---|
| Malicious project `.npmrc` | A repository tries to make `npm install` run an attacker-chosen program. | Project and workspace `.npmrc` cannot set `tokenHelper` or `credentialProvider`. |
| Project-local binary shadowing | A dependency places a provider-like binary in `node_modules/.bin`. | Project `node_modules` and the current directory are never searched. |
| PATH poisoning | Shell startup files, `.env` tooling, or CI setup redirect a provider name. | Resolution uses trusted npm-controlled locations or explicit absolute paths, not arbitrary `PATH`; neither key is read from environment variables. |
| Typosquatting | The `npm-credential-provider-*` convention attracts lookalike packages. | Discovery is suggest-only, global-only, and never installs or executes. |
| Compromised provider package | A trusted provider is replaced or updated maliciously. | High-assurance environments pin providers by absolute path, version, integrity hash, or enterprise allowlist. |
| Silent plaintext fallback | A provider failure quietly re-enables a stored token. | Fallback after a provider is configured needs explicit opt-in. |
| Secret leakage through logs | A provider prints a token or authorization header. | Stdout is protocol-only; stderr and logs must redact bearer-equivalent secrets. |
| Provider mutates npm config | A provider writes credentials or config into `.npmrc` during install. | Protocol requests must not mutate any `.npmrc`; config changes are explicit user actions. |
| Oversized messages | A malicious or buggy peer causes memory or CPU pressure. | Maximum line size, oversize input rejected whole. |
| Code already running as the user | A malicious install script spawns the configured helper or provider itself and asks for a credential, as any process can run `git credential fill`. | Not preventable at the protocol level. Providers should issue read credentials short-lived and narrowly scoped, and require user presence (an OS-native prompt, only when `interactive` is `true`) before issuing write credentials. |

The last row is the honest limit of this design, and also where it improves most on today. A script that finds a publish token in `.npmrc` or `NPM_TOKEN` can take it away and publish later, from anywhere, with no prompt. Against a provider that gates write credentials on user presence, the same script gets nothing it can take away and use later.

Integrity pinning stays optional in the baseline because it adds operational cost, but enterprise and CI deployments should be able to require a resolved provider identity such as `{ name, version, integrity }` or an absolute path plus checksum.

#### 8. Provider lifecycle

```
npm install @scope/package
  |
  |-- Need a credential for registry X, scope Y, package Z, operation "read"
  |     |
  |     |-- Check the in-memory cache (granularity, operationIndependent)
  |     |     |-- Hit, cache:"session"                -> use it
  |     |     |-- Hit, cache:"expires", not expiring  -> use it
  |     |     |-- Miss, or inside the expiry margin   -> kind: "get"
  |     |
  |     |-- No provider process for X yet -> spawn it (lazily, on first miss)
  |     |     |-- Provider sends hello: {"v":[1],"capabilities":[...]}
  |     |     |-- Client selects version
  |     |
  |     |-- Send one JSON line, read one JSON line
  |     |     |-- "Ok"                         -> cache it, use it
  |     |     |-- "Err: url-not-supported"     -> next provider in the chain
  |     |     |-- "Err: not-found"             -> fail unless legacy fallback is enabled
  |     |     |-- "Err: other" / unsupported   -> show the error
  |     |
  |     |-- Send the registry request
  |     |     |-- 401 (not an OTP/IP challenge) -> "erase", then one retry: "get", retry: true, httpStatus
  |     |     |-- 403                           -> no erase; at most one retry: "get", retry: true, httpStatus: 403
  |
  |-- Need a credential for another scope (same session)
  |     |-- Reuse the same provider process
  |
  |-- Command finished
        |-- Close stdin -> provider exits; the cache is discarded
```

#### 9. Example: GitLab provider

A hypothetical `npm-credential-provider-gitlab` that uses GitLab's fine-grained tokens.

**One-time setup:**

```bash
npm install -g npm-credential-provider-gitlab
# add to ~/.npmrc:
# //gitlab.example.com/:credentialProvider[]=npm-credential-provider-gitlab --instance https://gitlab.example.com
npm login --registry https://gitlab.example.com/
# opens a browser for GitLab OAuth; the provider keeps its refresh token in the OS keychain
```

**On `npm install`:**

1. npm needs `@scope/package` from `gitlab.example.com`, finds nothing cached, and spawns the provider, which sends `{"v":[1],"capabilities":["login","logout","erase"]}`.
2. npm sends `{"v":1,"kind":"get","registry":"https://gitlab.example.com/api/v4/projects/42/packages/npm/","scope":"@scope","package":"package","operation":"read","command":"install","interactive":false}`.
3. The provider reads its refresh token from the keychain and obtains a short-lived token scoped to project 42 with `read_package_registry`.
4. It answers `{"Ok":{"kind":"get","auth":{"type":"bearer","token":"glpat-short-lived"},"cache":"expires","expiresAt":1744201800,"granularity":"scope"}}`.
5. Every other `@scope/*` package is a cache hit. If the install outlasts the token, the next lookup is another `get`, and the provider refreshes on its own side.
6. npm closes stdin; the provider exits.

The developer configured it once; no token ever reached a file npm reads.

## Rationale and Alternatives

### Why not only `tokenHelper`?

It is the right first step: compatible with pnpm, tiny to implement, and enough for a single-registry setup. But a helper learns nothing about the request, cannot say how long its token lives, cannot be told that a token was rejected, and runs once per process. Per-scope tokens, publish-time step-up, long installs that outlive a token, and `npm login` delegation all need the protocol.

### Why not environment variables or `${VAR}` in `.npmrc`?

They move the secret instead of removing it. An environment variable is inherited by every lifecycle script, and pnpm recently stopped expanding `${…}` in repository `.npmrc` files because a malicious repository could use it to exfiltrate CI secrets to a registry of its choosing ([pnpm docs](https://pnpm.io/npmrc)).

### Why one provider process per command?

Measured with the reference client and an instant mock provider (Windows 11, release build, 1000 lookups, 7 rotated rounds, median with min..max): a lookup in a running session costs 118 µs (114..133), a fresh process per lookup 10.3 ms (9.6..10.5), about 87 times more ([benchmark](poc/rust/crates/mock-client/examples/round_trip.rs)). The session also keeps a provider's in-memory state across lookups.

### Why no `refresh` request?

Revision 4 had one, carrying an opaque `refreshState` the provider handed to npm. None of the prior art passes refresh state through the client: Cargo, Git, Docker, NuGet and pnpm have no such request, and the AWS and Azure credential chains refresh inside the provider. Since the provider process lives for the whole command, it can refresh on the next `get`; across commands it keeps refresh state in its own secure storage. The request also lost the scope of the token it refreshed, and made npm hold a second bearer-equivalent secret it did not need.

### Why no batch request?

Revision 4 had `get-batch`. The same benchmark at commit `ab3ad81` measured 31 µs per lookup in one batch against 118 µs as separate `get`s in a session: 0.09 s saved per thousand lookups. No registry today issues per-package tokens, so a real install makes one lookup per registry or scope, a handful in all; and during tree building npm discovers packages one by one, so a batch could not be formed without delaying requests. If a registry ever mints per-package tokens through a batch API, a capability can add the request later without a version change.

### Why npm actions rather than read/write tiers?

Registries disagree on the tiers, as the table under [Operations](#4-operations) shows: npmjs.com splits stage-only from direct publish, GitHub Packages and Azure Artifacts put deletion above write. A coarse `write` would force npm to choose one mapping for every registry, and a provider minting tiered credentials would have to guess from the informational `command`. Naming the action keeps the mapping where the knowledge is, as Cargo does.

## Implementation

- **Where it plugs in.** In `npm-registry-fetch`, `regFetch()` resolves auth synchronously (`getAuth()` in `lib/auth.js`) before the asynchronous fetch starts. A helper or provider call is asynchronous, so helper- and provider-backed auth has to be resolved inside the async fetch path, which `regFetch()` already returns as a promise. pnpm's TypeScript CLI runs `tokenHelper` with `spawnSync`, which blocks the event loop while the helper runs and rules out a long-lived session.
- **Shape.** As suggested in the #850 review from NuGet's experience, npm can define one internal credential-source interface with implementations for the existing config lookup (`_authToken`, `_auth`, `username`/`_password`), `tokenHelper`, the provider protocol, and optionally a built-in source for npm-owned registries that spawns no process.
- **Operation hint.** Commands pass the npm action to `npm-registry-fetch` with the request options; installs default to `read`.
- **Config.** `@npmcli/config` gains `tokenHelper` and `credentialProvider` as per-registry keys, accepted only from user and global config and excluded from `npm_config_*` environment variables.
- **Conformance material.** The draft ships a JSON Schema, a machine-readable policy file, generated test vectors, an executable Python model and a Rust client/provider pair (see the repository README), so npm and third-party providers can be tested against the same cases.

### Configuration

| Setting | Where | Default | Description |
|---|---|---|---|
| `tokenHelper`, `//<registry>/:tokenHelper` | user, global | none | Phase 1: absolute path of a program that prints a token. |
| `credentialProvider[]`, `//<registry>/:credentialProvider[]` | user, global | none | Phase 2: provider chain, tried in order. |
| `credential-provider-legacy-fallback` | user, global | `false` | Allow falling back to stored `_authToken`/`_auth` when a configured provider fails, for migration. |

## Prior Art

| | Git | Docker | pnpm `tokenHelper` | Cargo | npm RFC #850 | This proposal |
|---|---|---|---|---|---|---|
| **Year** | 2012 | 2016 | 2022 | 2023 | 2025 | 2026 |
| **Format** | key=value | JSON | Plain string | JSON (single-line) | JSON | Phase 1: plain string; Phase 2: JSON (single-line) |
| **Direction** | Bidirectional | Bidirectional | Unidirectional | Bidirectional | Unidirectional | Bidirectional |
| **Request kinds** | get, store, erase | get, store, erase | get only | get, login, logout | get only | get, erase, login, logout |
| **Context on input** | protocol, host, path | ServerURL | None | registry, operation, name, version | None (args only) | registry, scope, package, version, operation, command |
| **Operations** | — | — | — | read, publish, yank, unyank, owners | — | read, publish, stage, deprecate, dist-tag, unpublish, owner, access |
| **Versioning** | None | None | None | Hello `{"v":[1]}` | None | Hello `{"v":[1]}` + `v` in every message |
| **Auth type** | Implicit | Implicit | Raw token or header value | Raw token | Implicit | Explicit `bearer`/`basic` |
| **Refresh** | In helper | In helper | In helper | In provider | Re-run | In provider |
| **Cache control** | None | None | None | `never`/`session`/`expires` | `expiresAt` | Cargo's three + `granularity` + `operationIndependent` |
| **Rejection signal** | `erase` | `erase` | None | Challenge headers | None | `erase` + one retry with status and challenges |
| **Chaining** | Yes | No | No | Yes (`url-not-supported`) | No | Yes (`url-not-supported`) |
| **Process reuse** | No | No | Once per registry per run | Yes | No | Yes |
| **Discovery** | `git-credential-*` | `docker-credential-*` | Explicit | Explicit | Explicit | Explicit; suggest-only lookup |
| **Production-tested** | Yes | Yes | Yes | Yes | No | No |

Further references: [Git credential helpers](https://git-scm.com/docs/gitcredentials), [Docker credential stores](https://docs.docker.com/reference/cli/docker/login/#credential-stores), [pnpm `tokenHelper`](https://pnpm.io/npmrc#urltokenhelper), [Cargo credential provider protocol](https://doc.rust-lang.org/cargo/reference/credential-provider-protocol.html), [NuGet cross-platform authentication plugins](https://learn.microsoft.com/en-us/nuget/reference/extensibility/nuget-cross-platform-authentication-plugin), [pip keyring support](https://pip.pypa.io/en/stable/topics/authentication/).

## Migration Plan

No phase changes behavior for anyone who has not configured a helper or provider.

### Phase 1: `tokenHelper` (next minor release)

- Accept `tokenHelper` and `//<registry>/:tokenHelper` from user and global config, with pnpm's semantics.
- Warn about and ignore the key in project and workspace config.

### Phase 2: `credentialProvider` (a later minor release)

- Ship the protocol: `get`, `erase`, `login`, `logout`, cache control, chaining, one retry after a rejection.
- Delegate `npm login` and `npm logout` to a configured provider.
- Publish the schema and conformance vectors so vendors can ship providers against a fixed target.

### Phase 3: Ecosystem

- Registry vendors ship providers; their `login` wrappers stop writing tokens into `.npmrc`.
- Evaluate discovery suggestions, enterprise pinning, and a built-in provider for npm-owned registries as separate changes.

## Unresolved Questions

1. Should npm accept arguments in `tokenHelper`, which pnpm forbids, or stay strictly compatible?
2. The exact operation for every `npm stage` subcommand and for `npm token`.
3. Whether npm should ship a built-in provider for npmjs.com that reuses web login sessions.
4. The format of enterprise provider pinning (`{ name, version, integrity }` or path plus checksum).
5. Whether discovery suggestions are worth their typosquatting surface at all.

## Appendix: Comparison with RFC #850

| Aspect | RFC #850 | This proposal |
|---|---|---|
| **Delivery** | One mechanism | Phase 1 pnpm-compatible `tokenHelper`, Phase 2 protocol |
| **Request kinds** | get only | get, erase, login, logout |
| **Auth flows** | Not specified | OAuth, SSO, device code, MFA via `login` |
| **Granularity** | Per registry | Per registry, scope, or package |
| **Provider input** | No stdin, arguments only | JSON on stdin with full context |
| **Versioning** | None | Hello message + `v` in every message |
| **Permission context** | None | npm action as `operation` |
| **Token rejection** | Not specified | `erase` + one retry with status and challenges |
| **Cache control** | `expiresAt` only | `cache` + `expiresAt` + `granularity` + `operationIndependent` |
| **Provider chaining** | Not specified | `url-not-supported` → next provider |
| **Session model** | One process per request | One process per command |
| **Configuration source** | Project or user | User and global only |
