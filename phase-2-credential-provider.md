# RFC draft: a credential provider protocol for npm

> Status: Draft
> Revision: 29 (the combined draft, revision 28, split by phase)
> Date: 2026-10-17

> Phase 2 of an unofficial proposal building on the [npm/rfcs#850](https://github.com/npm/rfcs/pull/850) discussion. It builds on [Phase 1a](phase-1-token-helper.md), the pnpm-compatible `tokenHelper`, whose motivation, [trust rule](phase-1-token-helper.md#trust) and rules for running a program it reuses. How a credential travels (transport, `http:`, redirects, the cache) is [Phase 1b](phase-1b-credential-hardening.md), which covers a provider's credential as every other.

## Summary

`credentialProvider` configures a provider: a program npm keeps running for the command and talks to over a small versioned JSON protocol on stdin/stdout, modelled on [Cargo's credential providers](https://doc.rust-lang.org/cargo/reference/credential-provider-protocol.html). npm says which registry, package and npm action it needs a credential for; the provider answers with the credential and how long npm may cache it, and is told when the registry rejects it. Providers chain, `npm login` and `npm logout` can be delegated to them, and like a helper a provider is configured only in user-level or global npm config and changes nothing for a user who has not configured one.

## Reading this document

The protocol itself is sections 1 to 6 and [Appendix A](#appendix-a-operations-in-detail): configuration, the messages, the four request kinds, the operations, caching and the security model, most of the text. Section 4 keeps the table of operations and its rules; what each operation means for staged versions, access, trust and account commands, and how registries split their credentials, is in Appendix A, which is as normative as section 4. The rationale, the implementation sketch, the prior art and the comparison with RFC #850 follow the protocol and can be skipped on a first reading. The decisions this document leaves to the npm maintainers are listed under [Open decisions for the npm maintainers](#open-decisions-for-the-npm-maintainers).

Terms used before they are defined:

| Term | Meaning |
|---|---|
| provider | The program a `credentialProvider` entry names; npm starts it once per command and asks it for credentials. |
| per-registry list | `//host/path/:credentialProvider[]=…`: the providers for the registries under that key, in order. |
| global chain | The unscoped `credentialProvider[]=…` list: the providers asked for every other registry ([Session lifecycle](#session-lifecycle)). |
| `npm:token` | The built-in entry that serves the credential stored in `.npmrc`; a global chain ends with it implicitly, reached only when every provider answered `url-not-supported` ([Legacy fallback](#legacy-fallback)). |
| hello `registries` | The list a provider may send first, naming the registries it serves; npm then asks it about no other, and a host it lists is a listed host. |
| presence | A prompt that the person at the terminal answers, which a provider asks before it releases a write credential when `interactive` is `true`. |
| write policy | A provider's own rules for releasing a credential that can write: presence, configuration, the operation; the protocol names it but does not define it. |
| session | One provider process serving one npm command. |
| packument | The registry's metadata document for one package: its versions and dist-tags. |

## Motivation

Phase 2 shares the [motivation of Phase 1a](phase-1-token-helper.md#motivation): registry credentials are standing secrets every install script can read, while registries already issue short-lived tokens npm cannot ask for. Phase 1a lets npm ask, through a helper: compatible with pnpm, small next to the protocol, and enough for a single-registry setup. But a helper learns nothing about the request, cannot say how long its token lives, cannot be told that a token was rejected, and runs once per registry per process. Per-scope tokens, publish-time step-up, long installs that outlive a token, and `npm login` delegation all need the protocol.

## Scope

In scope:

- How npm obtains credentials from a provider for its own HTTP requests to registries.
- Delegating `npm login` and `npm logout` to a configured provider.

Out of scope:

- Credentials for lifecycle scripts. npm gives scripts no provider credential; a script can still run the provider itself, as any process can ([Publishing while a script runs](#publishing-while-a-script-runs)).
- Trusted publishing (OIDC) and the registry's own token model; both are unchanged.
- Git dependencies, proxies, and client certificates (`certfile`/`keyfile`).
- Protecting credentials from code that already runs as the same user: it can run a helper or provider exactly as npm does, as any process can run `git credential fill`. What changes is what it finds: no standing secret in `.npmrc` or the environment, short-lived tokens, and write credentials gated by the provider ([Threat model](#threat-model)).

## Detailed Explanation

### 1. Configuration

`credentialProvider` follows [Trust](phase-1-token-helper.md#trust), as `tokenHelper` does. Project and workspace `.npmrc` files may still configure registries; they cannot enable, override or choose a provider.

```ini
# ~/.npmrc or global npmrc

# Global provider chain (fallback for all registries)
credentialProvider[]=npm-credential-provider-gitlab

# Per-registry provider
//gitlab.example.com/:credentialProvider[]=npm-credential-provider-gitlab

# Per-registry with arguments
//gitlab.example.com/:credentialProvider[]=npm-credential-provider-gitlab --instance https://gitlab.example.com
```

**The global chain** is the one unscoped setting. It is not the unscoped `tokenHelper` that Phase 1a rejects: that helper's output would go to whatever the default registry is, which a project can change, while a provider is told the registry URL in every request and answers `url-not-supported` for a registry it does not serve ([Threat model](#threat-model)). A provider that hands out the same credential for any URL belongs in the per-registry form only.

**Resolution.** Provider commands come from trusted sources only, in this order:

1. Built-in sources, named `npm:…`: `npm:token` in Phase 2, and any later one only where a chain lists it.
2. Absolute paths configured in user-level or global npm config.
3. Provider names found in npm-managed global bin directories, where `npm install -g` links a package's bins (`<prefix>/bin`, and `<prefix>` itself on Windows), derived from a `prefix` that [Trust](phase-1-token-helper.md#where-it-may-be-set) accepts: one a project `.npmrc` did not set. Otherwise a project's `prefix=` would move name resolution into the repository.

The current working directory and project-local `node_modules/.bin` are never searched, and `PATH` is not a trust anchor. A name found in more than one npm-managed global bin directory fails closed, asking for a more specific path. On Windows a name resolves to npm's `<name>.cmd` shim in that directory, the file npm writes for every global bin; the extensionless and `.ps1` files beside it are not run.

**Arguments.** npm's ini parser reads the value first: a value wholly enclosed in double quotes is JSON-decoded, one wholly enclosed in single quotes loses them, and an unquoted one ends at an unescaped `;` or `#` (write `;` and `\#`). `${VAR}` then expands from npm's environment in every element, as in any npm config value. The result is split into argv on whitespace; a double-quoted segment is one argument, so `"C:\Program Files\gitlab\provider.exe" --instance https://gitlab.example.com` keeps its path intact. A spaced path with no arguments needs its quotes escaped (`"\"C:\\Program Files\\p.exe\""`), since quotes around the whole value are ini's. No other quoting, escaping or globbing is applied, and a value that holds a control character after decoding is refused, naming it.

**Precedence.** The most specific per-registry list that matches the request URL replaces the default list; lists are never merged. Between config files the usual npm precedence applies. Configuring both `tokenHelper` and `credentialProvider` for the same registry is an error. Either per-registry key takes that registry out of the global chain, so a per-registry `tokenHelper` beside a global chain is not that error.

**Spawning:**

- **Directly, with an argv vector, never through a shell.** The one exception is a Windows `.cmd` or `.bat` file, which is what an npm-managed global bin directory holds (npm's cmd-shims): it runs as `cmd.exe /d /v:off /s /c` under the same rules as a Phase 1a helper, refusing a path that contains `"` or `%`. Each configured argument is passed to `cmd.exe` inside double quotes, and an argument containing `"`, `%` or a control character, or ending in a backslash, is refused, naming the provider, since `cmd.exe` and the shim's `%*` would reinterpret it; this is checked after ini decoding and `${VAR}` expansion. A provider that needs such an argument takes it from a wrapper script.
- **In the provider's own directory,** never npm's: on Windows a cmd-shim's bare `node` is looked up in the current directory first. A `.cmd` provider on an SMB share starts in the Windows directory, as a helper does. A provider whose directory path is longer than 258 characters is refused, as a helper is.
- **With the environment of a Phase 1a helper** ([How the helper runs](phase-1-token-helper.md#how-the-helper-runs)), cleaned further: without `NODE_OPTIONS`, `npm_config_*`, `EDITOR`, `NODE_ENV`, `COLOR` and the variables npm sets about itself, which carry a project's config, and with `PATH` stripped of the directories npm put in front of it for a script, as for a helper, so that a dependency whose bin npm linked cannot choose a tool the provider calls by name.
- **With the sentinel argument `--npm-credential-provider`** before the configured arguments, as Cargo passes `--cargo-plugin`, so a provider can tell protocol mode from a standalone CLI mode.

### 2. Protocol

The client communicates with the provider via **stdin/stdout** using **single-line JSON messages** (no embedded newlines). The provider is invoked as a child process. Stdin is reserved for protocol JSON only; providers must not read interactive secrets, MFA codes, or device-code confirmations from stdin.

A message is UTF-8 JSON, read where JSON readers differ as follows, so that the schema, a Rust reader and a JavaScript one agree:

- A member that is present has its type: `null` is not "absent", and a field to be left out is left out.
- An integer is a number with no fractional part, however it is written (`1`, `1.0` and `1e0` are one number), from -(2^53 - 1) to 2^53 - 1, the range every reader holds exactly; no number is beyond a double (`1e400`).
- A string, a member name included, holds no lone surrogate (an escape such as `\ud800` with no partner), and only space, tab, carriage return and line feed may follow a value.
- A sender does not name a member twice; what a reader makes of a repeated name is not defined. Unknown members are ignored. A sender stays within 64 levels of nesting, and a reader may refuse more.

#### Version negotiation

On startup, the provider sends a hello message listing supported protocol versions, optionally with capabilities:

```json
{"v":[1]}
{"v":[1],"capabilities":["login","logout","erase"]}
```

The client selects a compatible version and uses it in all subsequent messages. If no version matches, the client terminates the provider and the request fails, naming it, as for any protocol violation ([Legacy fallback](#legacy-fallback)).

A provider may list the registries it serves:

```json
{"v":[1],"registries":["https://gitlab.example.com/"]}
```

npm matches each request against the list itself ([Registry matching](#registry-matching)). A registry outside the list is treated as answered `url-not-supported`, and that provider is sent nothing about it: not the host, scope, package or operation. Without the field the provider is asked and decides from `registry` alone.

The list is handled as follows:

- An empty list serves no registry.
- An entry that is not an absolute `http:` or `https:` URL with the scheme in lowercase, no user info, no backslash and no query or fragment makes the hello malformed, which fails like any protocol violation, naming the provider.
- A provider in the global chain should list its registries, and still answers `url-not-supported` itself for a registry it does not serve. npm logs at `verbose` each provider in the global chain whose hello has no `registries` field, since that provider is asked about every registry the command touches.
- A provider whose hosts follow a pattern, one per region or account, cannot list them as prefixes. It goes in the per-registry form, where the user names each host, or leaves `registries` out and is told every registry the command touches ([Session lifecycle](#session-lifecycle)).

Capabilities are advisory. The client may use them to avoid probing unsupported flows, but it must still handle `{"Err":{"kind":"operation-not-supported"}}`. Unknown capabilities and unknown fields are ignored.

npm sends `authChallenges` and the retry fields (`retry`, `httpStatus`) to every provider, so a provider need not announce anything to receive them, and ignores the fields it does not use.

In the other direction, a provider answers a request `kind` or an `operation` it does not recognize with `operation-not-supported` and keeps serving the session; it must never treat an unknown operation as `read`. Newer clients can therefore add request kinds and operations without breaking older providers, and the conformance schema accepts any lowercase identifier in both fields, listing the known values as examples.

The same holds for a provider newer than npm. An unknown value of a known response field is read as the most cautious known one:

| Field | An unknown value is read as |
|---|---|
| `Err.kind` | `other` |
| `cache` | `never` |
| `granularity` | `package` |

An unknown `auth.type` gives npm nothing it can send, so it fails the request as an `other` answer naming the provider. The schema accepts any lowercase identifier for these fields too.

#### Request (client → provider)

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
| `registry` | string | yes | Canonical URL of the registry the request was made for; see [Registry matching](#registry-matching). |
| `scope` | string | no | Package scope (e.g. `@scope`). Absent for unscoped packages. |
| `package` | string | no | Package name without the scope. Absent for registry-level requests such as `npm search`. |
| `version` | string | for `publish`, `stage` and `stage-reject` | Package version. Lets a provider scope or audit write credentials. |
| `operation` | string | for `get` and `erase` | The npm action the credential must authorize; see [Operations](#4-operations). |
| `command` | string | no | npm command that caused the request, such as `"install"`, `"ci"`, `"publish"`, `"search"`, or `"view"`. Informational, not the permission class; the set is open, and providers must accept command names they do not know. |
| `interactive` | boolean | for `get` (sent with `login` too) | Whether the client can display prompts: `true` only when npm's stdin and stdout are terminals, the test npm already uses for one-time-password prompts, and no CI is detected. It is decided from the process, never from a config value; it is the same for every command; and a child npm decides it for itself by the same test. It says that a prompt can be shown, not that the request comes from npm or that a user is present ([Publishing while a script runs](#publishing-while-a-script-runs)). |
| `retry` | boolean | no | `true` when this request follows a rejected registry request. |
| `httpStatus` | number | when `retry` is `true` | HTTP status of the rejected request, 100–599. |
| `granularity` | string | for `erase` | The `granularity` of the response that carried the rejected credential, so the provider can tell which of its credentials was rejected. |
| `authChallenges` | string[] | no | `WWW-Authenticate` header values (without the header name) from the rejected request. Sent with `erase` and retry requests. |

The client sends all the context it has. A provider that issues one token per registry ignores `scope` and `package`; one that issues finer tokens uses them, and says so in `granularity`.

#### Registry matching

- **Which key applies.** npm selects a per-registry `credentialProvider` list, and checks a provider's hello `registries`, the way it finds a stored token today: it walks up the request URL one path segment at a time, and falls back to the registry chosen for the request (`@scope:registry` or `registry`) only for a URL on that registry's host that matches nothing of its own. A URL on another host gets no credential and asks no provider.
- **What is sent.** `registry` is the URL that matched, the key's or the chosen registry's, with the request's scheme, in canonical form: a WHATWG URL with lowercase scheme and host, an internationalized host in punycode, no default port, `.` and `..` resolved, a path ending in `/`, and no user info, query or fragment.
- **What is sent in the global chain.** `registry` is the chosen registry's URL: a hello `registries` entry decides only whether the provider is asked and is never what is sent.
- **Path components.** A provider that needs a path component of the registry URL (a project id, a repository) therefore gets it from the registry the user chose in the global chain. In the per-registry form it gets it only from a key at or below that path, since under a key above it `registry` is that key's URL.
- **The comparison.** Host and port must be equal after canonicalization, and the served path, ending in `/`, must be a prefix of the request's path at a segment boundary: `/npm` covers `/npm/@s/p` but not `/npmx/p`. Paths are compared byte for byte, so letter case counts and percent-encodings are not decoded. A `//host/path/` key carries no scheme, so none is compared, as for a stored token; an entry in hello `registries` carries one and is compared, so an `https:` entry does not cover an `http:` registry.
- **Keys** are compared as npm compares stored-token keys today, so a key with capital letters in its host matches nothing, for a provider list as for a token, and `//host//` has the path `//`, which does not cover `/@scope/pkg`: the key is `//host/`.

- **Scheme.** `registry` arrives with the request's scheme, so a provider that serves a registry over `https:` answers `url-not-supported` for its `http:` form. A lockfile URL over `http:` on that host then carries nothing from the provider, and the request fails, under a per-registry list as under the global chain: npm never sends a stored credential to a URL form that a provider declined on a host its hello lists ([Legacy fallback](#legacy-fallback)).

The scheme, in one place:

| Where | Scheme | Effect |
|---|---|---|
| A `//host/path/` key (a per-registry list, as a stored token) | not part of the key | the list applies to `http:` and `https:` alike |
| A hello `registries` entry | compared | an `https:` entry does not cover the `http:` form |
| `registry` in a request | the request's | a provider sees the `http:` form and may decline it |
| npm's cache key | included | an answer for `https:` never serves `http:` |
| A stored credential after a decline | — | never sent, by the implicit or a listed `npm:token`, to a form declined on a host a hello lists |
| A Phase 1a helper's credential | not part of the key; sent as a stored token is | [Which requests get the credential](phase-1-token-helper.md#which-requests-get-the-credential) |
| Any credential under [Phase 1b](phase-1b-credential-hardening.md#where-a-credential-may-go) | compared | `https:`, or `http:` to loopback, whatever its source |

Providers that match for themselves should use the same comparison.

#### Success response (provider → client)

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
| `Ok.operationIndependent` | boolean | no | `false` (default): npm asks again for a different operation. `true`: the credential serves every operation, which a provider says only of one that may (one token for read and write, as a stored `_authToken` is). Answers for operations other than `read` are bound to their operation anyway ([Caching](#5-caching)), so the field matters for a `read` answer: left out, that answer is never reused for a write, whose lookup then finds nothing and sends a `get`, which reaches the provider and its write policy. |
| `Ok.granularity` | string | no | `"registry"` (default), `"scope"`, or `"package"`: how broadly npm may reuse the credential. |

#### Auth types

The type is explicit; nothing is inferred from which fields are present, and nothing arrives pre-encoded:

```json
{ "type": "bearer", "token": "glpat-xxxxxxxxxxxx" }
{ "type": "basic", "username": "deploy-token", "password": "glpat-xxxxxxxxxxxx" }
```

npm sends `Authorization: Bearer <token>`, or base64-encodes `username:password` for `Authorization: Basic`; `username` and `password` are non-empty, and a provider whose registry ignores the username sends a fixed placeholder. The legacy `_auth` form is deliberately not carried over.

#### Error response

```json
{"Err":{"kind":"other","message":"Token has expired. Re-authenticate with your credential provider.","causedBy":["OAuth refresh token was revoked"]}}
```

| Error kind | Meaning | Client behavior |
|---|---|---|
| `"url-not-supported"` | Provider does not handle this registry. | Try the next provider in the chain. |
| `"not-found"` | No credentials stored for this registry or scope. | Try the next provider; if none answers `Ok`, fail ([Legacy fallback](#legacy-fallback)). |
| `"operation-not-supported"` | Provider does not support this request kind or operation. | Fail with an unsupported-operation error. |
| `"other"` | Anything else; says why in `message` (the schema does not require it) and may add `causedBy`. | Show the error and fail. |

**Provider chaining:**

- Providers are tried in order, and the first `Ok` wins.
- `url-not-supported` and `not-found` move on to the next provider, as in Cargo; any other error stops the chain and names the provider.
- A provider decides `url-not-supported` from `registry` alone, before it looks at `kind` or `operation`.
- npm remembers `url-not-supported` for that provider and registry for the rest of the command, so a provider that does not serve a registry is asked about it once, not once per package or tarball.
- npm remembers `not-found` the same way, for that provider, registry and scope (an unscoped package's being no scope), so a provider that holds one scope of many is asked about each other scope once.
- A provider that serves a registry for some scopes only answers `not-found` for the others, never `url-not-supported`, which is about the registry URL and would be remembered for every scope. A stored credential serves those scopes only where the chain lists `npm:token` after it ([Legacy fallback](#legacy-fallback)).
- The built-in entry `npm:token`, modelled on Cargo's `cargo:token`, serves the credential stored in `.npmrc` for the registry (`_authToken`, `_auth`, `username`/`_password`), or answers `url-not-supported` when none is stored. Listing it puts the stored credential at a place in the chain the user chose, except that neither a listed nor the implicit entry sends it to a URL form a provider declined on a host its hello lists; a global chain that does not list it ends with it implicitly, reached only when every provider answered `url-not-supported` and, on a host a provider's hello lists, not even then ([Legacy fallback](#legacy-fallback)).
- Names starting with `npm:` are reserved for built-in sources. Apart from the implicit `npm:token`, a built-in source runs only where a chain lists it, and an `npm:` name this npm does not know fails closed, naming the entry.

```ini
# ~/.npmrc — two providers, then the stored credential, tried in order
credentialProvider[]=npm-credential-provider-gitlab
credentialProvider[]=npm-credential-provider-github
credentialProvider[]=npm:token
```

**Trusted publishing.** The OIDC token-exchange request carries the CI identity token and asks no provider.

While a token from a successful exchange is in effect for a registry, npm sends it and asks no provider for the requests that registry key covers, whichever kind of chain applies; this is the precedence Phase 1a gives OIDC over a helper. The token stays in effect until npm's next exchange attempt clears it (one per package in a workspace publish).

The exchanged token is held in memory, is not a stored credential, and draws no ignored-credential warning. A failed exchange, and the requests before one, leave the chain in charge.

This gives the precedence and the cadence, not the set of commands that run an exchange: that set is npm's own, and this RFC does not change it.

#### Legacy fallback

Whether npm uses a credential stored in `.npmrc` (`_authToken`, `_auth`, `username`/`_password`) when the chain does not list `npm:token`; a chain that lists it uses it at that place instead, except for a URL form that a provider declined on a host its hello lists:

| Situation | Stored credential used? |
|---|---|
| No provider configured for the registry | Yes, as today; without one the request goes out anonymously |
| Every provider in the global chain answers `url-not-supported` | Yes, with the exceptions in the note below the table; without a stored credential the request goes out anonymously |
| Every provider in a per-registry list answers `url-not-supported` | No: the user said this registry uses a provider. npm fails, naming the registry and each provider asked |
| A listed `npm:token` behind a provider that answered `url-not-supported` for a URL form on a host its hello lists | No: npm fails, naming the provider and the forms it lists, whether or not a credential is stored |
| No provider answers `Ok` and at least one answered `not-found` | No: npm fails, naming the providers that answered `not-found`. A chain that lists `npm:token` after them uses the stored credential there |
| Any other error, a provider that shares no protocol version with npm, a spawn failure, a malformed message (an `Ok` whose `kind` is not the request's and a second hello among them), an oversized line, a timeout or a provider that exits mid-session, in either kind of chain | No: npm fails, naming the provider |

When every provider in the global chain answers `url-not-supported`, no provider serves the registry, so it is treated as one without a provider. Two cases differ, and the first also binds a listed `npm:token`:

- **A host that a provider's hello lists.** The request fails whether or not a credential is stored, naming the provider and the forms it lists, since that is a URL form the provider declined (another scheme, port or path on its host) and a stored credential must not stand in for it. A listed `npm:token` behind such a provider fails the same way, even when other entries stand between them: npm's `//host/path/` key carries no scheme, so a token stored for the `https:` form would otherwise go out over `http:`. A listed entry that stands before the provider, or behind one that answered `not-found` or whose hello does not list the host, is unaffected.
- **Any other host.** npm warns once per registry per command when it uses a stored credential this way, naming the registry, the file the credential came from and the providers that declined. When every provider in the chain lists its registries in hello and none lists this host, it uses the credential without a warning, since no provider stands behind that host.

A credential stored for a registry whose per-registry list does not include `npm:token` is never used, and npm warns about it on every command so that it gets deleted.

After a `not-found` a provider stands behind the registry and holds nothing for it, which is where a leftover long-lived token is least wanted, so the stored credential is used there only at a place the user wrote down: an `npm:token` entry after the provider. There is no setting that changes this.

A silent fallback would mask provider failures and bring back the stored secret the user set out to remove. The one fallback that stays, after a global chain declines a registry, is what npm does without providers, and it is announced whenever it uses a stored secret. A broken global provider, in turn, fails every command that goes to the network, including anonymous reads from registry.npmjs.org: the provider cannot be told apart from one that would have answered.

The implicit `npm:token` is not planned to go. Cargo can let an exhausted chain fail because it asks only for registries that need a credential; npm's global chain is asked about every registry, so without the entry, adding one global provider would change every registry that provider does not serve. Where a stored credential must not stand in for a provider, a per-registry list for that host ignores it.

Providers write diagnostics to stderr, which npm reads line by line and logs at `verbose`. Unlike a Phase 1a helper, whose stderr is the only way it can speak to the user, a provider has `message` and `causedBy` for what the user must see, so a chatty provider does not fill every install with warnings.

Before logging a line, npm:

- removes control characters (C0 and C1 except tab);
- masks every credential the provider has returned in this command and anything that looks like a credential;
- drops any line longer than the maximum line size.

npm applies the same stripping and masking to `message` and `causedBy` before it shows them, since both may relay a registry's text.

Prompts never go to stderr: they go to the controlling terminal ([Non-interactive and CI behavior](#non-interactive-and-ci-behavior)). Providers must not write tokens, passwords, authorization headers, or other bearer-equivalent secrets to stderr or any ordinary log.

Stdout carries protocol JSON only. npm reads it a line at a time and holds one line at most. A line over npm's maximum line size is an oversized line: the session ends as for any protocol violation, the provider is killed and the request fails, naming it, as when a Phase 1a helper writes more than 1 MiB. A session serves many requests, so its stdout in total is not a reason to fail, but what npm keeps of it for its log is at most 1 MiB per session, as for a Phase 1a helper, so a chatty provider cannot fill the log.

#### Session lifecycle

The client spawns a provider lazily, on the first request to a registry it applies to:

- **A registry with a per-registry `credentialProvider` list:** that list.
- **A registry with a per-registry `tokenHelper`:** no provider.
- **Any other registry:** the global chain, including registries that need no credential, such as anonymous reads from registry.npmjs.org.

So a global provider starts with any command that goes to the network, to send its hello. Unless the hello lists the registries it serves, it also learns every registry the command touches, with the scope and package of the first request to each. The per-registry form keeps a provider away from registries it does not serve.

No provider starts in these cases:

- a request that pacote serves from its cache by integrity (a tarball named in the lockfile);
- `--offline`, except the packument fetch that precedes a write, which npm makes online whatever `--offline` says ([Phase 1a](phase-1-token-helper.md#how-the-helper-runs)) and which therefore starts the chain;
- a command that makes no registry request, or one to which no chain applies.

A request the HTTP cache could have answered still starts the chain first, as a Phase 1a helper runs before a `--prefer-offline` request: credentials are resolved before make-fetch-happen consults its cache. Most installs still make one registry request, the audit, unless run with `--no-audit`.

Why npm cannot wait for a 401 first, as Cargo, Git and NuGet do, is in [Rationale](#why-ask-the-global-chain-before-the-first-request).

The provider process then lives for the rest of the npm command and serves every request for it. Requests within a session are strictly sequential: the client sends a request only after reading the response to the previous one, and messages carry no request id ([Rationale](#why-no-request-id-or-progress-message)). A line the provider sends while no request is outstanding is a protocol violation: npm kills the provider and fails, naming it, so a stray line is never read as the answer to the next request.

npm fetches in parallel, so the client serializes provider requests. A request waiting its turn looks the cache up again before it is sent:

- when the answer to the request ahead of it covers it, as a `scope`-level credential covers every package of that scope, it sends no `get`;
- when an erase ahead of it evicted the credential it would have used, it does not leave with that credential.

The cost of one channel is that a prompt that waits on the person holds the requests behind it for that provider, up to the interactive timeout, so a provider answers what it can from its own state without prompting.

The client closes stdin to end the session, and the provider exits. npm need not wait for it to exit and sets no deadline, so a provider must not depend on work after stdin closes, such as revoking a credential it minted: that rests on an expiry the provider chose, since `erase` is sent only after a rejection. When npm exits with a request still outstanding, after Ctrl-C or a failure elsewhere, it kills the provider as for a timeout, so a provider waiting on a prompt is not left behind.

Clients and providers enforce a maximum line size of their choosing, at least 1 MiB (the newline counted), the Phase 1a output limit; an oversized line is rejected whole, not partially processed.

A provider that receives such a line, or any line that is not a request the schema allows (not UTF-8, not JSON, not an object), answers it with one `Err` (`other`: it is "anything else" in the table above) and serves the next line: it never answers `Ok` to it, and it does not exit for it. A line that is empty or holds nothing but spaces, tabs and carriage returns is skipped.

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
- the next request that needs the provider starts a new session, but a provider killed twice in one npm command for a timeout, at hello or during a request, is not started again.

A provider that exits, or closes its stdout, in the middle of a session is treated as one killed for a timeout: the request fails, so do the ones queued behind it, and it counts toward the two. A provider is ended with SIGTERM, then SIGKILL after 2 seconds, and on Windows its whole process tree; a Phase 1a helper is killed on its limits.

#### Non-interactive and CI behavior

When `interactive` is `false`, providers must not open browsers, prompt for MFA, wait for device-code approval, or ask the user to approve a new trust decision. They may only use credentials and trust decisions that already exist.

A provider answers `other`, with a message naming what was needed, when it holds a credential for the registry and operation but:

- its policy will not release it without user presence it may not ask for; or
- its login for it has lapsed and can be renewed only by a flow `interactive: false` forbids.

`not-found` would let a listed `npm:token` serve a stored credential in place of the one the provider meant to withhold. A provider with nothing stored, not even a lapsed login, still answers `not-found`.

A chain meant to serve CI from a later entry therefore needs the earlier provider to answer `not-found` or `url-not-supported` there, which a provider with nothing stored for CI does.

When `interactive` is `true`, providers may use browser flows, OS-native prompts, or status text written to the controlling terminal. While an interactive request is outstanding, npm pauses its own progress output, as it already does for OTP prompts. A provider whose user declines a presence prompt, or lets it time out, answers `other`, not `not-found`.

Providers still must not read from stdin, which belongs to the protocol:

- A provider that needs typed input opens the controlling terminal directly (`/dev/tty`, or `CONIN$`/`CONOUT$` on Windows), for both the prompt and the answer.
- A runtime that resolves file names itself, as Node does, opens them as `\\.\CONIN$` and `\\.\CONOUT$`, or it writes a file of that name in its working directory instead.

A program the provider runs may inherit the protocol pipes, depending on how it is started: the provider gives it no stdin and captures or redirects its stdout, so it neither reads a request nor writes into the protocol stream, and hands it the controlling terminal when it must prompt.

In CI the provider must already be configured through user or global config or a machine image, and resolve from a trusted source. If no usable credential is available, npm fails with a clear error rather than prompting.

### 3. Request kinds

| Kind | Sent when | Answer |
|---|---|---|
| `get` | A registry request needs a credential the cache does not hold | The credential, as described above |
| `erase` | The registry rejected a provider's credential | `{"Ok":{"kind":"erase"}}` once the provider has dropped it |
| `login` | `npm login` for a provider-backed registry | `{"Ok":{"kind":"login"}}` once the provider has stored a credential |
| `logout` | `npm logout` for a provider-backed registry | `{"Ok":{"kind":"logout"}}` once local credentials are gone |

A provider answers a kind it does not implement with `operation-not-supported`.

#### `get`: request a credential

The primary runtime flow, described above.

#### `erase`: a credential was rejected

What the client does when the registry answers a request made with a provider's credential:

| Response | Erase? | Retry `get`? | Why |
|---|---|---|---|
| Any other 401 | Yes (npm may skip sending it when hello did not list `erase`; it evicts the rejected credential from its cache either way) | Once, with `retry: true`, `httpStatus: 401` and the challenges | The credential was rejected |
| 401 that npm treats as a one-time-password challenge: one of the comma-separated items of `WWW-Authenticate` is `otp`; or there is no `WWW-Authenticate` and the raw body matches `one-time pass`; or no item is `otp` or `ipaddress` and a body that is not JSON matches it | No | No; npm's one-time-password prompt | The credential is valid; erasing would discard it on every 2FA publish |
| 401 whose `WWW-Authenticate` names `ipaddress`, which takes precedence | No | No; `EAUTHIP` | The credential is valid but not from this address |
| 403 | No | Once, with `retry: true` and `httpStatus: 403` | The credential was accepted but lacks permission; the provider may have a more privileged one for the same operation |

Each registry request gets at most one provider retry. A credential the retry returned and the registry rejects again with a 401 is evicted and erased like the first, with no further retry, and the rejection is reported.

A retry is answered under the provider's policy for the operation and context it names, with the presence checks that policy requires.

A 403 may move the provider to another credential it would release for that request, never to one it would not: a registry, or a URL a lockfile names on its host, can send a 403 for free. For `read`, a 403 never moves to a credential that can write when the provider's first answer could not.

The retry names the context of the failed request, not the credential that was refused or the registry's reason for refusing it:

- a provider that needs the credential keeps its own record of what it handed out for that context;
- one that needs the reason checks against the `registry` the request names, never against a URL taken from `authChallenges`.

npm ties each registry request to the `get` answer whose credential it carried. A 401 or 403 on an answer npm has already erased or replaced sends no erase and no `retry` request. The request is sent again, once, with one of these:

- what the cache now holds;
- on a cache miss, the answer to a plain `get` (without `retry`) to the provider that served the stale credential.

That send is the request's one retry: a 401 or 403 on what it then sends gets none. A 403 retry answered `Ok` first removes the refused credential from the cache as an erase does, by value, but without sending an erase, so the retry's credential is not shadowed by the refused one.

To erase, the client first removes every cache entry that holds the credential, by value, whatever answer, granularity or registry URL it was cached under, so a token that covers a whole domain is not left cached for other URLs and a coarser credential returned by the retry is not shadowed by the rejected one. It then tells the provider, with the context of the `get` that produced the credential (`registry`, `scope`, `package`, `version`, `operation`) and that response's `granularity`:

```json
{"v":1,"kind":"erase","registry":"https://gitlab.example.com/api/v4/projects/123/packages/npm/","scope":"@scope","package":"package","operation":"read","granularity":"scope","authChallenges":["Bearer realm=\"https://gitlab.example.com\""]}
```

The provider invalidates the credential that context identifies, including one bound to a package or an operation, and answers `{"Ok":{"kind":"erase"}}` or an error. Erase drops a credential the provider minted for npm, and any copy of it the provider keeps. It never removes what `login` stored, such as a refresh token or a stored personal access token; removing that is `logout`'s job. A provider whose stored credential is itself the one it hands out therefore keeps it; the rejection is reported, naming `npm logout` and `npm login`.

A 401 does not prove the login is dead, because the URL may be one a lockfile chose on the registry's host. A provider should therefore start no login flow on the strength of the 401 alone, only after a check of its own, against the registry or the service that holds the login, confirms that its login was rejected.

`authChallenges` describe the rejection; a URL they name (`realm`) never decides where a provider sends a credential. The retry carries the rejection as context:

```json
{"v":1,"kind":"get","registry":"https://gitlab.example.com/api/v4/projects/123/packages/npm/","scope":"@scope","package":"package","operation":"read","command":"install","interactive":false,"retry":true,"httpStatus":401,"authChallenges":["Bearer realm=\"https://gitlab.example.com\""]}
```

- An erase answered `not-found`, `url-not-supported` or `operation-not-supported` is ignored, one answered `other` is shown as a warning, and in all these cases the retry still goes out; an erase that times out fails the request, as any timeout does ([Session lifecycle](#session-lifecycle)).
- The retry `get` goes only to the provider that served the rejected credential; any answer but `Ok` fails the request, naming that provider. A rejection is no reason to switch sources, and a fall-through to `npm:token` would hand a lockfile-chosen 401 a downgrade to a stored secret. A provider with no other credential it would release for the request answers `other`, saying so, rather than the credential just refused: the retry could only fail the same way, and a 403 is not always about the credential, so the message names what the provider knows, not a cause it guesses.
- A credential from `npm:token`, listed or implicit, or from an OIDC exchange gets no erase and no provider retry; npm handles its rejection as it does today.
- npm keeps the response's `granularity` with the credential it sent, cached or not (`cache: "never"`), so every erase carries it.

#### `login`: authenticate with a registry

`npm login --registry https://gitlab.example.com/api/v4/packages/npm/` delegates to the configured provider, which can run OAuth, SSO, device-code or MFA flows that `npm login` cannot:

```json
{"v":1,"kind":"login","registry":"https://gitlab.example.com/api/v4/packages/npm/","interactive":true}
```

| Optional field | Description |
|---|---|
| `token` | A token the user supplied directly; the provider should store it. npm reads it from a hidden prompt or from its own stdin, never from a command-line argument, which would leave it in shell history and process listings, and leaves it out of what it logs of the request at any level. |

The provider stores the result in its own secure storage and answers `{"Ok":{"kind":"login"}}`, or `operation-not-supported` if it has no interactive login. Typical flows:

| Flow | Provider behavior |
|---|---|
| OAuth 2.0 / OIDC | Opens a browser, exchanges the authorization code, stores the result in the OS keychain. |
| Device code | Prints URL and code on the controlling terminal, polls for approval, stores the token. |
| SSO / SAML | Opens a browser for the SSO redirect, stores the token. |
| MFA / 2FA | Prompts on the controlling terminal and reads the code from it. |
| Static token | Stores the supplied `token`. |

`login` travels the chain that applies to the registry, in order, and ends the way `get` ends: `url-not-supported` moves on, and `not-found` moves on to the next entry the chain lists. Any other answer, `operation-not-supported` included, ends the chain and names the entry, and a per-registry list whose entries all pass fails.

The `npm:token` entry behaves as follows:

- A listed `npm:token` runs `npm login` as today and saves the token to user config.
- The implicit `npm:token` at the end of a global chain does so only when every provider before it answered `url-not-supported`, and npm then warns that it stores a plaintext token, naming the registry and the providers that declined.
- After a `not-found` with nothing listed behind it, `npm login` fails, naming the providers, rather than writing a token that `get` would never send.

#### `logout`: remove stored credentials

`npm logout --registry https://gitlab.example.com/api/v4/packages/npm/` sends:

```json
{"v":1,"kind":"logout","registry":"https://gitlab.example.com/api/v4/packages/npm/"}
```

The provider attempts server-side revocation as a best effort, always removes its local credentials, and answers `{"Ok":{"kind":"logout"}}` even if revocation failed, warning on stderr. `not-found` means there was nothing to remove. `logout` travels the chain as `login` does; the `npm:token` entry removes the stored token as `npm logout` does today.

### 4. Operations

`operation` names the npm action, and the provider decides which credential satisfies it. npm does not impose tiers because registries draw them differently:

| Operation | npm commands | `version` |
|---|---|---|
| `read` | `install`, `ci`, `update`, `view`, `search`, `outdated`, … | — |
| `publish` | `publish`, and approving a staged version (`npm stage approve`) | required |
| `stage` | `npm stage publish` | required |
| `stage-read` | `npm stage list`, `view`, `download`, and the lookup `approve` and `reject` make first | — |
| `deprecate` | `deprecate`, `undeprecate` | optional |
| `dist-tag` | `dist-tag add`, `dist-tag rm` | optional |
| `unpublish` | `unpublish` | optional (absent: the whole package) |
| `owner` | `owner add`, `owner rm` | — |
| `access` | every `access`, `team` and `org` subcommand, the listings (`access list`, `access get`, `team ls`, `org ls`) included | — |
| `trust` | every `trust` subcommand (`github`, `gitlab`, `circleci`, `list`, `revoke`) | — |
| `stage-reject` | `npm stage reject` | required |
| `account` | every `token` subcommand (`list`, `create`, `revoke`), `profile get`, `profile set` | — |

The operation belongs to the command, not to each request: every request a command makes carries the command's operation, so a provider is never pushed by a 403 to widen a credential labelled `read`. That includes:

- the lookups a write needs first (a packument fetched with `?write=true`, the user record `owner add` reads);
- the reads that follow it (`access set status` reads the visibility back, `org rm` lists the members).

The one exception is the `stage-read` lookup that `stage approve` and `reject` make first ([Appendix A](#appendix-a-operations-in-detail)).

Some commands send their operation on rules of their own:

- Commands that write nothing and belong to no row (`whoami`, `owner ls`) send `read`.
- `publish`, `unpublish` and `deprecate` run with `--dry-run` skip their writes, so every request they make sends `read`: a `publish --dry-run` in a pull-request job asks for no write credential and draws no presence prompt.
- Every other command sends its operation whatever `dry-run` says, since `dry-run` is an ordinary config key a project `.npmrc` can set.
- `profile enable-2fa` refuses under a provider, as under a helper: it may replace the stored credential with a new token, which a provider's credential cannot take part in. `disable-2fa` is not refused; it sends `account`.

The protocol's `scope` is always the package's scope, never a team's or an org's.

An operation can span two tiers of one registry (`dist-tag add` and `dist-tag rm` both send `dist-tag`), and a provider cannot rely on the request to tell them apart: it answers under its policy for the whole operation, and may start with the lower credential and move up on a 403, under the same policy and its presence checks.

What each operation means for account, access and trust commands, the lookup a staged version needs, and how registries split their credentials across these operations is in [Appendix A](#appendix-a-operations-in-detail), which is as normative as this section.

A provider returning a stage-only token for `stage` leaves `operationIndependent` at its default `false`, so npm never reuses it for `publish`; it says `true` only of a credential that may serve every operation.

### 5. Caching

The client caches credentials in memory, keyed by the `granularity` the provider returned:

| Granularity | Cache key | Effect |
|---|---|---|
| `"registry"` | registry URL | One credential for every package on the registry, as today. |
| `"scope"` | registry URL + scope | Different credentials for `@scope-a/*` and `@scope-b/*` on one registry. |
| `"package"` | registry URL + scope + package | A credential per package. |

The key also records the granularity level itself, and the operation when `operationIndependent` is `false` (the default) or the operation is not `read` (below), so entries from different levels never collide (an unscoped package named `read` must not match a scope-level entry bound to operation `read`).

Lookups go from most to least specific: package, then scope, then registry, and at each level an entry bound to the requested operation before an operation-independent one. An entry with `cache: "expires"` stops matching 60 seconds before `expiresAt`, so a request never leaves with a credential about to lapse. If nothing matches, the client sends `get`.

The registry URL in a cache key is the `registry` npm sent, scheme included, so a credential cached for an `https:` registry never answers a request to its `http:` form. A field the request did not carry is part of the key as absent: a `scope` answer for an unscoped package serves unscoped packages, and a `package` answer to a request without a package serves only requests without one.

An answer for any operation other than `read` is cached bound to that operation and, when the request names a package, to that package, whatever `granularity` and `operationIndependent` say. `publish`, `dist-tag`, `unpublish` and `owner` run once per workspace package in one npm process, and a credential the user released for one package must not serve the next one without a `get`; a provider that will serve it anyway answers that `get` from its own state, without prompting again.

The client keeps no credential store of its own and writes no credential to disk; what npm's HTTP cache may record about a request is what it records for a stored token ([Phase 1a](phase-1-token-helper.md#which-requests-get-the-credential)); [Phase 1b](phase-1b-credential-hardening.md#the-http-cache) keeps `Authorization` out of the cache index for every credential.

### 6. Security model

Install scripts are chosen by package authors and the dependency graph; helpers and providers are chosen by the user, the machine's owner or an administrator. This feature must not become a project-controlled install hook: a cloned repository, a dependency, a lockfile or a project `.npmrc` must not be able to introduce one. The ecosystem is reducing install-time code execution, and automation makes lookalike packages and probes of weak trust boundaries cheap, so anything that runs before or during an install fails closed.

**What the design guarantees:**

- **Configuration** comes only from user and global files that a project did not choose ([Trust](phase-1-token-helper.md#where-it-may-be-set)); project files, `publishConfig`, the environment and the command line cannot set either key, and npm-registry-fetch takes neither from the config keys a caller passes, only from an option npm fills from those files.
- **Resolution** never searches the current directory or project `node_modules`, local packages cannot shadow global providers, and ambiguous names fail closed.
- **The provider's process** starts in its own directory, without the environment variables that carry a project's config.
- **Input** is the protocol fields only: nothing in a request is an environment variable or a file path, and stdin is not an interactive channel. The environment the provider is started with ([Spawning](#1-configuration)) is separate from the request and is its own affair; CI needs some of it. npm strips only the variables that carry a project's config, so a provider treats any other variable as set by whoever ran npm: one that releases credentials only on user presence takes the settings that choose its identity, or name a program it runs, from its own configuration where it can.
- **Output** is validated by the client; unknown fields are ignored. Stdout is protocol JSON only, and stderr must not carry secrets; npm strips control characters and masks credentials in whatever it shows or logs from stderr and error messages.
- **Storage:** npm keeps no credential store of its own and writes no credential to disk itself; what its HTTP cache may record is covered under [Caching](#5-caching). Providers own their storage (OS keychain, encrypted file) and never write credentials or configuration into an `.npmrc` as a side effect of a request.

**What it does not guarantee:**

- That code already running as the user cannot get a credential: it can run a provider exactly as npm does ([below](#publishing-while-a-script-runs)).
- That a trusted provider stays trustworthy. A provider replaced or updated maliciously upstream is outside the protocol.

The user pins against it, outside the protocol:

- By an absolute path to an install that does not change in place: a provider installed at a fixed version into a directory of its own, with its dependencies locked, or a native binary that no package manager or self-updater replaces.
- npm checks no hash or signature: a hash of a node provider's entry file leaves its dependencies open, and code signing pins a publisher, not the bytes.
- Against code already running as the user, the path and the config that names it must also be files the account cannot write, which only an administrator arranges.

#### Threat model

| Threat | Example | Mitigation |
|---|---|---|
| Malicious project `.npmrc` | A repository makes `npm install` run a program it chose. | The key is ignored in project and workspace `.npmrc`. |
| Project relocates user or global config | A project sets `userconfig=./x.npmrc`, `globalconfig` or `prefix`, so a repository file loads as the user's. | Phase 1a: a helper or provider is honoured only when a project `.npmrc` set none of `userconfig`, `globalconfig` and `prefix` ([Where it may be set](phase-1-token-helper.md#where-it-may-be-set)). [Phase 1b](phase-1b-credential-hardening.md#project-config-cannot-choose-the-user-or-global-file) refuses those settings in a project `.npmrc`. |
| `publishConfig` in `package.json` | A pull request adds a helper there, and a CI publish job sends its output instead of the real token. | The key is ignored in `publishConfig`. |
| Project chooses the transport | A project's `.npmrc` sets `https-proxy`, `proxy`, `ca`, `cafile` or `strict-ssl=false`, so a fresh credential goes through the repository's proxy or past a certificate it chose. | [Phase 1b](phase-1b-credential-hardening.md#which-settings-a-credentialed-request-may-take-from-a-project): a request that carries any credential, a provider's included, takes those settings, and `noproxy` and `local-address`, only from config a project cannot write, child npm processes included. Until it lands, a provider's credential follows the transport rules of a stored token. |
| Project chooses the registry | A project sets `registry=` to an attacker's host, so npm asks for a credential for it. | Phase 1a has only per-registry keys. In Phase 2 every request names the registry, and a provider in the global chain answers `url-not-supported` for one it does not serve. An exhausted global chain falls back only to a credential stored under that host's own key, so a host a project chooses gets nothing the user did not store for it. |
| Downgrade by URL variant | A project points `@scope:registry=` at a URL form on the user's own host that a strict global provider declines, so a leftover long-lived stored token for that host replaces the provider's short-lived one. | npm sends no stored credential to a URL form declined on a host that a provider's hello lists, and the request fails; elsewhere it warns when it uses a stored credential after a global chain declined the registry ([Legacy fallback](#legacy-fallback) says where); a per-registry list removes the fallback, and listing `npm:token` puts the stored credential at a place the user chose, though not past a form a provider declined on a host its hello lists. [Phase 1b](phase-1b-credential-hardening.md#where-a-credential-may-go) also withholds any credential from a non-loopback `http:` form. |
| A global provider sees all traffic | A provider in the global chain is asked about every registry a command touches, with a scope and package. | A provider that lists its registries in hello is sent nothing about any other; otherwise `url-not-supported` is remembered per provider and registry. The per-registry form keeps a provider from even starting for registries it does not serve. |
| Project config reaches the helper's process | A project's `node-options`, exported as `NODE_OPTIONS`, loads code into a node-based helper; a committed `node.cmd` is found by a cmd-shim's bare `node`. | The helper or provider starts in its own directory, without `NODE_OPTIONS`, `npm_config_*`, `EDITOR`, `NODE_ENV` and the other variables npm sets from config. |
| Another tool passes project config to npm-registry-fetch | A tool that reads a repository's `.npmrc` and hands its keys to npm-registry-fetch, as npm-check-updates does, would run a helper the repository names. | The library ignores helper and provider config keys and takes them only from a dedicated option that npm fills from trusted files. |
| Project-local binary shadowing | A dependency puts a provider-like binary in `node_modules/.bin`. | Project `node_modules` and the current directory are never searched. |
| PATH poisoning | Shell startup files, `.env` tooling or CI setup redirect a provider name; inside `npm run`, a dependency's `node_modules/.bin` leads `PATH` for the tools a provider calls by name. | Absolute paths or trusted npm locations only; neither key is read from the environment; npm removes from the `PATH` a provider gets the `node_modules/.bin` directories and the `node-gyp-bin` it added for a script; a project's own script can still set any `PATH`, and runs as the user ([Scope](#scope)). |
| Typosquatting | Lookalike `npm-credential-provider-*` packages. | npm never discovers, suggests, installs or runs a provider it was not configured with; a name resolves only in npm-managed global bin directories, after the user wrote it into user or global config. |
| Compromised provider package | A trusted provider is replaced or updated maliciously upstream. | An absolute path to an install that does not update in place, chosen by the user; an administrator enforces it with OS application control and file permissions, outside npm ([Security model](#6-security-model)). |
| Silent plaintext fallback | A provider failure quietly re-enables a stored token. | A failure, `not-found` among them, falls back to a stored credential only where the chain lists `npm:token`; the fallback after a global chain declines a registry comes with a warning ([Legacy fallback](#legacy-fallback)). |
| Secrets in logs | A provider prints a token or an authorization header. | Stdout is protocol only; stderr and logs must not carry secrets. npm masks the credentials it received, and credential-like strings, in what it logs. |
| Provider mutates npm config | A provider writes into `.npmrc` during an install. | Forbidden for protocol requests; config changes are explicit user actions. |
| Oversized messages | A peer causes memory or CPU pressure. | A maximum line size; an oversized line is rejected whole. |
| Code already running as the user | An install script runs the configured provider itself, as any process can run `git credential fill`. | Not preventable by the protocol. Providers issue short-lived read credentials, narrow where the registry allows it, and require user presence (an OS prompt, only when `interactive` is `true`) for write credentials. |

#### Publishing while a script runs

The last row is the honest limit of the design, and also where it improves most on today:

- **Today,** a script that finds a publish token in `.npmrc` or `NPM_TOKEN` takes it away and publishes later, from anywhere, without a prompt.
- **With a provider that gates write credentials on user presence,** a script that runs when no publish is under way gets nothing it can use later, unless it can rewrite the provider or the config that names it.
- **During a publish** it still can: `prepublishOnly`, `prepack`, `prepare` and `postpack` run before the upload, with the user's terminal, and a script there can ask the provider for a write credential with the same fields npm would send, at the moment the user expects npm's own prompt. No field in a request can tell npm's request from the script's, since a process of the same user can send the same bytes.

npm does not ask for the write credential before these scripts. Before they run it does not know the final name, version or registry (it reads the manifest and `publishConfig` again after packing); the prompt would come before a build that a short-lived credential may not outlast; the scripts can change the tarball without any credential; and npm's own one-time-password prompt and OIDC exchange sit in the same window. What narrows it is the provider's own policy, which needs no protocol field:

- a write credential bound to the package, version and operation;
- a user-presence prompt that names them;
- no write credential for the same package to another session while one that holds it is alive, which needs state shared between provider processes. Under today's order this detects a script that asked first, since npm's own request is then refused and the publish fails where the user sees it, but it does not stop the script's upload.

What closes the window is not running scripts during the publish: build first, then `npm publish --ignore-scripts`; or stage the version for approval with 2FA, provided the provider hands out a stage-only credential in that context. npm 12's script opt-in covers dependencies' install scripts, not the publishing package's own lifecycle. An opt-in for npm to ask before the scripts, once the name, version and registry can be fixed first, would be a client change, not a protocol change.

npm checks no hash, version or signature of a provider when it starts it: integrity describes a tarball, not the installed files, a global install records no tree, and a version says nothing about dependencies.

npm also has no configuration an administrator owns that the user cannot override: the builtin `npmrc` in npm's own directory ranks lowest of the files, and a user who can run node can run another npm. An administrator who must decide what runs as a provider does it outside npm: a managed node and npm installation, file permissions on the provider's path, and OS application control (WDAC or AppLocker on Windows, code signing and MDM on macOS), as for any other program the user may run.

The RFC's rule is narrower than Git's protected configuration, which also trusts the command line: only the user's own user and global files can choose a provider, and nothing a project controls can.

An administrator who wants to provision a default where the global file is the user's (the Windows installer's builtin `npmrc` sets `prefix=${APPDATA}\npm`) can do so today: the builtin `npmrc`, or a machine-wide environment variable, may set `globalconfig` to a file the administrator owns that no project `.npmrc` names, and that file is then the trusted global file.

It is a default, not a pin: the user's own file ranks above it, and an installer upgrade that replaces the builtin `npmrc` drops the line unless deployment applies it again.

### 7. Provider lifecycle

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

### 8. Examples

How providers for real registries would answer, with their configuration, hello, and the exchanges for an install, a publish and a rejection, is in [examples/](examples/README.md); each also says where a provider author is likely to go wrong.

## Rationale and Alternatives

### Why one provider process per command?

Because what a credential lookup costs is mostly starting the program, and a session starts it once. The alternative is a process per cache miss: pnpm runs a helper once per registry per run, RFC #850 caches each result for the life of the process, and Cargo starts its provider afresh for every request and closes stdin after one response.

| Measured on Windows 11 | Process per cache miss | One session per command |
|---|---|---|
| Starting node (`node -e 0`, median of 7 rounds of 10 starts) | about 60 ms (56..68) per start | once |
| An instant mock provider, per lookup (release build, 1000 lookups, 7 rotated rounds, [benchmark](poc/rust/crates/mock-client/examples/round_trip.rs)) | 10.3 ms | 118 µs |

With a handful of lookups per install, a node-based provider started per cache miss costs a few hundred milliseconds per command. The mock measures the floor, not a real provider: vendor CLIs built on Python start slower, and each start may repeat an OS keychain unlock or a token exchange that a session does once.

The session is the client's choice, not the provider's burden: a provider that serves requests until stdin closes, as Cargo's providers do, works the same when started per cache miss. What the session costs is on the client side: serializing requests, looking the cache up again for queued misses, and ending the session on a timeout ([Session lifecycle](#session-lifecycle)).

### Why ask the global chain before the first request?

Cargo, Git and NuGet ask for a credential only when one is needed: Cargo for registries whose `config.json` says `auth-required` or after a 401, Git after a 401, NuGet after a 401 or 403. npm cannot wait for that signal:

- npm registries do not advertise that they need authentication.
- registry.npmjs.org answers an anonymous request for a private package with 404, not 401, as npm's own message for a 404 assumes (it says the package "could not be found or you do not have permission to access it"); a name that does not exist gets 404, and a user report shows the same for a private one, but npm documents no such policy ([the message](sources.md#external-facts); [the policy is not verified](sources.md#not-verified)).
- npm-registry-fetch attaches a credential to the first request, and every stored token works that way today.

A first `get` that names only the registry, asked before the real one, was considered and rejected: it is the same message as a registry-level request such as `npm search`, so it invites a registry-wide credential where a scope-bound one was wanted, and it costs a round trip per registry. A provider that lists its registries in hello lets npm, not each provider, decide which URLs are the same registry.

So the global chain is asked up front, and the costs are bounded instead: `url-not-supported` is remembered per provider and registry, and a provider that should not see a registry belongs in the per-registry form.

### Why no discovery suggestions?

A suggestion would be triggered by the registry's host, which a project can choose: a repository that points `@scope:registry=` at a lookalike host, and answers 401, would get npm to print a ready-to-paste line binding the user's own provider to that host. No prior art suggests providers either. Cargo and pnpm are explicit; Git and Docker resolve a name only once configured; NuGet runs the `nuget-plugin-*` it finds on `PATH`, which [Trust](phase-1-token-helper.md#trust) rules out, and otherwise leaves finding plugins to a search the user starts.

### Why no `refresh` request?

Revision 4 had one, carrying an opaque `refreshState` the provider handed to npm. None of the prior art passes refresh state through the client: Cargo, Git, Docker, NuGet and pnpm have no such request, and the AWS and Azure credential chains refresh inside the provider. The request also lost the scope of the token it refreshed, and made npm hold a second bearer-equivalent secret it did not need.

Since the provider process lives for the whole command, it can refresh on the next `get`; across commands it keeps refresh state in its own secure storage. Two npm commands run side by side start two providers on that storage, so:

- a provider whose refresh token rotates serializes its refresh across processes (a lock on its storage), or, losing the race, reads the stored token again before it reports the login dead;
- two prompts may be shown at once, each for its own command.

### Why no batch request?

Revision 4 had `get-batch`. The same benchmark at commit `ab3ad81` measured 31 µs per lookup in one batch against 118 µs as separate `get`s in a session: 0.09 s saved per thousand lookups. No registry today issues per-package tokens, so a real install makes one lookup per registry or scope, a handful in all; and during tree building npm discovers packages one by one, so a batch could not be formed without delaying requests.

### Why no request id or progress message?

Because npm's use of a session needs neither. A session serves one provider, the cache leaves a handful of lookups per command, and every wait of consequence is a wait on one person at one terminal, which a provider would serialize anyway; pipelining would save microseconds.

Matching an answer to a request by position also leaves nothing to forge or confuse. A timeout kills the provider, so a late answer is never read as the answer to another request, and a line sent while no request is outstanding ends the session ([Session lifecycle](#session-lifecycle)). With ids, npm would keep a session alive past a timeout and discard stale answers, a new way to cache a credential under the wrong key.

What the choice costs is the hung provider. An interactive `get` has five minutes, and npm cannot tell a provider that hangs before its prompt from a person reading one. A message saying "now prompting" would tell them apart, as NuGet's progress message extends its timeout. It is left out because the case it serves is already bounded: `interactive` is `true` only at a terminal, where a person who sees that nothing was asked presses Ctrl-C and npm kills the provider as it exits; anywhere else a `get` has 30 seconds.

### Why npm actions rather than read/write tiers?

Registries disagree on the tiers, as the table under [Operations](#4-operations) shows: npmjs.com splits stage-only from direct publish, GitHub Packages and Azure Artifacts put deletion above write. A coarse `write` would force npm to choose one mapping for every registry, and a provider minting tiered credentials would have to guess from the informational `command`. Naming the action keeps the mapping where the knowledge is, as Cargo does.

## Implementation

This section is informative: it describes one way to meet the requirements above. Where helper and provider code meet, the [Phase 1a implementation](phase-1-token-helper.md#implementation) comes first.

- **Debugging.** At `--loglevel verbose` npm logs, for each registry, the chain it resolved, each provider it asked and the kind of each answer (`Ok`, `url-not-supported`, `not-found`, an error kind), with the provider's own stderr; never a credential.

- **Shape.** As suggested in the #850 review from NuGet's experience, npm can define one internal credential-source interface with implementations for the existing config lookup (`_authToken`, `_auth`, `username`/`_password`), `tokenHelper` and the provider protocol, and later built-in `npm:` sources ([Future possibilities](#future-possibilities)).
- **Hooks the commands need.** npm-registry-fetch reports which source served a registry (a provider, a helper, `npm:token`, none), so `stage approve` and `reject` know whether to look the stage up; the context learned from a stage record travels in a credential-context option of its own, never as `spec` or `scope`, which would change routing and the `npm-scope` header; and an OIDC exchange masks the chain for its registry key with an internal option, as the Phase 1a prototype masks a helper, not with an empty provider list, which the RFC gives no meaning.
- **Operation hint.** Commands pass the npm action to `npm-registry-fetch` with the request options; installs default to `read`. The dry-run mapping follows each of `publish`, `unpublish` and `deprecate`'s own dryRun branch, not the config value. `trust`, `access list collaborators` and `access get status` pass no `spec` today, so their package reaches the provider through the credential-context option, never as `spec`, and their requests keep going to the default registry even for a scoped package whose scope names another registry, as they do today. The tab completion of `deprecate` and `unpublish` lists packages through the access endpoints under its command's operation; a provider that does not serve it only costs the suggestions.
- **Interactive requests.** npm already brackets prompts with `proc-log`'s `input.start()`/`input.end()`, which pause logging and the progress bar (`lib/utils/display.js`); an interactive provider request goes through the same bracket.
- **Config.** `@npmcli/config` gains the `credentialProvider` keys, filtered by source as the [trust rule](phase-1-token-helper.md#trust) requires. @npmcli/config leaves an untyped list unexpanded, and a per-registry key cannot be typed, so npm applies `${VAR}` expansion to each element of a per-registry `credentialProvider[]` list itself; the single-string form and the global list are already expanded.
- **Where trust is enforced.** As for helpers ([Phase 1a](phase-1-token-helper.md#implementation)), npm-registry-fetch takes no provider from the config-key namespace a caller passes.
- **Who owns the provider process.** npm/cli, not the library. It creates provider session objects from trusted config and passes them to npm-registry-fetch in a dedicated option of their own, as helpers are passed in `tokenHelpers`; npm-registry-fetch starts no provider unless handed a session, so another tool that uses it is never left with a child.
- **Session lifetime.** A session spawns its process on first use. npm ends it at the end of the command by closing stdin in its exit handler, or kills it there when a request is outstanding, so an error path ends it too, and the OS closes the pipe if npm dies. A session's child and pipes keep the event loop alive only while a request is outstanding, so an open session cannot keep npm from exiting, and npm does not exit while it awaits an answer.
- **Libraries between the commands and npm-registry-fetch.** pacote, @npmcli/arborist, libnpmaccess, libnpmpublish, libnpmteam, libnpmorg and npm-profile spread the options they receive into its calls, so the option and the operation hint pass through unchanged; a call that builds its options afresh needs them added.
- **Conformance material.** The draft ships a [JSON Schema](spec/protocol-v1.schema.json), a machine-readable [policy file](spec/policy-v1.json), [generated test vectors](tests/generated_protocol_vectors.json), an executable [Python model](tests/protocol_model.py) and a [Rust client and provider pair](poc/rust), so npm and third-party providers can be tested against the same cases.

| Setting | Where | Default | Description |
|---|---|---|---|
| `credentialProvider[]`, `//<registry>/:credentialProvider[]` | user, global | none | Phase 2: provider chain, tried in order. |

## Prior Art

### Protocol shape

| | Git | Docker | pnpm `tokenHelper` | Cargo | NuGet plugins | npm RFC #850 | This proposal |
|---|---|---|---|---|---|---|---|
| **Year** | 2012 | 2016 | 2022 | 2023 | 2018 (NuGet 4.8) | 2025 | 2026 |
| **Format** | key=value | JSON | Plain string | JSON (single-line) | JSON over stdin/stdout | JSON | Phase 1a: plain string; Phase 2: JSON (single-line) |
| **Direction** | Bidirectional | Bidirectional | Unidirectional | Bidirectional | Bidirectional (the plugin also sends requests, such as log messages) | Unidirectional | Bidirectional |
| **Request kinds** | get, store, erase | get, store, erase | get only | get, login, logout | get (Get Authentication Credentials), set credentials, operation claims | get only | get, erase, login, logout |
| **Context on input** | protocol, host, path | ServerURL | None | registry, operation, name, version | source URI, isRetry, NonInteractive, CanShowDialog | None (args only) | registry, scope, package, version, operation, command |
| **Operations** | — | — | — | read, publish, yank, unyank, owners | — | — | read, publish, stage, stage-read, stage-reject, deprecate, dist-tag, unpublish, owner, access, trust, account |
| **Versioning** | None | None | None | Hello `{"v":[1]}` | Handshake negotiates a protocol version (2.0.0 for authentication) | None | Hello `{"v":[1]}` + `v` in every message |
| **Auth type** | Implicit | Implicit | Raw token or header value | Raw token | Username/password with a list of auth types | Implicit | Explicit `bearer`/`basic` |

### Lifecycle and trust

| | Git | Docker | pnpm `tokenHelper` | Cargo | NuGet plugins | npm RFC #850 | This proposal |
|---|---|---|---|---|---|---|---|
| **Refresh** | In helper | In helper | In helper | In provider | In plugin | Re-run | In provider |
| **Cache control** | None | None | None | `never`/`session`/`expires` | None in the protocol (operation claims cached 30 days) | `expiresAt` | Cargo's three + `granularity` + `operationIndependent` |
| **Rejection signal** | `erase` | `erase` | None | Challenge headers | `isRetry` on the next request | None | `erase` + one retry with status and challenges |
| **Chaining** | Yes | No | No | Yes (`url-not-supported` and `not-found` pass; `cargo:token` is a chain entry) | Yes (plugins in priority order, asked only after a 401 or 403; not-applicable passes; credentials in `nuget.config` are sent first) | No | Yes (`url-not-supported` and `not-found` pass; `npm:token` is a chain entry) |
| **Process reuse** | No | No | pnpm 12: once per registry and scope per run, at the first request; pnpm 11: at each client setup, for every registry | Allowed by the protocol; Cargo starts one per request | Yes; shut down after 1 minute idle | One per cache miss | One per npm command |
| **Discovery** | `git-credential-*` | `docker-credential-*` | Explicit | Explicit | `~/.nuget/plugins`, `NUGET_PLUGIN_PATHS`, and since 6.13 `nuget-plugin-*` on `PATH` | Explicit | Explicit; configured names resolved in npm-managed global bin directories |
| **Production-tested** | Yes | Yes | Yes | Yes | Yes | No | No |

### NuGet

NuGet's plugins are the closest prior art to Phase 2: one long-lived process, a negotiated protocol version, plugins tried in priority order, a retry flag after a rejection, and a request that says whether the client may block for the user ([cross-platform plugins](https://learn.microsoft.com/en-us/nuget/reference/extensibility/nuget-cross-platform-plugins), [authentication plugins](https://learn.microsoft.com/en-us/nuget/reference/extensibility/nuget-cross-platform-authentication-plugin)). Phase 2 differs in three places, each for a reason particular to npm:

- **Timeouts.** NuGet times each request out after 5 seconds and lets a plugin extend that with progress messages. Phase 2 gives each request kind a fixed budget, and an interactive `get` the `login` one: a simpler client, which cannot tell a stuck provider from a slow user before the budget runs out.
- **Discovery.** NuGet finds plugins on `PATH` by name (`nuget-plugin-*`, since 6.13). npm cannot: a script npm runs puts the project's `node_modules/.bin` first on `PATH`, so a dependency could provide a provider by that name.
- **Context.** A NuGet request carries the source URI only; npm sends the package, version and operation, because npm registries scope tokens by package and by action.

### References

[Git credential helpers](https://git-scm.com/docs/gitcredentials), [Docker credential stores](https://docs.docker.com/reference/cli/docker/login/#credential-stores), [pnpm `tokenHelper`](https://pnpm.io/npmrc#urltokenhelper), [Cargo credential provider protocol](https://doc.rust-lang.org/cargo/reference/credential-provider-protocol.html), [NuGet cross-platform authentication plugins](https://learn.microsoft.com/en-us/nuget/reference/extensibility/nuget-cross-platform-authentication-plugin), [pip keyring support](https://pip.pypa.io/en/stable/topics/authentication/).

## Migration Plan

No phase changes behavior for anyone who has not configured a provider. Phase 1a ships first ([its plan](phase-1-token-helper.md#migration-plan)); Phase 1b, which hardens how every credential travels, has [its own](phase-1b-credential-hardening.md#migration-plan).

In a team on mixed npm versions, an npm that predates Phase 2 ignores `credentialProvider` and reads only what `.npmrc` stores, so a stored token that older installs still need keeps working for them; the warning that a newer npm gives for it, under a global chain, goes once the older versions are gone or the token is moved to a per-registry list that names `npm:token`.

| Phase | Release | Ships | Done when |
|---|---|---|---|
| 2: `credentialProvider` | a later minor | The protocol (`get`, `erase`, `login`, `logout`, cache control, chaining, one retry after a rejection), `npm login` and `npm logout` delegated along the chain, OIDC trusted publishing taking precedence over it, the schema and conformance vectors published | A provider written against the vectors alone works with npm |
| 3: Ecosystem | separate changes | Vendor providers, with their `login` wrappers no longer writing tokens into `.npmrc`; an evaluation of a built-in web-login source ([Future possibilities](#future-possibilities)) | A vendor provider for at least one registry passes the published conformance vectors, and its login wrapper no longer writes a token into `.npmrc` |

## Open decisions for the npm maintainers

Two decisions this document makes that the npm team may want to take differently, each to make version 1 smaller:

1. **The global chain.** We propose shipping it in version 1, so that a provider serving several registries is one line of config. Per-registry lists alone are a smaller first version, in which a provider applies only where the user names the registry ([Session lifecycle](#session-lifecycle)).
2. **The operation catalogue.** We propose twelve operations, so that a registry can scope a token to the action. `read` and `publish`, with open names for the rest, are a smaller first version ([Operations](#4-operations)).

Phase 1a has one of its own: [Phase 1a's open decisions](phase-1-token-helper.md#open-decisions-for-the-npm-maintainers).

## Future possibilities

### A built-in web-login source

`npm login` already uses a web login that does not depend on the registry: `POST /-/v1/login`, then a polled done URL. npmjs.com serves it, and so does Verdaccio behind its `webLogin` flag; on npmjs.com it yields a two-hour session token with no refresh grant. A built-in source built on it would be an `npm:` entry, outside this RFC's scope. Such a source should meet these conditions:

- it runs only where a chain lists it, and an npm that does not know the name fails closed;
- it serves only a registry the user logged into through it with an explicit `npm login`, and answers `url-not-supported` for any other from the registry URL alone, without contacting it; it starts a web login only for `login` and, when `interactive` is `true`, on the retry after the registry, asked by the source itself (`/-/whoami`), rejects a session it holds, so a project that chooses the registry cannot make an install open a login page;
- it polls a done URL only on the origin it posted to, attaches no credential to the poll, sends the token only to that registry, and never writes it into an `.npmrc`;
- it answers any operation other than `read` only after user presence, a fresh web login or the registry's own per-write 2FA, as the threat model asks: npmjs.com enforces 2FA for publishing, not for every write.

The recommended form holds the token in memory for one command: nothing is written to disk and npm needs no native dependency. Its cost is a browser login on every command that reaches the registry, since npm asks a chain before the first request and cannot tell a public read from a private one; another chain entry that serves reads, such as a read-only token, removes it. Keeping the token in the OS keychain is not recommended: it needs a native dependency npm does not have today, and once the session lapses the next command that reaches the registry, a read included, opens the browser again. A third-party provider can build either form today with no protocol change.

## Appendix A: Operations in detail

This appendix belongs to [section 4](#4-operations) and is normative.

**Account commands** send `account` even when they only read: it names the account-management surface, not a write. `token revoke` lists tokens and `profile set` reads the profile before writing, so a credential that serves `account` already serves both reads.

npmjs.com documents its token list for session tokens only, so a provider there maps `account` to a session token, which it could not do for `read` without handing one to every install.

Where a registry accepts a read-only token on these reads and answers a write with 403, as Verdaccio does, the provider may start `account` with that token and escalate when the write that follows is refused. A 403 on the read itself is no reason to, since Verdaccio also answers 403 to a token used outside its address allowlist.

**Access and trust commands** also send their operation when they only read: `access` and `trust` name a governance surface, not a write.

On npmjs.com, as documented, the reads behind `access`, `team` and `org` take session tokens only (a package's collaborators and visibility, an org's packages, members and teams, a team's packages and members), and their writes take session or granular tokens ([API](https://api-docs.npmjs.com/)). A provider there maps `access` to a session token, which it could not do for `read` without handing one to every install.

`trust` is its own operation because npmjs.com documents a different credential for its endpoint: granular tokens only, for `trust list` as for the writes, held by a user with write permission on the package and 2FA ([npm-trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/)). As documented, the session token that serves `access` does not serve `trust`; where a registry accepts one credential for both, the provider maps both operations to it.

Both credentials can write even when the command only lists, so the provider applies its write policy to every `access` and `trust` request: user presence, and only when `interactive` is `true`. On npmjs.com these listings therefore fail closed in CI, the provider answering `other` ([Non-interactive and CI behavior](#non-interactive-and-ci-behavior)).

A provider binds a `trust` credential to the package the request names, answering with `granularity` `"package"` and `operationIndependent` `false`.

Which requests carry the package:

- `trust` and the package-level `access` subcommands (`list collaborators`, `get`, `set`, `grant`, `revoke`) send `scope` and `package`;
- `team`, `org` and `access list packages` send neither.

Verdaccio, GitHub Packages and GitLab implement none of these endpoints. A registry that does, and accepts a lesser token on the reads, lets the provider start with it and escalate when a write is refused, as for `account`.

**Staged versions.** `npm stage approve` and `reject` take only a stage id, while `publish` and `stage-reject` need the package and version:

- npm first asks the chain that applies to the registry for a `stage-read` credential. If every provider declines the registry, or the credential comes from `npm:token`, listed or implicit, `approve` and `reject` send exactly what npm sends today, with no lookup.
- Otherwise npm fetches the staged record (`GET /-/stage/<id>`) with that credential, as `npm stage view` does, outside the one-time-password retry. It accepts the record only if `packageName` is a valid registry package name and `version` is valid semver, which also keeps a hostile registry's control characters out of the prompts; then it asks for the `publish` or `stage-reject` credential with `scope`, `package` and `version` from the record.
- The lookup and the write go to the registry the command already uses; the learned scope fills context fields only and never changes routing.
- Any failed lookup stops the command before a write credential is asked for: a 404, a 401 or 403 after the one retry, `operation-not-supported`, or a record without a valid name and version. A registry may answer a caller without permission with 404, as Verdaccio does; npmjs.com documents 401 and 404 as its only refusals on the record and the tarball, and documents that its list returns only items visible to the caller, so a `stage-read` mapped too low can show as a 401, a 404 or an empty `stage list`. A registry that implements approve but not the lookup fails for provider users.
- npm caches a `stage-read` answer bound to that operation, as it caches every operation other than `read` ([Caching](#5-caching)), so the write always gets a fresh `get` with the record's package and version.
- `stage-read` writes nothing. Where the registry accepts a credential that authorizes no write on the `/-/stage` reads, the provider answers with one: either a credential it does not also serve for `read`, or one whose erase, when the erase names `stage-read`, touches only that binding, since a 401 on a stage read erases the credential that served it.
- Where the registry accepts only a write-capable credential, the provider applies its write policy to `stage-read`, user presence and only when `interactive` is `true`, and answers with the least-privileged such credential it can get, never one that can publish directly or that bypasses the registry's 2FA.
- With such a registry, `stage list`, `view` and `download` fail closed in CI, and `approve` and `reject` may take up to two presence checks, the lookup's and the write's, besides npm's one-time password; only the second can name a package and version.
- On a 401 retry the provider answers `stage-read` with the same tier or fails; only a 403 retry may widen it, and only under its write policy and never past a credential that can publish directly or that bypasses the registry's 2FA, since a registry can send a 403 as cheaply as a 404. npm sends no retry on a 404 or an empty list, and a provider must not treat either as a reason to widen a later `stage-read` answer, since a registry can send either for free. This lookup is the one place where a request that writes nothing precedes a write in one command; these rules keep the guarantee above there.
- The package and version a prompt names are what that registry endpoint asserts, not something npm verified; the credential goes to the same registry key.

`npm stage list <package>` sends `scope` and `package`; `list` without one, `view` and `download` send neither. A `stage-read` request without a package cannot be bound to one: a provider's presence prompt for it names the `command`, says the lookup itself writes nothing, and, when the credential it would release can write, says that too and what it can write (on npmjs.com, staging versions and changing dist-tags and deprecations on the packages the token selects); the answer stays bound to the operation.

`stage-reject` is its own operation rather than `publish`: on npmjs.com it needs write permission and 2FA, while Verdaccio also lets the account that staged a version reject it ([staged publishing](https://verdaccio.org/docs/staged-publishing)), so the tier differs by registry and the provider maps it.

How some registries split these:

| Registry | Credential tiers relevant to npm |
|---|---|
| npmjs.com | Read-only; read and write, either publish-and-stage or stage-only; details in the notes below the table |
| GitHub Packages | `read:packages`, `write:packages`, `delete:packages` ([docs](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages)). |
| Azure Artifacts | Packaging read; read and write; read, write and manage, the last required to delete ([scopes](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/oauth)). |
| Cargo (prior art) | Operations `read`, `publish`, `yank`, `unyank`, `owners`, plus an `Unknown` fallback for forward compatibility. |

Notes on npmjs.com:

- **Tiers.** Read-only; read and write, either publish-and-stage or stage-only, which keeps dist-tag and deprecate ([changelog](https://github.blog/changelog/2026-09-18-stage-only-npm-tokens-for-safer-automation)).
- **Interactive 2FA.** Changes to tokens, package access, maintainers, trusted publishers and org or team membership need an interactive 2FA challenge even with a bypass-2FA token ([changelog](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/)), as do `npm stage approve` and `reject` ([npm-stage](https://docs.npmjs.com/cli/v12/commands/npm-stage/)).
- **What the API documents.** Its API lists granular tokens as the security of every `/-/stage` path (list, record, tarball, stage, approve, delete) without naming a tier, and documents no 403 on the three reads ([API](https://api-docs.npmjs.com/)). Short-lived trusted-publishing tokens can run `npm stage publish` but no other `npm stage` subcommand ([npm-stage](https://docs.npmjs.com/cli/v12/commands/npm-stage/)).
- **Live test.** A live test on 2026-10-17 ([stage-tiers-test.md](stage-tiers-test.md); npm 11.19.0, the account's default publishing setting, the stricter setting that disallows tokens not tried) found, for one account and one package, that a read-only token selected to the package, and stage-only, publish-and-stage and session tokens, were each answered 200 on the stage list, a staged record and its tarball (plain HTTP GETs; the `npm stage` read commands were not run with them). The test covers npm 11.19.0, one account, one package and plain HTTP GETs, and nothing wider. Within that scope a provider could answer `stage-read` with a separate read-only token and no presence check.
- **Package selection.** The record and the tarball honour the token's package selection, a read-only token selected to another package getting 404, but the list does not: it showed the staged version to that token too, filtered by the account rather than the token.

## Appendix B: Comparison with RFC #850

This proposal grew out of the RFC #850 discussion. Where the two differ beyond the rows of [Prior Art](#prior-art):

| Aspect | RFC #850 | This proposal |
|---|---|---|
| **Delivery** | One mechanism | Phase 1a pnpm-compatible `tokenHelper`, Phase 2 protocol |
| **Auth flows** | Not specified | OAuth, SSO, device code, MFA via `login` |
| **Granularity** | Per registry | Per registry, scope, or package |
| **Provider input** | No stdin, arguments only | JSON on stdin with full context |
| **Configuration source** | Project or user | User and global only |
