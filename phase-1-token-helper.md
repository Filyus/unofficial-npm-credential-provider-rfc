# RFC draft: `tokenHelper` for npm

> Status: Draft
> Revision: 29 (the combined draft, revision 28, split by phase)
> Date: 2026-10-17

> Phase 1 of an unofficial proposal building on the [npm/rfcs#850](https://github.com/npm/rfcs/pull/850) discussion: npm runs a user-configured program to get a registry credential at the moment it needs one, instead of reading a long-lived secret from `.npmrc` or the environment. Phase 2, a credential provider protocol, is [a separate document](phase-2-credential-provider.md).

## Summary

npm gains `//<registry>/:tokenHelper`, pnpm's setting of the same name: an executable at an absolute path prints a token, and npm sends it as the `Authorization` header for that registry. It is what [npm/cli#8141](https://github.com/npm/cli/issues/8141) asks for, and one helper serves both package managers. It is configured only in user-level or global npm config ([Trust](#trust)) and changes nothing for a user who has not configured it.

A helper learns nothing about the request, cannot say how long its token lives and is not told when the registry rejects it; [Phase 2](phase-2-credential-provider.md) adds a protocol for that, configured and trusted the same way.

## Motivation

### Registry credentials are standing secrets

npm registry authentication ends in a bearer secret stored in `.npmrc` (where `npm login` writes it) or passed through an environment variable. Every lifecycle script that runs during an install can read both. [RFC 0054](https://github.com/npm/rfcs/blob/f291deccbb4c0d244a8b71f321de9042626922cb/accepted/0054-make-scripts-install-opt-in.md) records what that costs: the Shai-Hulud worm (September 2025) spread by stealing maintainer tokens from compromised machines and publishing infected versions of the victims' other packages.

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
- **2026-07-31:** bypass-2FA tokens can no longer perform account-governance actions; GitHub targets January 2027 for ending their direct publishing ([GitHub Changelog](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/), [npm docs](https://docs.npmjs.com/about-access-tokens)).

npm still saves the two-hour token as `_authToken` in the user `~/.npmrc`, so even the registry's own credentials are short-lived secrets that npm can only keep by writing them to disk. And these changes cover publishing from CI; none says how a developer's machine or a build agent should hold read credentials for private registries, which is the gap this proposal fills. Since npm 12 closed install-time code execution by default, a credential helper must not reopen it, which is why [Trust](#trust) limits helpers and providers to user and global config.

### npm is behind its neighbours

pnpm ships `tokenHelper` in both its TypeScript CLI and its Rust rewrite. Cargo has a versioned credential-provider protocol, Git and Docker have had credential helpers for a decade, NuGet has cross-platform authentication plugins, and pip delegates to keyring. In npm:

- The request for the same thing, [npm/cli#8141](https://github.com/npm/cli/issues/8141), had 43 👍 and no comments on 2026-10-22, and the `Priority 1` label was added on 2026-10-01.
- A `~/.npmrc` written for pnpm's `tokenHelper` gives npm no credentials at all, and npm 12 reports the key as unknown on every command ("Unknown user config … This will stop working in the next major version of npm"), an error under `strict-npmrc`. A configuration shared with pnpm is on a path to breaking npm outright.

## Scope

In scope: how npm obtains a credential from a helper for its own HTTP requests to registries. Delegating `npm login` and `npm logout` belongs to [Phase 2](phase-2-credential-provider.md).

Out of scope:

- Credentials for lifecycle scripts. Scripts never receive provider credentials.
- Trusted publishing (OIDC) and the registry's own token model; both are unchanged.
- Git dependencies, proxies, and client certificates (`certfile`/`keyfile`).
- Protecting credentials from code that already runs as the same user: it can run a helper or provider exactly as npm does, as any process can run `git credential fill`. What changes is what it finds: no standing secret in `.npmrc` or the environment, short-lived tokens, and write credentials gated by the provider ([Threat model](phase-2-credential-provider.md#threat-model)).

## Detailed Explanation

### Trust

A helper or provider is a program npm runs, so only the user and the machine's owner may configure one. This rule covers both phases:

- `tokenHelper` and `credentialProvider` are accepted only from the user config file and the global config file.
- In a project or workspace `.npmrc`, in `publishConfig`, in `npm_config_*` environment variables and on the command line they are ignored with a warning.
- A user or global file is not the user's when a project chose it or when it lies inside a project; [Where it may be set](#where-it-may-be-set) says what that means.

### The setting

`tokenHelper` turns a helper's output into a header the way pnpm does, so a helper at an absolute path that prints a one-line token serves both package managers. The configuration is pnpm's per-registry form:

```ini
# ~/.npmrc or global npmrc only
//npm.corp.example.com/:tokenHelper=/usr/local/bin/corp-registry-token
```

| | |
|---|---|
| **Where** | User or global config, per registry ([Trust](#trust)) |
| **Value** | An absolute path, no arguments |
| **When** | Lazily, once per registry and helper per npm process |
| **Output** | One line: a raw token is sent as `Bearer <token>`, `Scheme value` as is |
| **Failure** | `ETOKENHELPER`; no fallback to another credential |
| **Precedence** | Over a stored token; OIDC trusted publishing over both |

### Where it may be set

Only in a user or global file that is the user's own. npm loads project config before the user and global files, and a project can name those files, so two things decide whether a file is the user's:

- **Who chose it.** The setting that selected the file (`userconfig`, `globalconfig`, or the `prefix` the default global file derives from) must not come from a project `.npmrc`, with one exception, below: the default files. Keys count as they are applied, after environment expansion: `user${UNSET?}config=` is `userconfig`.
- **Where it lies.** A file inside a project is the repository's, whoever named it: `npm --prefix client` makes `client/etc/npmrc` the global config file, and a CI job's `--userconfig` may point into the checkout. A project is any directory from the current one up that has a `package.json` or `node_modules`, and a command-line prefix outside a global run. Containment is decided by the filesystem's identity of directories, not by how a path is spelled. Where the filesystem gives no identity (no inode numbers: FAT, some network shares), npm compares resolved spellings instead, which an 8.3 short name or a change of case can get past.
- **The home directory is not a project.** An accidental `~/package.json` is common, so the default `~/.npmrc` and global file stay trusted even when a project names them. The accepted cost: where the home directory is the checkout itself (a PaaS with `HOME=/app`, a container whose working directory is `$HOME`), the repository's `.npmrc` is the user's file. An image that checks a repository out into its home directory should point `--userconfig` at a file outside the checkout.
- **Child processes keep the decision.** A child npm inherits the chosen paths as environment values, so npm tells it which files its parent did not trust.

Anywhere else the key is ignored with a warning. pnpm instead fails on the key in project config; npm warns and carries on, as it does for other settings it ignores.

An unscoped `tokenHelper=` in a user or global file is ignored with a warning that names the line to write instead: `//<registry>/:tokenHelper=<value>` for the `registry=` the same file sets, which is also where pnpm 11.4 pins it, so the rewritten line behaves the same in pnpm. When the file sets no `registry=`, the warning asks for the registry the helper serves, since pnpm would send this helper's token to registry.npmjs.org. npm does not rewrite the file itself: `npm config fix` repairs only what makes every command fail, and it scopes keys to the registry in effect, which a project `.npmrc` can choose.

### How the helper runs

- **Value.** An absolute path with no arguments, which may contain spaces (`C:\Program Files\…`). Anything else fails with `ETOKENHELPER`. A vendor CLI that needs arguments goes in a two-line script. `${VAR}` in the value expands, and an unescaped `#` or `;` ends it (write `\#`, as in a path under `C#`), as in any npm config value.
- **Key.** A key whose registry part does not end in `/` (`//host:tokenHelper`, as pnpm's docs show it) never matches a request, so it is ignored with a warning naming `//host/:tokenHelper`.
- **Windows.** A `.cmd` or `.bat` helper runs through `cmd.exe` (`/d /v:off /s /c`), as pnpm runs it through `cmd.exe`; a path containing `"` or `%` is refused there, since `cmd.exe` would reinterpret it. Everything else is executed directly, never through a shell. A `.ps1` script needs a `.cmd` wrapper; Windows does not start it directly.
- **Working directory.** The helper's own directory, never npm's, which is usually the repository: on Windows a command started by bare name (the `node` in a cmd-shim) is looked up in the current directory first. A `.cmd` or `.bat` helper on an SMB share starts in the Windows directory instead, since cmd.exe takes no UNC working directory; that is not the repository either. On Windows a helper whose directory path is longer than 258 characters is refused with `ETOKENHELPER`.
- **Environment.** npm's environment without what npm sets from a project's config or about itself:
  - Removed: `NODE_OPTIONS`, `npm_config_*`, `EDITOR`, `NODE_ENV`, `COLOR`, and `INIT_CWD`, `NODE`, `npm_execpath`, `npm_node_execpath`, `npm_command`. npm exports a project's config to what it starts; `node-options` alone would let a repository's `.npmrc` load code into a node-based helper and read the credential it prints.
  - `PATH` loses the directories npm put in front of it for a script: the block `@npmcli/run-script` adds (each `node_modules/.bin` from the package up to the root, then its `node-gyp-bin`, repeated by a nested run), and the `node_modules/.bin` of the working directory and its parents, which another package manager's runner adds. A `node_modules/.bin` the user put on `PATH` elsewhere stays.
  - Why: a helper script calls its tools by name, and a dependency's bin is linked into `node_modules/.bin` even when its install scripts never ran (npm 12's default, or `--ignore-scripts`). Without this, `npm run release` calling `npm publish` would hand the credential to a dependency's `aws`, code the user had declined to run.
  - What it does not do: protect the helper from a project's own script, which can set any `PATH` before it calls npm and runs as the user anyway. A helper that needs a tool only a project installs calls it by its absolute path; a helper that exits with 127, a shell's status for a command not found, is told so.
- **Input.** None: stdin is closed at once, so a helper that reads it gets end of input.
- **When.** The first time a request to that registry is about to be sent, and at most once per registry and helper per npm process, whatever the outcome. A token that expires during a long command is not fetched again: the registry's 401 is reported as for a stored token, and Phase 2's `expiresAt` and retry are what cover it. Never for a request made offline; the packument (the registry's metadata document for a package) fetch that precedes a write is made online whatever `--offline` says, and so runs the helper. It does run before a `--prefer-offline` request the HTTP cache could have answered; skipping it would need the cache consulted first, which the prototype does not do.
- **stderr.** Shown as npm warnings, cleaned in this order, so that an escape sequence a helper relays cannot rewrite the terminal:
  1. The helper's own token is removed wherever it appears: as it is, and as JSON, a shell's quotes or a URL write it.
  2. Control characters (C0 and C1 except tab) are removed, line by line.
  3. Anything that looks like a credential is masked: `Bearer …`, `Digest …` after `Authorization:`, `token=…`, `api-key=…`, `Cookie: …`, `"password": "…"`, the user and password in `https://user:pass@host`.

  Hiding is for a credential a helper echoes by accident, in the forms an accident takes. A helper that encodes its credential on purpose (base64, split over lines, cut short) is not stopped, and could not be: it is the user's own program, it holds the credential, and what it writes to the user's terminal is the user's to read. As warnings these also reach npm's debug log, whose directory a project `.npmrc` can set with `logs-dir`, as for everything npm logs.

### Output and failures

npm trims the output, including a leading byte order mark such as Windows PowerShell 5.1 writes. A raw token is sent as `Authorization: Bearer <token>`; output that starts with ASCII letters and a space (`Bearer …`, `Basic …`) is used as the header value as is.

| Condition | Result |
|---|---|
| Non-zero exit, or a spawn error | `ETOKENHELPER`; a missing `#!` interpreter is named |
| Empty output | `ETOKENHELPER` |
| Not a valid header value (a second line, a control character other than tab, or a non-ASCII character) | `ETOKENHELPER`, without quoting the output: the HTTP layer's own error would print the credential |
| More than 1 MiB on stdout, or more than 1 MiB on stderr (each is counted on its own, in bytes written) | `ETOKENHELPER`; the helper is ended |
| Running longer than 60 seconds | `ETOKENHELPER`; the helper is ended |

Every failure names the helper, and npm does not fall back to another credential for that registry. Ending a helper means SIGTERM, then SIGKILL after 2 seconds; on Windows its whole process tree goes, elsewhere only the helper process itself, so a helper script should `exec` the command that does the work (signalling a process group would mean a session of its own, without the terminal it may prompt on). A helper that exits while a background process it started still holds its stdout is read for 250 ms more and then taken at its word; the background process is not stopped.

### Which requests get the credential

- **The same ones as a stored token for that registry key:** a request whose URL falls under the key, a full URL on the registry's host (npm's fallback for tarballs), and a redirect that keeps the host name, and only over `https:` (or `http:` to a loopback address: `localhost`, `127.0.0.1`, `::1`). A redirect to another host name and a tarball on another host or port get nothing.
- **Only `https:` gets it,** unlike a stored token, whose key carries no scheme: a lockfile `resolved` URL over `http://` on the registry's host gets nothing, and the request goes out without it (`http:` to a loopback address excepted, for local registries). The helper is then not started, so a registry served over `http:` away from loopback answers 401 with nothing in the request to say why but a `verbose` log line: such a registry needs `https:`. The port is compared: a key is `//host:port/`, and a default port is no port, so `https://host:443/` is the key `//host/` and `https://host:8443/` is not. A helper's credential is new, so it can start stricter than a stored token without breaking anything.
- **Transport from the user, not the project.** A request that carries a helper's credential takes `proxy`, `https-proxy`, `noproxy`, `ca`, `cafile`, `strict-ssl` and `local-address` from the environment, the command line and the user's own files, never from a file the trust rules treat as the project's: otherwise a repository's `.npmrc` could send the fresh credential through its own proxy, or past a certificate it chose. A stored token still takes them from anywhere, as today.
- **On disk:** npm's HTTP cache leaves `Authorization` out of what it stores, unless a response names it in `Vary`; make-fetch-happen then records it in the cache index, for a helper's credential as for a stored token (make-fetch-happen 16.0.1, the version npm 12 ships: [sources.md](sources.md#external-facts)). registry.npmjs.org's `Vary` on a packument names only `accept-encoding` and `accept`, so those responses leave the credential out; no other registry was checked ([sources.md](sources.md#not-verified)). Keeping it off disk entirely would need a change to make-fetch-happen, which is not this prototype's to make ([limits of the Phase 1 checks](phase-1-implementation.md#limits)).
- **In error responses:** the helper's credential that npm sent on a request is hidden from the error npm-registry-fetch raises for the registry's non-2xx answer: its `message`, `body` (a JSON body string by string, keys included; any other as text) and `headers`. The forms are those stderr masking hides (as it is, JSON-escaped, shell-quoted, percent-encoded, both cases of the digits; the part after the scheme too), each replaced by `***`. What remains: any other credential (a stored token, a one-time password, a secret the helper fetched but did not print), hidden only in npm-issued token formats; a form outside the set (base64, hex, split, cut short); and a successful response, which is the caller's data.

### Precedence and commands

| Situation | Behaviour |
|---|---|
| A helper and a stored token for the same registry | The helper is used |
| OIDC trusted publishing in use | The OIDC token wins over both |
| `publish`, `whoami`, `access list packages` (which checks for a login through the same code) | A configured helper counts as being logged in |
| `logout` | Explains that the helper setting has to be removed, and names a stored token rather than revoking it, since revoking would send the helper's credential |
| `login` | Refuses: the token it saved would never be sent, and its requests would carry the helper's credential |
| `profile enable-2fa` | Refuses: it cannot work through a helper |

### Compared with pnpm

| | pnpm | npm (this RFC) |
|---|---|---|
| Value | Documented as an absolute path with no arguments; the parser splits on whitespace with no quoting, refusing `$`, `%`, `"`, `'` and a backtick, so it also runs a bare name from `PATH` and cannot express a path that contains a space | One absolute path, spaces allowed, no arguments |
| Unscoped `tokenHelper=` | Deprecated since 11.4: pinned at load to the `registry=` of the same file, or to registry.npmjs.org if the file names none, with a warning; to be removed in a future major ([pnpm 11.4](https://pnpm.io/blog/releases/11.4)) | Ignored with a warning naming the scoped line to write; not fatal under `strict-npmrc`; `npm config set` refuses it |
| Key without a slash before the colon (`//host:tokenHelper`, as pnpm's docs show) | Accepted; the slash is added | Ignored with a warning naming `//host/:tokenHelper` |
| `//<registry>/:@scope:tokenHelper` | Parsed (per-scope credentials, 11.7) | Ignored with a warning naming the per-registry key |
| Key in project `.npmrc` | Error | Ignored with a warning |
| Output | `trimEnd()`, then passed on | Trimmed at both ends, BOM removed, refused if not a valid header value |
| Windows `.cmd` | Through `cmd.exe` | Through `cmd.exe`; `"` and `%` refused |

The two agree on an absolute path with no spaces and no arguments that prints a one-line token. Where npm is stricter, it is for a reason particular to npm:

- **No unscoped form:** a project `.npmrc` may set `registry=`, so "the default registry" is partly chosen by the repository, and the helper's credential would follow it to another host. This is why npm 9 made an unscoped `_authToken` an error. pnpm 11.4 closes the same hole by pinning the key to the registry declared in the same file, but falls back to registry.npmjs.org when the file declares none, which sends a corporate helper's token to the public registry, and pnpm has deprecated the form. The scoped key works in both.
- **No bare names, ever:** a bare name would be looked up on a `PATH` that npm extends with the project's `node_modules/.bin` when it runs inside a script, which would let a dependency choose the helper.
- **No arguments:** pnpm documents the value as an absolute path with no arguments, so this costs no documented pnpm setup; a command that needs arguments goes in a two-line script, or in Phase 2's `credentialProvider`, whose value is an argument list.
- **No per-scope helpers:** one helper per registry is what Phase 1 offers; telling scopes apart is what Phase 2's request context is for.

### Vendor CLIs

Vendor CLIs already print what a helper needs; since a helper takes no arguments, each becomes a two-line script:

| Registry | Command printing the credential | Lifetime | Header |
|---|---|---|---|
| AWS CodeArtifact | `aws codeartifact get-authorization-token --domain D --domain-owner ACCOUNT --query authorizationToken --output text` | 12 h default, 15 min–12 h ([docs](https://docs.aws.amazon.com/codeartifact/latest/ug/tokens-authentication.html)) | Bearer |
| Google Artifact Registry | `gcloud auth print-access-token` | 60 min ([docs](https://docs.cloud.google.com/artifact-registry/docs/nodejs/authentication)) | Bearer |
| GitHub Packages | `gh auth token` (after `gh auth refresh -s read:packages`) | until revoked | Bearer |
| JFrog Artifactory | `jf atc --expiry=3600 \| jq -r .access_token` | as requested, within the platform limit | Bearer |
| Azure Artifacts | a script printing `Basic <base64(user:PAT)>` | PAT lifetime | Basic: the documented npm scheme for Azure feeds is username + PAT ([docs](https://learn.microsoft.com/en-us/azure/devops/artifacts/npm/npmrc?view=azure-devops)), which the scheme pass-through above covers |

Not every row narrows to reading. `gh auth token` prints a token that always carries `repo`, `read:org` and `gist` besides the package scope ([gh auth login](https://cli.github.com/manual/gh_auth_login)), and GitHub documents classic tokens for Packages ([npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)); `jf atc` prints a token with the rights of the user it is minted for.

For npmjs.com itself a helper helps less: the two-hour session token comes from an interactive browser login with 2FA, so a helper can keep it in the OS keychain instead of `~/.npmrc` but cannot renew it silently.

Phase 1 has no context, no cache control and no way to learn that a token was rejected; those are what Phase 2 adds.

## Rationale and Alternatives

### Why not environment variables or `${VAR}` in `.npmrc`?

They move the secret instead of removing it. An environment variable is inherited by every lifecycle script, and pnpm recently stopped expanding `${…}` in repository `.npmrc` files because a malicious repository could use it to exfiltrate CI secrets to a registry of its choosing ([pnpm docs](https://pnpm.io/npmrc)).

### Why per registry and not a protocol?

It is the right first step: compatible with pnpm, small next to the protocol, and enough for a single-registry setup. But a helper learns nothing about the request, cannot say how long its token lives, cannot be told that a token was rejected, and runs once per process. Per-scope tokens, publish-time step-up, long installs that outlive a token, and `npm login` delegation all need the protocol. Phase 1 is therefore the pnpm-compatible step, and the protocol is [Phase 2](phase-2-credential-provider.md).

## Implementation

This section is informative: it describes one way to meet the requirements above.

- **Where it plugs in.** In `npm-registry-fetch`, `regFetch()` resolves auth synchronously (`getAuth()` in `lib/auth.js`) before the asynchronous fetch starts. A helper or provider call is asynchronous, so helper- and provider-backed auth has to be resolved inside the async fetch path, which `regFetch()` already returns as a promise. pnpm's TypeScript CLI runs `tokenHelper` with `spawnSync`, which blocks the event loop while the helper runs and rules out a long-lived session.
- **Config.** `@npmcli/config` gains the per-registry `tokenHelper` key, filtered by source as [Trust](#trust) requires.
- **Where trust is enforced.** npm-registry-fetch never takes a helper or provider from the config-key namespace: tools other than npm (npm-check-updates among them) merge every `.npmrc` key they read, a project's included, into the options they pass, and until now those keys were only data. npm passes helpers in an option of their own, `tokenHelpers` (registry key to path), which @npmcli/config fills from trusted files only; a `//<registry>/:tokenHelper` key among the options does nothing, and providers will reach the library the same way. The prototype does this, with a test that the config key runs nothing.
- **Phase 1 prototype.** About 680 lines in npm-registry-fetch and 420 in npm/cli, with tests at both repositories' 100% coverage, published as [patches](poc/patches) and run by CI on macOS, Linux and Windows. [phase-1-implementation.md](phase-1-implementation.md) describes the code, the checks (end-to-end runs with a real npm, a 2048-combination config matrix, fuzzers, platform probes, every npm/cli suite) and the automated review rounds that shaped it, and maps each statement in this document to its evidence ([rule by rule](phase-1-implementation.md#rule-by-rule)); [sources.md](sources.md) holds what it says about npm, pnpm and others.

| Setting | Where | Default | Description |
|---|---|---|---|
| `//<registry>/:tokenHelper` | user, global | none | Phase 1: absolute path of a program that prints a token. |

## Prior Art

pnpm's `tokenHelper` is the model, compared row by row in [Compared with pnpm](#compared-with-pnpm). Git and Docker have run credential helpers for a decade, Cargo and NuGet have protocols; [Phase 2's Prior Art](phase-2-credential-provider.md#prior-art) compares them all.

## Migration Plan

No change for anyone who has not configured a helper.

| Phase | Release | Ships | Done when |
|---|---|---|---|
| 1: `tokenHelper` | next minor | `//<registry>/:tokenHelper` where [Trust](#trust) allows it, its output mapped to a header as pnpm does; a warning for it anywhere else and for pnpm's unscoped and per-scope forms; `publish`, `whoami` and `access list packages` counting a helper as a login, `logout` explaining it, `login` and `profile enable-2fa` refusing, OIDC winning over it | One helper serves npm and pnpm from the same `~/.npmrc` |

## Open decisions for the npm maintainers

One decision here the npm team may want to take differently: the trust rule decides where a `tokenHelper` came from by filesystem identity. It could be narrowed to the default user and global files and those named on the command line or in the environment, at the cost of `--userconfig` inside a checkout ([Where it may be set](#where-it-may-be-set)).

The protocol's own are in [Phase 2's open decisions](phase-2-credential-provider.md#open-decisions-for-the-npm-maintainers).
