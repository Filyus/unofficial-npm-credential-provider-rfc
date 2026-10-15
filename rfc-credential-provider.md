# RFC: Credential Provider Protocol

> Status: Draft
> Revision: 21
> Date: 2026-10-15

> A draft proposal building on the [npm/rfcs#850](https://github.com/npm/rfcs/pull/850) discussion. It lets npm obtain registry credentials from a user-configured program at the moment it needs them, instead of reading a long-lived secret from `.npmrc` or the environment.

## Summary

npm gains two ways to ask an external program for registry credentials, delivered in phases:

| Phase | Setting | What it is | Modelled on |
|---|---|---|---|
| 1 | `//<registry>/:tokenHelper` | An executable prints a token; npm sends it as the `Authorization` header. | pnpm's setting of the same name |
| 2 | `credentialProvider` | A small versioned JSON protocol over stdin/stdout: npm says which registry, package and npm action it needs a credential for; the provider answers with the credential and how long npm may cache it, and is told when the registry rejects it. | [Cargo's credential providers](https://doc.rust-lang.org/cargo/reference/credential-provider-protocol.html) |

Phase 1 is what [npm/cli#8141](https://github.com/npm/cli/issues/8141) asks for, and one helper serves both package managers. Both phases are configured only in user-level or global npm config ([Trust](#trust)), and neither changes anything for a user who has not configured it.

## Motivation

### Registry credentials are standing secrets

npm registry authentication ends in a bearer secret stored in `.npmrc` (where `npm login` writes it) or passed through an environment variable. Every lifecycle script that runs during an install can read both. [RFC 0054](https://github.com/npm/rfcs/blob/main/accepted/0054-make-scripts-install-opt-in.md) records what that costs: the Shai-Hulud worm (September 2025) spread by stealing maintainer tokens from compromised machines and publishing infected versions of the victims' other packages.

### Registries already issue short-lived tokens, and npm cannot ask for them

The registries companies run next to npmjs.com already hand out short-lived credentials, and users already trust the tools that fetch them. What npm lacks is a way to ask: each tool writes the credential somewhere npm will read, to be renewed by hand.

| Registry | Token lifetime | How the token reaches npm today |
|---|---|---|
| AWS CodeArtifact | 12 h by default, 15 min to 12 h | `aws codeartifact login --tool npm` writes it into npm's config ([docs](https://docs.aws.amazon.com/codeartifact/latest/ug/tokens-authentication.html)) |
| Google Artifact Registry | 60 min | written into `.npmrc`, and "if your access token has expired, you must generate a new access token" ([docs](https://docs.cloud.google.com/artifact-registry/docs/nodejs/authentication)) |
| Azure Artifacts | the PAT's lifetime | `vsts-npm-auth` writes a personal access token into the user `.npmrc` ([docs](https://learn.microsoft.com/en-us/azure/devops/artifacts/npm/npmrc?view=azure-devops)) |
| GitLab Artifact Registry | 15 min by default, 12 h at most | `glab artifact-registry login --npm` writes an `_authToken` into `~/.npmrc`, to be run again before it expires; for Docker the same command registers glab as a credential helper that fetches a fresh token on every pull ([docs](https://docs.gitlab.com/cli/artifact-registry/login/)) |

What this proposal removes is the step that turns a short-lived credential into a file on disk.

### npmjs.com itself is moving to short-lived, action-scoped tokens

- **2025-09-29:** new write-enabled granular tokens default to 7 days ([GitHub Changelog](https://github.blog/changelog/2025-09-29-strengthening-npm-security-important-changes-to-authentication-and-token-management/)).
- **2025-11-05:** all granular write tokens are capped at 90 days ([GitHub Changelog](https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes/)).
- **2025-12-09:** `npm login` issues "a two-hour session token instead of long-lived tokens", and classic tokens are revoked ([GitHub Changelog](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/)).
- **2026-07-08:** npm 12 makes install scripts, git dependencies and remote tarball URLs opt-in, and points automation to trusted publishing (OIDC) or staged publishing with human approval ([npm v12 announcement](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)). Stage-only granular tokens can stage a version for a maintainer to approve with 2FA, but cannot publish.
- **2026-07-31:** bypass-2FA tokens can no longer perform account-governance actions; their direct publishing is due to go in January 2027 ([GitHub Changelog](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/), [npm docs](https://docs.npmjs.com/about-access-tokens)).

npm still saves the two-hour token as `_authToken` in the user `~/.npmrc`, so even the registry's own credentials are short-lived secrets that npm can only keep by writing them to disk. And these changes cover publishing from CI; none says how a developer's machine or a build agent should hold read credentials for private registries, which is the gap this proposal fills. Since npm 12 closed install-time code execution by default, a credential helper must not reopen it, which is why [Trust](#trust) limits helpers and providers to user and global config.

### npm is behind its neighbours

pnpm ships `tokenHelper` in both its TypeScript CLI and its Rust rewrite. Cargo has a versioned credential-provider protocol, Git and Docker have had credential helpers for a decade, NuGet has cross-platform authentication plugins, and pip delegates to keyring. In npm:

- The request for the same thing, [npm/cli#8141](https://github.com/npm/cli/issues/8141), has 41 👍, no maintainer reply, and since 2026-10-01 the `Priority 1` label.
- A `~/.npmrc` written for pnpm's `tokenHelper` gives npm no credentials at all, and npm 12 reports the key as unknown on every command ("Unknown user config … This will stop working in the next major version of npm"), an error under `strict-npmrc`. A configuration shared with pnpm is on a path to breaking npm outright.

## Scope

In scope:

- How npm obtains credentials for its own HTTP requests to registries.
- Delegating `npm login` and `npm logout` to a configured provider.

Out of scope:

- Credentials for lifecycle scripts. Scripts never receive provider credentials.
- Trusted publishing (OIDC) and the registry's own token model; both are unchanged.
- Git dependencies, proxies, and client certificates (`certfile`/`keyfile`).
- Protecting credentials from code that already runs as the same user: it can run a helper or provider exactly as npm does, as any process can run `git credential fill`. What changes is what it finds: no standing secret in `.npmrc` or the environment, short-lived tokens, and write credentials gated by the provider ([Threat model](#threat-model)).

## Detailed Explanation

### Trust

A helper or provider is a program npm runs, so only the user and the machine's owner may configure one. This rule covers both phases:

- `tokenHelper` and `credentialProvider` are accepted only from the user config file and the global config file.
- In a project or workspace `.npmrc`, in `publishConfig`, in `npm_config_*` environment variables and on the command line they are ignored with a warning.
- A user or global file is not the user's when a project chose it or when it lies inside a project; [Where it may be set](#where-it-may-be-set) says what that means.

### Phase 1: `tokenHelper`

`tokenHelper` turns a helper's output into a header the way pnpm does, so a helper at an absolute path that prints a one-line token serves both package managers. The configuration is pnpm's per-registry form:

```ini
# ~/.npmrc or global npmrc only
//npm.corp.example.com/:tokenHelper=/usr/local/bin/corp-registry-token
```

| | |
|---|---|
| **Where** | User or global config, per registry ([Trust](#trust)) |
| **Value** | An absolute path, no arguments |
| **When** | Lazily, once per registry per npm process |
| **Output** | One line: a raw token is sent as `Bearer <token>`, `Scheme value` as is |
| **Failure** | `ETOKENHELPER`; no fallback to another credential |
| **Precedence** | Over a stored token; OIDC trusted publishing over both |

#### Where it may be set

Only in a user or global file that is the user's own. npm loads project config before the user and global files, and a project can name those files, so two things decide whether a file is the user's:

- **Who chose it.** The setting that selected the file (`userconfig`, `globalconfig`, or the `prefix` the default global file derives from) must not come from a project `.npmrc`. Keys count as they are applied, after environment expansion: `user${UNSET?}config=` is `userconfig`.
- **Where it lies.** A file inside a project is the repository's, whoever named it: `npm --prefix client` makes `client/etc/npmrc` the global config file, and a CI job's `--userconfig` may point into the checkout. A project is any directory from the current one up that has a `package.json` or `node_modules`, and a command-line prefix outside a global run. Containment is decided by the filesystem's identity of directories, not by how a path is spelled.
- **The home directory is not a project.** An accidental `~/package.json` is common, so the default `~/.npmrc` and global file stay trusted even when a project names them. The accepted cost: where the home directory is the checkout itself (a PaaS with `HOME=/app`, a container whose working directory is `$HOME`), the repository's `.npmrc` is the user's file.
- **Child processes keep the decision.** A child npm inherits the chosen paths as environment values, so npm tells it which files its parent did not trust.

Anywhere else the key is ignored with a warning. pnpm instead fails on the key in project config; npm warns and carries on, as it does for other settings it ignores.

#### How the helper runs

- **Value.** An absolute path with no arguments, which may contain spaces (`C:\Program Files\…`). Anything else fails with `ETOKENHELPER`. A vendor CLI that needs arguments goes in a two-line script.
- **Windows.** A `.cmd` or `.bat` helper runs through `cmd.exe`, as pnpm does; a path containing `"` or `%` is refused there, since `cmd.exe` would reinterpret it. Everything else is executed directly, never through a shell. A `.ps1` script needs a `.cmd` wrapper; Windows does not start it directly.
- **Working directory.** The helper's own directory, never npm's, which is usually the repository: on Windows a command started by bare name (the `node` in a cmd-shim) is looked up in the current directory first.
- **Environment.** npm's environment without `NODE_OPTIONS`, `npm_config_*`, `EDITOR`, `NODE_ENV`, `COLOR` and npm's own paths. npm exports a project's config to what it starts; `node-options` alone would let a repository's `.npmrc` load code into a node-based helper and read the credential it prints.
- **When.** The first time a request to that registry is about to be sent, and at most once per registry per npm process, whatever the outcome. Never for `--offline`. It does run before a `--prefer-offline` request the HTTP cache could have answered; skipping it would need the cache consulted first, which the prototype does not do.
- **stderr.** Shown as npm warnings, with the helper's own token removed wherever it appears and anything that looks like a credential (`Bearer …`, `token=…`, `"password": "…"`) masked. As warnings these also reach npm's debug log, whose directory a project `.npmrc` can set with `logs-dir`, as for everything npm logs.

#### Output and failures

npm trims the output, including a leading byte order mark such as Windows PowerShell 5.1 writes. A raw token is sent as `Authorization: Bearer <token>`; output that starts with ASCII letters and a space (`Bearer …`, `Basic …`) is used as the header value as is.

| Condition | Result |
|---|---|
| Non-zero exit, or a spawn error | `ETOKENHELPER`; a missing `#!` interpreter is named |
| Empty output | `ETOKENHELPER` |
| Not a valid header value (a second line, a control or non-ASCII character) | `ETOKENHELPER`, without quoting the output: the HTTP layer's own error would print the credential |
| More than 1 MiB of output | `ETOKENHELPER`; the helper is ended |
| Running longer than 60 seconds | `ETOKENHELPER`; the helper is ended |

Every failure names the helper, and npm does not fall back to another credential for that registry. Ending a helper means SIGTERM, then SIGKILL after 2 seconds; on Windows its whole process tree goes, elsewhere only the helper process itself, so a helper script should `exec` the command that does the work (signalling a process group would mean a session of its own, without the terminal it may prompt on). A helper that exits while a background process it started still holds its stdout is read for 250 ms more and then taken at its word; the background process is not stopped.

#### Which requests get the credential

- **The same ones as a stored token for that registry key:** a request whose URL falls under the key, a full URL on the registry's host (npm's fallback for tarballs), and a redirect that keeps the host name. A redirect to another host name and a tarball on another host or port get nothing.
- **Scheme and port are not compared,** as for a stored token, so a lockfile `resolved` URL over `http://` on the registry's host gets the header in clear. The prototype keeps npm's matching rather than making helpers differ from stored tokens.
- **On disk:** npm's HTTP cache leaves `Authorization` out of what it stores, unless a response names it in `Vary`; make-fetch-happen then records it in the cache index, for a helper's credential as for a stored token. Keeping it off disk entirely would need a change to make-fetch-happen, left open here.
- **In error bodies:** a registry that quotes the credential back has it printed and logged by npm, for any credential; npm's redaction recognises npm-issued token formats only.

#### Precedence and commands

| Situation | Behaviour |
|---|---|
| A helper and a stored token for the same registry | The helper is used |
| OIDC trusted publishing in use | The OIDC token wins over both |
| `publish`, `whoami` | A configured helper counts as being logged in |
| `logout` | Explains that the helper setting has to be removed, and names a stored token rather than revoking it, since revoking would send the helper's credential |
| `login` | Refuses: the token it saved would never be sent, and its requests would carry the helper's credential |
| `profile enable-2fa` | Refuses: it cannot work through a helper |

#### Compared with pnpm

| | pnpm | npm (this RFC) |
|---|---|---|
| Value | Documented as an absolute path with no arguments; the parser splits on whitespace into a command and arguments and accepts a bare name | One absolute path, spaces allowed, no arguments |
| Unscoped `tokenHelper=` | Accepted; since 11.4 pinned to the registry declared in the same file ([pnpm 11.4](https://pnpm.io/blog/releases/11.4)) | Ignored with a warning pointing to the scoped form; not fatal under `strict-npmrc`; `npm config set` refuses it |
| `//<registry>/:@scope:tokenHelper` | Parsed (per-scope credentials, 11.7) | Ignored with a warning naming the per-registry key |
| Key in project `.npmrc` | Error | Ignored with a warning |
| Output | `trimEnd()`, then passed on | Trimmed at both ends, BOM removed, refused if not a valid header value |
| Windows `.cmd` | Through `cmd.exe` | Through `cmd.exe`; `"` and `%` refused |

The two agree on an absolute path with no spaces and no arguments that prints a one-line token. Where npm is stricter, it is for a reason particular to npm:

- **No unscoped form:** a project `.npmrc` may set `registry=`, so "the default registry" is partly chosen by the repository, and the helper's credential would follow it to another host. This is why npm 9 stopped accepting an unscoped `_authToken`.
- **No bare names or arguments:** a bare name would be looked up on a `PATH` that npm extends with the project's `node_modules/.bin` when it runs inside a script.
- **No per-scope helpers:** one helper per registry is what Phase 1 offers; telling scopes apart is what Phase 2's request context is for.

#### Vendor CLIs

Vendor CLIs already print what a helper needs; since a helper takes no arguments, each becomes a two-line script:

| Registry | Command printing the credential | Lifetime | Header |
|---|---|---|---|
| AWS CodeArtifact | `aws codeartifact get-authorization-token --domain D --domain-owner ACCOUNT --query authorizationToken --output text` | 12 h default, 15 min–12 h ([docs](https://docs.aws.amazon.com/codeartifact/latest/ug/tokens-authentication.html)) | Bearer |
| Google Artifact Registry | `gcloud auth print-access-token` | 60 min ([docs](https://docs.cloud.google.com/artifact-registry/docs/nodejs/authentication)) | Bearer |
| GitHub Packages | `gh auth token` (after `gh auth refresh -s read:packages`) | until revoked | Bearer |
| JFrog Artifactory | `jf atc --expiry=3600 \| jq -r .access_token` | as requested, within the platform limit | Bearer |
| Azure Artifacts | a script printing `Basic <base64(user:PAT)>` | PAT lifetime | Basic: the documented npm scheme for Azure feeds is username + PAT ([docs](https://learn.microsoft.com/en-us/azure/devops/artifacts/npm/npmrc?view=azure-devops)), which the scheme pass-through above covers |

For npmjs.com itself a helper helps less: the two-hour session token comes from an interactive browser login with 2FA, so a helper can keep it in the OS keychain instead of `~/.npmrc` but cannot renew it silently.

Phase 1 has no context, no cache control and no way to learn that a token was rejected; those are what Phase 2 adds.

### Phase 2: `credentialProvider`

#### 1. Configuration

`credentialProvider` follows [Trust](#trust), as `tokenHelper` does. Project and workspace `.npmrc` files may still configure registries; they cannot enable, override or choose a provider.

```ini
# ~/.npmrc or global npmrc

# Global provider chain (fallback for all registries)
credentialProvider[]=npm-credential-provider-gitlab

# Per-registry provider
//gitlab.example.com/:credentialProvider[]=npm-credential-provider-gitlab

# Per-registry with arguments
//gitlab.example.com/:credentialProvider[]=npm-credential-provider-gitlab --instance https://gitlab.example.com
```

**The global chain** is the one unscoped setting. It is not the unscoped `tokenHelper` that Phase 1 rejects: that helper's output would go to whatever the default registry is, which a project can change, while a provider is told the registry URL in every request and answers `url-not-supported` for a registry it does not serve ([Threat model](#threat-model)). A provider that hands out the same credential for any URL belongs in the per-registry form only.

**Resolution.** Provider commands come from trusted sources only, in this order. Phase 2 ships sources 2 and 3; 1 and 4 are reserved for the Phase 3 changes that would add them:

1. npm-shipped providers for npm-owned registries (Phase 3, if npm ships one).
2. Absolute paths configured in user-level or global npm config.
3. Provider names found in npm-managed global bin directories.
4. Enterprise-managed allowlists, where npm is running under such policy (Phase 3).

The current working directory and project-local `node_modules/.bin` are never searched, and `PATH` is not a trust anchor. A name that is ambiguous across trusted sources fails closed, asking for a more specific path.

**Arguments.** The configured value is split into argv on whitespace; a double-quoted segment is one argument, so `"C:\Program Files\gitlab\provider.exe"` survives intact. No other quoting, escaping, variable expansion or globbing is applied.

**Precedence.** The most specific per-registry list that matches the request URL replaces the default list; lists are never merged. Between config files the usual npm precedence applies. Configuring both `tokenHelper` and `credentialProvider` for the same registry is an error. Either per-registry key takes that registry out of the global chain, so a per-registry `tokenHelper` beside a global chain is not.

**Spawning:**

- **Directly, with an argv vector, never through a shell.** The one exception is a Windows `.cmd` or `.bat` file, which is what an npm-managed global bin directory holds (npm's cmd-shims): it runs as `cmd.exe /d /s /c` under the same rules as a Phase 1 helper, refusing a path that contains `"` or `%`.
- **In the provider's own directory,** never npm's: on Windows a cmd-shim's bare `node` is looked up in the current directory first.
- **Without `NODE_OPTIONS` and `npm_config_*`** in its environment, which carry a project's config.
- **With the sentinel argument `--npm-credential-provider`** before the configured arguments, as Cargo passes `--cargo-plugin`, so a provider can tell protocol mode from a standalone CLI mode.

#### 2. Protocol

The client communicates with the provider via **stdin/stdout** using **single-line JSON messages** (no embedded newlines). The provider is invoked as a child process. Stdin is reserved for protocol JSON only; providers must not read interactive secrets, MFA codes, or device-code confirmations from stdin.

##### Version negotiation

On startup, the provider sends a hello message listing supported protocol versions, optionally with capabilities:

```json
{"v":[1]}
{"v":[1],"capabilities":["login","logout","erase","auth-challenges","retry-context"]}
```

The client selects a compatible version and uses it in all subsequent messages. If no version matches, the client terminates the provider; see [Legacy fallback](#legacy-fallback) for what happens next.

Capabilities are advisory. The client may use them to avoid probing unsupported flows, but it must still handle `{"Err":{"kind":"operation-not-supported"}}`. Unknown capabilities and unknown fields are ignored. In the other direction, a provider answers a request `kind` or an `operation` it does not recognize with `operation-not-supported` and keeps serving the session; it must never treat an unknown operation as `read`. Newer clients can therefore add request kinds and operations without breaking older providers, and the conformance schema accepts any lowercase identifier in both fields, listing the known values as examples.

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
| `granularity` | string | for `erase` | The `granularity` of the response that carried the rejected credential, so the provider can tell which of its credentials was rejected. |
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
| `"not-found"` | No credentials stored for this registry or scope. | Try the next provider; if none answers `Ok`, fail ([Legacy fallback](#legacy-fallback)). |
| `"operation-not-supported"` | Provider does not support this request kind or operation. | Fail with an unsupported-operation error. |
| `"other"` | Anything else; carries `message` and optional `causedBy`. | Show the error and fail. |

**Provider chaining:**

- Providers are tried in order, and the first `Ok` wins.
- `url-not-supported` and `not-found` move on to the next provider, as in Cargo; any other error stops the chain and names the provider.
- A provider decides `url-not-supported` from `registry` alone, and npm remembers the answer for that provider and registry for the rest of the command, so a provider that does not serve a registry is asked about it once, not once per package or tarball.
- The built-in entry `npm:token`, modelled on Cargo's `cargo:token`, serves the credential stored in `.npmrc` for the registry (`_authToken`, `_auth`, `username`/`_password`), or answers `url-not-supported` when none is stored. Listing it puts the stored credential at a place in the chain the user chose; a global chain that does not list it ends with it implicitly, as described under [Legacy fallback](#legacy-fallback).

```ini
# ~/.npmrc — two providers, then the stored credential, tried in order
credentialProvider[]=npm-credential-provider-gitlab
credentialProvider[]=npm-credential-provider-github
credentialProvider[]=npm:token
```

##### Legacy fallback

Whether npm uses a credential stored in `.npmrc` (`_authToken`, `_auth`, `username`/`_password`) when the chain does not list `npm:token`; a chain that lists it uses it at that place instead:

| Situation | Stored credential used? |
|---|---|
| No provider configured for the registry | Yes, as today; without one the request goes out anonymously |
| Every provider in the global chain answers `url-not-supported` | Yes: no provider serves the registry, so it is treated as one without a provider. npm warns once per registry per command when it uses a stored credential this way, naming the registry, the file the credential came from and the providers that declined. Without one the request goes out anonymously |
| Every provider in a per-registry list answers `url-not-supported` | No: the user said this registry uses a provider. npm fails, naming the registry and each provider asked |
| No provider answers `Ok` and at least one answered `not-found`, or a provider shares no protocol version with npm | No, unless `credential-provider-legacy-fallback` is set in user or global config, for migration |
| Any other error, a spawn failure, an oversized line, a timeout, in either kind of chain | No: npm fails, naming the provider |

A credential stored for a registry whose per-registry list does not include `npm:token` is never used, and npm warns about it on every command so that it gets deleted.

A silent fallback would mask provider failures and bring back the stored secret the user set out to remove. The one fallback that stays, after a global chain declines a registry, is what npm does without providers, and it is announced whenever it uses a stored secret. A broken global provider, in turn, fails every command that goes to the network, including anonymous reads from registry.npmjs.org: the provider cannot be told apart from one that would have answered.

Providers write diagnostics to stderr (shown with `--loglevel verbose`). They must not write tokens, passwords, authorization headers, or other bearer-equivalent secrets to stderr or any ordinary log. Stdout carries protocol JSON only.

##### Session lifecycle

The client spawns a provider lazily, on the first request to a registry it applies to:

- **A registry with a per-registry `credentialProvider` list:** that list.
- **A registry with a per-registry `tokenHelper`:** no provider.
- **Any other registry:** the global chain, including registries that need no credential, such as anonymous reads from registry.npmjs.org.

So a global provider starts with any command that goes to the network, and learns every registry the command touches, with the scope and package of the first request to each; the per-registry form keeps a provider away from registries it does not serve. A command served entirely from cache, or one to which no chain applies, runs no provider. Why npm cannot wait for a 401 first, as Cargo, Git and NuGet do, is in [Rationale](#why-ask-the-global-chain-before-the-first-request).

The provider process then lives for the rest of the npm command and serves every request for it. Requests within a session are strictly sequential: the client sends a request only after reading the response to the previous one, and messages carry no request id. npm fetches in parallel, so the client serializes provider requests and coalesces concurrent cache misses for the same cache key into one request.

The client closes stdin to end the session, and the provider exits. Clients and providers enforce an implementation-defined maximum line size; an oversized line is rejected whole, not partially processed.

**Timeouts** are part of the conformance policy ([`spec/policy-v1.json`](spec/policy-v1.json)):

| Request kind | Timeout | Rationale |
|---|---|---|
| hello (after spawn) | 10 seconds | Start-up and one line; covers vendor CLIs that start slowly. |
| `get` | 30 seconds | Network call to a credential store or API. |
| `get` with `interactive: true` | 5 minutes | May wait for the user, as `login` does: an OS prompt, a hardware key, an SSO page. |
| `erase` | 10 seconds | Local cleanup. |
| `login` | 5 minutes | User interaction: browser OAuth, SSO redirect, MFA. |
| `logout` | 30 seconds | May include server-side revocation. |

A provider that exceeds its timeout is killed:

- the request fails, and so do requests queued behind it in that session;
- credentials already cached from that provider stay usable;
- the next request that needs the provider starts a new session, but a provider killed twice in one npm command is not started again.

##### Non-interactive and CI behavior

When `interactive` is `false`, providers must not open browsers, prompt for MFA, wait for device-code approval, or ask the user to approve a new trust decision. They may only use credentials and trust decisions that already exist.

When `interactive` is `true`, providers may use browser flows, OS-native prompts, or stderr status text. They still must not read from stdin, which belongs to the protocol; a provider that needs typed input opens the controlling terminal directly (`/dev/tty`, or `CONIN$` on Windows). While an interactive request is outstanding, npm pauses its own progress output, as it already does for OTP prompts.

In CI the provider must already be configured through user/global config, a machine image, or enterprise policy, and resolve from a trusted source. If no usable credential is available, npm fails with a clear error rather than prompting.

#### 3. Request kinds

| Kind | Sent when | Answer |
|---|---|---|
| `get` | A registry request needs a credential the cache does not hold | The credential, as described above |
| `erase` | The registry rejected a provider's credential | `{"Ok":{"kind":"erase"}}` once the provider has dropped it |
| `login` | `npm login` for a provider-backed registry | `{"Ok":{"kind":"login"}}` once the provider has stored a credential |
| `logout` | `npm logout` for a provider-backed registry | `{"Ok":{"kind":"logout"}}` once local credentials are gone |

A provider answers a kind it does not implement with `operation-not-supported`.

##### `get`: request a credential

The primary runtime flow, described above.

##### `erase`: a credential was rejected

What the client does when the registry answers a request made with a provider's credential:

| Response | Erase? | Retry `get`? | Why |
|---|---|---|---|
| 401 | Yes | Once, with `retry: true`, `httpStatus: 401` and the challenges | The credential was rejected |
| 401 whose `WWW-Authenticate` names `otp` | No | No; npm's one-time-password prompt (`EOTP`) | The credential is valid; erasing would discard it on every 2FA publish |
| 401 whose `WWW-Authenticate` names `ipaddress` | No | No; `EAUTHIP` | The credential is valid but not from this address |
| 403 | No | Once, with `retry: true` and `httpStatus: 403` | The credential was accepted but lacks permission; the provider may have a more privileged one |

Each registry request gets at most one provider retry; a retried credential rejected again is reported, not retried.

To erase, the client first removes every cache entry that served the credential, at every granularity, so a coarser credential returned by the retry is not shadowed by the rejected one. It then tells the provider, with the context of the `get` that produced the credential:

```json
{"v":1,"kind":"erase","registry":"https://gitlab.example.com/api/v4/projects/123/packages/npm/","scope":"@scope","package":"package","operation":"read","granularity":"scope","authChallenges":["Bearer realm=\"https://gitlab.example.com\""]}
```

The provider invalidates the credential that context identifies, including one bound to a package or an operation, and answers `{"Ok":{"kind":"erase"}}` or an error. The retry carries the rejection as context:

```json
{"v":1,"kind":"get","registry":"https://gitlab.example.com/api/v4/projects/123/packages/npm/","scope":"@scope","package":"package","operation":"read","command":"install","interactive":false,"retry":true,"httpStatus":401,"authChallenges":["Bearer realm=\"https://gitlab.example.com\""]}
```

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
| `deprecate` | `deprecate`, `undeprecate` | optional |
| `dist-tag` | `dist-tag add`, `dist-tag rm` | optional |
| `unpublish` | `unpublish` | optional (absent: the whole package) |
| `owner` | `owner add`, `owner rm` | — |
| `access` | `access`, `team`, `org`, and `trust` (trusted-publisher relationships) | — |

Read-only subcommands of these (`stage list`, `trust list`, `owner ls`, …) use `read`.

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

Discovery is not part of Phase 2; it is described here so the Phase 3 evaluation has a concrete design to weigh. If no provider is configured for a registry and authentication fails, npm may look for a provider named after the registry's host, `npm-credential-provider-<name>` where `<name>` is a label of the host (`gitlab` for `gitlab.example.com`), in trusted global locations only. If it finds one, it **suggests** it and never installs or executes it:

```
$ npm install @scope/package
npm ERR! 401 Unauthorized: @scope/package from https://gitlab.example.com/...
npm WARN found npm-credential-provider-gitlab installed globally
npm WARN to use it, add to ~/.npmrc:
npm WARN   //gitlab.example.com/:credentialProvider[]=npm-credential-provider-gitlab
```

Project-local discovery is not performed, so a lookalike package or a project-local binary may be present but is never executed without explicit trusted configuration.

#### 7. Security model

Install scripts are chosen by package authors and the dependency graph; helpers and providers are chosen by the user, the machine's owner or an administrator. This feature must not become a project-controlled install hook: a cloned repository, a dependency, a lockfile or a project `.npmrc` must not be able to introduce one. The ecosystem is reducing install-time code execution, and automation makes lookalike packages and probes of weak trust boundaries cheap, so anything that runs before or during an install fails closed.

**What the design guarantees:**

- **Configuration** comes only from user and global files that are the user's own ([Trust](#trust)); project files, `publishConfig`, the environment and the command line cannot set either key.
- **Resolution** never searches the current directory or project `node_modules`, local packages cannot shadow global providers, and ambiguous names fail closed.
- **The provider's process** starts in its own directory, without the environment variables that carry a project's config.
- **Input** is the protocol fields only: no environment variables or file paths. Stdin is not an interactive channel.
- **Output** is validated by the client; unknown fields are ignored. Stdout is protocol JSON only, and stderr must not carry secrets.
- **Storage:** npm keeps credentials in memory only. Providers own their storage (OS keychain, encrypted file) and never write credentials or configuration into an `.npmrc` as a side effect of a request.

**What it does not guarantee:**

- That code already running as the user cannot get a credential: it can run a provider exactly as npm does ([below](#publishing-while-a-script-runs)).
- That a trusted provider stays trustworthy: a provider package replaced or updated maliciously is outside the protocol; high-assurance setups pin it.

##### Threat model

| Threat | Example | Mitigation |
|---|---|---|
| Malicious project `.npmrc` | A repository makes `npm install` run a program it chose. | The key is ignored in project and workspace `.npmrc`. |
| Project relocates user or global config | A project sets `userconfig=./x.npmrc`, `globalconfig` or `prefix`, so a repository file loads as the user's. | A file a project chose, or one inside a project, cannot configure a helper or provider ([Where it may be set](#where-it-may-be-set)). |
| `publishConfig` in `package.json` | A pull request adds a helper there, and a CI publish job sends its output instead of the real token. | The key is ignored in `publishConfig`. |
| Project chooses the registry | A project sets `registry=` to an attacker's host, so npm asks for a credential for it. | Phase 1 has only per-registry keys. In Phase 2 every request names the registry, and a provider in the global chain answers `url-not-supported` for one it does not serve. An exhausted global chain falls back only to a credential stored under that host's own key, so a host a project chooses gets nothing the user did not store for it. |
| Downgrade by URL variant | A project points `@scope:registry=` at a URL form on the user's own host that a strict global provider declines, so a leftover long-lived stored token for that host replaces the provider's short-lived one. | npm warns whenever it uses a stored credential after a global chain declined the registry; listing `npm:token`, or a per-registry list, removes the fallback. |
| A global provider sees all traffic | A provider in the global chain is asked about every registry a command touches, with a scope and package. | `url-not-supported` is remembered per provider and registry; the per-registry form keeps a provider away from registries it does not serve. |
| Project config reaches the helper's process | A project's `node-options`, exported as `NODE_OPTIONS`, loads code into a node-based helper; a committed `node.cmd` is found by a cmd-shim's bare `node`. | The helper starts in its own directory, without `NODE_OPTIONS` and `npm_config_*`. |
| Project-local binary shadowing | A dependency puts a provider-like binary in `node_modules/.bin`. | Project `node_modules` and the current directory are never searched. |
| PATH poisoning | Shell startup files, `.env` tooling or CI setup redirect a provider name. | Absolute paths or trusted npm locations only; neither key is read from the environment. |
| Typosquatting | Lookalike `npm-credential-provider-*` packages. | Discovery only suggests, only globally, and never installs or runs anything. |
| Compromised provider package | A trusted provider is replaced or updated maliciously. | Pinning by absolute path, version, integrity hash or enterprise allowlist. |
| Silent plaintext fallback | A provider failure quietly re-enables a stored token. | A failure falls back only with the explicit opt-in; the fallback after a global chain declines a registry comes with a warning ([Legacy fallback](#legacy-fallback)). |
| Secrets in logs | A provider prints a token or an authorization header. | Stdout is protocol only; stderr and logs must not carry secrets. |
| Provider mutates npm config | A provider writes into `.npmrc` during an install. | Forbidden for protocol requests; config changes are explicit user actions. |
| Oversized messages | A peer causes memory or CPU pressure. | A maximum line size; an oversized line is rejected whole. |
| Code already running as the user | An install script runs the configured provider itself, as any process can run `git credential fill`. | Not preventable by the protocol. Providers issue short-lived, narrow read credentials and require user presence (an OS prompt, only when `interactive` is `true`) for write credentials. |

##### Publishing while a script runs

The last row is the honest limit of the design, and also where it improves most on today:

- **Today,** a script that finds a publish token in `.npmrc` or `NPM_TOKEN` takes it away and publishes later, from anywhere, without a prompt.
- **With a provider that gates write credentials on user presence,** a script that runs when no publish is under way gets nothing it can use later.
- **During a publish** it still can: `prepublishOnly` and `prepack` run before the upload, and a script there can ask the provider for a write credential with the same fields npm would send, at the moment the user expects npm's own prompt. Nothing in the protocol tells npm's request from the script's.
- **A provider narrows the window** by issuing write credentials bound to the package and version and good for one upload.

Closing the window would need npm to obtain the write credential before any lifecycle script runs, and the provider to refuse write requests for the rest of that command; this is left open ([Unresolved Questions](#unresolved-questions)).

Integrity pinning stays optional in the baseline because of its operational cost, but enterprise and CI deployments should be able to require a resolved provider identity, such as `{ name, version, integrity }` or an absolute path plus checksum.

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
  |     |     |-- "Err: url-not-supported"     -> remember it; next provider in the chain
  |     |     |-- "Err: not-found"             -> next provider in the chain
  |     |     |-- none left                    -> see Legacy fallback
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

Because what a credential lookup costs is mostly starting the program, and a session starts it once. The alternative is a process per cache miss: pnpm runs a helper once per registry per run, RFC #850 caches each result for the life of the process, and Cargo starts its provider afresh for every request and closes stdin after one response.

| Measured on Windows 11 | Process per cache miss | One session per command |
|---|---|---|
| Starting node (`node -e 0`, median of 7 rounds of 10 starts) | about 60 ms (56..68) per start | once |
| An instant mock provider, per lookup (release build, 1000 lookups, 7 rotated rounds, [benchmark](poc/rust/crates/mock-client/examples/round_trip.rs)) | 10.3 ms | 118 µs |

With a handful of lookups per install, a node-based provider started per cache miss costs a few hundred milliseconds per command. The mock measures the floor, not a real provider: vendor CLIs built on Python start slower, and each start may repeat an OS keychain unlock or a token exchange that a session does once.

The session is the client's choice, not the provider's burden: a provider that serves requests until stdin closes, as Cargo's providers do, works the same when started per cache miss. What the session costs is on the client side: serializing requests, coalescing concurrent misses, and ending the session on a timeout ([Session lifecycle](#session-lifecycle)).

### Why ask the global chain before the first request?

Cargo, Git and NuGet ask for a credential only when one is needed: Cargo for registries whose `config.json` says `auth-required` or after a 401, Git after a 401, NuGet after a 401 or 403. npm cannot wait for that signal:

- npm registries do not advertise that they need authentication.
- registry.npmjs.org answers an anonymous request for a private package with 404, not 401; npm's own message for a 404 says the package "could not be found or you do not have permission to access it".
- npm-registry-fetch attaches a credential to the first request, and every stored token works that way today.

So the global chain is asked up front, and the costs are bounded instead: `url-not-supported` is remembered per provider and registry, and a provider that should not see a registry belongs in the per-registry form.

### Why no `refresh` request?

Revision 4 had one, carrying an opaque `refreshState` the provider handed to npm. None of the prior art passes refresh state through the client: Cargo, Git, Docker, NuGet and pnpm have no such request, and the AWS and Azure credential chains refresh inside the provider. Since the provider process lives for the whole command, it can refresh on the next `get`; across commands it keeps refresh state in its own secure storage. The request also lost the scope of the token it refreshed, and made npm hold a second bearer-equivalent secret it did not need.

### Why no batch request?

Revision 4 had `get-batch`. The same benchmark at commit `ab3ad81` measured 31 µs per lookup in one batch against 118 µs as separate `get`s in a session: 0.09 s saved per thousand lookups. No registry today issues per-package tokens, so a real install makes one lookup per registry or scope, a handful in all; and during tree building npm discovers packages one by one, so a batch could not be formed without delaying requests. If a registry ever mints per-package tokens through a batch API, a capability can add the request later without a version change.

### Why npm actions rather than read/write tiers?

Registries disagree on the tiers, as the table under [Operations](#4-operations) shows: npmjs.com splits stage-only from direct publish, GitHub Packages and Azure Artifacts put deletion above write. A coarse `write` would force npm to choose one mapping for every registry, and a provider minting tiered credentials would have to guess from the informational `command`. Naming the action keeps the mapping where the knowledge is, as Cargo does.

## Implementation

This section is informative: it describes one way to meet the requirements above.

- **Where it plugs in.** In `npm-registry-fetch`, `regFetch()` resolves auth synchronously (`getAuth()` in `lib/auth.js`) before the asynchronous fetch starts. A helper or provider call is asynchronous, so helper- and provider-backed auth has to be resolved inside the async fetch path, which `regFetch()` already returns as a promise. pnpm's TypeScript CLI runs `tokenHelper` with `spawnSync`, which blocks the event loop while the helper runs and rules out a long-lived session.
- **Shape.** As suggested in the #850 review from NuGet's experience, npm can define one internal credential-source interface with implementations for the existing config lookup (`_authToken`, `_auth`, `username`/`_password`), `tokenHelper`, the provider protocol, and optionally a built-in source for npm-owned registries that spawns no process.
- **Operation hint.** Commands pass the npm action to `npm-registry-fetch` with the request options; installs default to `read`.
- **Interactive requests.** npm already brackets prompts with `proc-log`'s `input.start()`/`input.end()`, which pause logging and the progress bar (`lib/utils/display.js`); an interactive provider request goes through the same bracket.
- **Config.** `@npmcli/config` gains the per-registry `tokenHelper` key and the `credentialProvider` keys, filtered by source as [Trust](#trust) requires.
- **Phase 1 prototype.** About 440 lines in npm-registry-fetch and 340 in npm/cli, with tests at both repositories' 100% coverage, published as [patches](poc/patches) and run by CI on macOS, Linux and Windows. [prototype.md](prototype.md) describes the code, the checks (end-to-end runs with a real npm, a 2048-combination config matrix, fuzzers, platform probes, every npm/cli suite) and the eight audit rounds that shaped it; [claims.md](claims.md) maps each statement in this document to its evidence.
- **Conformance material.** The draft ships a JSON Schema, a machine-readable policy file, generated test vectors, an executable Python model and a Rust client/provider pair (see the repository README), so npm and third-party providers can be tested against the same cases.

### Configuration

| Setting | Where | Default | Description |
|---|---|---|---|
| `//<registry>/:tokenHelper` | user, global | none | Phase 1: absolute path of a program that prints a token. |
| `credentialProvider[]`, `//<registry>/:credentialProvider[]` | user, global | none | Phase 2: provider chain, tried in order. |
| `credential-provider-legacy-fallback` | user, global | `false` | For migration: use a stored `_authToken`, `_auth` or `username`/`_password` when no provider answers `Ok` after a `not-found`, or a provider shares no protocol version with npm ([Legacy fallback](#legacy-fallback)). It does not apply when every provider in a per-registry list answers `url-not-supported`. |

## Prior Art

### Protocol shape

| | Git | Docker | pnpm `tokenHelper` | Cargo | NuGet plugins | npm RFC #850 | This proposal |
|---|---|---|---|---|---|---|---|
| **Year** | 2012 | 2016 | 2022 | 2023 | 2018 (NuGet 4.8) | 2025 | 2026 |
| **Format** | key=value | JSON | Plain string | JSON (single-line) | JSON over stdin/stdout | JSON | Phase 1: plain string; Phase 2: JSON (single-line) |
| **Direction** | Bidirectional | Bidirectional | Unidirectional | Bidirectional | Bidirectional (the plugin also sends requests, such as log messages) | Unidirectional | Bidirectional |
| **Request kinds** | get, store, erase | get, store, erase | get only | get, login, logout | get (Get Authentication Credentials), set credentials, operation claims | get only | get, erase, login, logout |
| **Context on input** | protocol, host, path | ServerURL | None | registry, operation, name, version | source URI, isRetry, NonInteractive, CanShowDialog | None (args only) | registry, scope, package, version, operation, command |
| **Operations** | — | — | — | read, publish, yank, unyank, owners | — | — | read, publish, stage, deprecate, dist-tag, unpublish, owner, access |
| **Versioning** | None | None | None | Hello `{"v":[1]}` | Handshake negotiates a protocol version (2.0.0 for authentication) | None | Hello `{"v":[1]}` + `v` in every message |
| **Auth type** | Implicit | Implicit | Raw token or header value | Raw token | Username/password with a list of auth types | Implicit | Explicit `bearer`/`basic` |

### Lifecycle and trust

| | Git | Docker | pnpm `tokenHelper` | Cargo | NuGet plugins | npm RFC #850 | This proposal |
|---|---|---|---|---|---|---|---|
| **Refresh** | In helper | In helper | In helper | In provider | In plugin | Re-run | In provider |
| **Cache control** | None | None | None | `never`/`session`/`expires` | None in the protocol (operation claims cached 30 days) | `expiresAt` | Cargo's three + `granularity` + `operationIndependent` |
| **Rejection signal** | `erase` | `erase` | None | Challenge headers | `isRetry` on the next request | None | `erase` + one retry with status and challenges |
| **Chaining** | Yes | No | No | Yes (`url-not-supported` and `not-found` pass; `cargo:token` is a chain entry) | Yes (plugins in priority order, asked only after a 401 or 403; not-applicable passes; credentials in `nuget.config` are sent first) | No | Yes (`url-not-supported` and `not-found` pass; `npm:token` is a chain entry) |
| **Process reuse** | No | No | Once per registry per run | Allowed by the protocol; Cargo starts one per request | Yes; shut down after 1 minute idle | One per cache miss | One per npm command |
| **Discovery** | `git-credential-*` | `docker-credential-*` | Explicit | Explicit | `~/.nuget/plugins`, `NUGET_PLUGIN_PATHS`, and since 6.13 `nuget-plugin-*` on `PATH` | Explicit | Explicit; suggest-only lookup |
| **Production-tested** | Yes | Yes | Yes | Yes | Yes | No | No |

### NuGet

NuGet's plugins are the closest prior art to Phase 2: one long-lived process, a negotiated protocol version, plugins tried in priority order, a retry flag after a rejection, and a request that says whether the client may block for the user ([cross-platform plugins](https://learn.microsoft.com/en-us/nuget/reference/extensibility/nuget-cross-platform-plugins), [authentication plugins](https://learn.microsoft.com/en-us/nuget/reference/extensibility/nuget-cross-platform-authentication-plugin)). Phase 2 differs in three places, each for a reason particular to npm:

- **Timeouts.** NuGet times each request out after 5 seconds and lets a plugin extend that with progress messages. Phase 2 gives each request kind a fixed budget, and an interactive `get` the `login` one: a simpler client, which cannot tell a stuck provider from a slow user before the budget runs out.
- **Discovery.** NuGet finds plugins on `PATH` by name (`nuget-plugin-*`, since 6.13). npm cannot: a script npm runs puts the project's `node_modules/.bin` first on `PATH`, so a dependency could provide a provider by that name.
- **Context.** A NuGet request carries the source URI only; npm sends the package, version and operation, because npm registries scope tokens by package and by action.

### References

[Git credential helpers](https://git-scm.com/docs/gitcredentials), [Docker credential stores](https://docs.docker.com/reference/cli/docker/login/#credential-stores), [pnpm `tokenHelper`](https://pnpm.io/npmrc#urltokenhelper), [Cargo credential provider protocol](https://doc.rust-lang.org/cargo/reference/credential-provider-protocol.html), [NuGet cross-platform authentication plugins](https://learn.microsoft.com/en-us/nuget/reference/extensibility/nuget-cross-platform-authentication-plugin), [pip keyring support](https://pip.pypa.io/en/stable/topics/authentication/).

## Migration Plan

No phase changes behavior for anyone who has not configured a helper or provider.

| Phase | Release | Ships | Done when |
|---|---|---|---|
| 1: `tokenHelper` | next minor | `//<registry>/:tokenHelper` where [Trust](#trust) allows it, its output mapped to a header as pnpm does; a warning for it anywhere else and for pnpm's unscoped and per-scope forms; `publish` and `whoami` counting a helper as a login, `logout` explaining it, `login` and `profile enable-2fa` refusing, OIDC winning over it | One helper serves npm and pnpm from the same `~/.npmrc` |
| 2: `credentialProvider` | a later minor | The protocol (`get`, `erase`, `login`, `logout`, cache control, chaining, one retry after a rejection), `npm login` and `npm logout` delegated to a provider, the schema and conformance vectors published | A provider written against the vectors alone works with npm |
| 3: Ecosystem | separate changes | Vendor providers, with their `login` wrappers no longer writing tokens into `.npmrc`; an evaluation of discovery suggestions, enterprise pinning and a built-in provider for npm-owned registries | — |

## Unresolved Questions

| Question | Decide before |
|---|---|
| Should npm adopt pnpm 11.4's load-time pinning of an unscoped `tokenHelper` to the registry declared in the same user file, which keeps a shared `~/.npmrc` working without letting a project redirect it? | Nothing; it can be added later |
| Should npm accept pnpm's whitespace-split form (a command with arguments, or a bare name), at the cost of paths that contain a space and of a `PATH` lookup inside scripts, or keep the single absolute path? | Nothing; accepting more later stays compatible |
| Should a later release migrate pnpm's unscoped form, for example `npm config fix` rewriting it to the default registry's key after asking? | Nothing |
| Which operation does `npm stage reject` send? | Phase 2 |
| Do account-level commands (`npm token`, `npm profile`) belong to the protocol at all, given that npmjs.com already requires an interactive 2FA challenge for them? | Phase 2 |
| Should npm obtain the write credential for a publish before any lifecycle script runs, so that a provider can refuse write requests for the rest of the command ([Publishing while a script runs](#publishing-while-a-script-runs))? | Phase 2 |
| Should npm ship a built-in provider for npmjs.com that reuses web login sessions? | Phase 3 |
| What format does enterprise provider pinning take (`{ name, version, integrity }`, or a path plus checksum)? | Phase 3 |
| Are discovery suggestions worth their typosquatting surface at all? | Phase 3 |
| A global provider learns the scope and package of the first request to every registry. Should npm send a registry-only first `get` until a provider has answered `Ok` for that registry, or should providers declare the registry URLs they serve in `hello`? | Phase 2 |
| How exactly does a provider match `registry`: host only, or a path prefix, and with what normalization of trailing slash, letter case and port? Every disagreement with npm's own matching is where a stored credential can replace a provider's | Phase 2 |
| Should a later major release drop the implicit `npm:token` at the end of the global chain, as Cargo does, so that a stored credential is used only where the user lists it? | Nothing; it can be decided later |

## Appendix: Comparison with RFC #850

This proposal grew out of the RFC #850 discussion. Where the two differ beyond the rows of [Prior Art](#prior-art):

| Aspect | RFC #850 | This proposal |
|---|---|---|
| **Delivery** | One mechanism | Phase 1 pnpm-compatible `tokenHelper`, Phase 2 protocol |
| **Auth flows** | Not specified | OAuth, SSO, device code, MFA via `login` |
| **Granularity** | Per registry | Per registry, scope, or package |
| **Provider input** | No stdin, arguments only | JSON on stdin with full context |
| **Configuration source** | Project or user | User and global only |
