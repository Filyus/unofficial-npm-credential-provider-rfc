# RFC draft: `tokenHelper` for npm (Phase 1a)

> Status: Draft
> Revision: 30 (revision 29 split into Phase 1a and [Phase 1b](phase-1b-credential-hardening.md))
> Date: 2026-10-22

> Phase 1a of an unofficial proposal building on the [npm/rfcs#850](https://github.com/npm/rfcs/pull/850) discussion: npm runs a user-configured program to get a registry credential at the moment it needs one, instead of reading a long-lived secret from `.npmrc` or the environment. [Phase 1b](phase-1b-credential-hardening.md) hardens how every credential travels, and [Phase 2](phase-2-credential-provider.md), a credential provider protocol, is a separate document.

## Summary

npm gains `//<registry>/:tokenHelper`, pnpm's setting of the same name: an executable at an absolute path prints a token, and npm sends it as the `Authorization` header for that registry. It is what [npm/cli#8141](https://github.com/npm/cli/issues/8141) asks for, and one helper serves both package managers. It is configured only in user-level or global npm config ([Trust](#trust)) and changes nothing for a user who has not configured it.

The helper's credential is treated as a stored `_authToken` is: same transport settings, same `http:` behaviour, same redirects. Phase 1a adds the key, a safe way to run the program and the trust rule. Making every credential travel more safely, a stored token's as much as a helper's, is the separate proposal [Phase 1b](phase-1b-credential-hardening.md), so a helper is not held to a stricter rule than the token it replaces.

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

pnpm ships `tokenHelper` in pnpm 12, its Rust CLI, and in pnpm 11, the TypeScript CLI it still maintains. Cargo has a versioned credential-provider protocol, Git and Docker have had credential helpers for a decade, NuGet has cross-platform authentication plugins, and pip delegates to keyring. In npm:

- The request for the same thing, [npm/cli#8141](https://github.com/npm/cli/issues/8141), had 43 👍 and no comments on 2026-10-22, and the `Priority 1` label was added on 2026-10-01.
- A `~/.npmrc` written for pnpm's `tokenHelper` gives npm no credentials at all, and npm 12 reports the key as unknown on every command ("Unknown user config … This will stop working in the next major version of npm"), an error under `strict-npmrc`. A configuration shared with pnpm is on a path to breaking npm outright.

## Scope

In scope: how npm obtains a credential from a helper for its own HTTP requests to registries. Delegating `npm login` and `npm logout` belongs to [Phase 2](phase-2-credential-provider.md).

Out of scope:

- Credentials for lifecycle scripts. Scripts never receive provider credentials.
- Trusted publishing (OIDC) and the registry's own token model; both are unchanged.
- Git dependencies and client certificates (`certfile`/`keyfile`).
- How any credential travels: which proxy and certificates a credentialed request may use, `http:`, redirects, the HTTP cache index and error responses. A helper's credential follows today's rules for a stored token; [Phase 1b](phase-1b-credential-hardening.md) hardens them for every credential.
- Protecting credentials from code that already runs as the same user: it can run a helper or provider exactly as npm does, as any process can run `git credential fill`. What changes is what it finds: no standing secret in `.npmrc` or the environment, short-lived tokens, and write credentials gated by the provider ([Threat model](phase-2-credential-provider.md#threat-model)).

## Detailed Explanation

### Trust

A helper or provider is a program npm runs, so only the user and the machine's owner may configure one. This rule covers both phases:

- `tokenHelper` and `credentialProvider` are accepted only from the user config file and the global config file.
- In a project or workspace `.npmrc`, in `publishConfig`, in `npm_config_*` environment variables and on the command line they are ignored with a warning.
- A user or global file does not count when a project's config chose it; [Where it may be set](#where-it-may-be-set) says what that means.

### The setting

`tokenHelper` turns a helper's output into a header the way pnpm does for a read request, so a helper at an absolute path that prints a one-line token serves both package managers ([the differences around the run](#compared-with-pnpm)). The configuration is pnpm's per-registry form:

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

Only in a user or global file that a project did not choose. npm loads project config before the user and global files, and a project `.npmrc` can name those files, so the rule is:

- **Honoured** only from the user config file and the global config file, and only when `userconfig`, `globalconfig` and `prefix` were not set by a project `.npmrc`. Keys are compared as npm applies them, after `${VAR}` expansion: `user${UNSET?}config=` is `userconfig`.
- **Not honoured** otherwise: the key is ignored with a warning, including every key in a file that a project's setting selected, wherever that file lies.
- **A child npm** inherits the chosen paths as environment values, so npm sets a marker that tells it which files its parent did not trust. The marker is set only when a helper is configured, so it changes nothing for anyone else.

The rule needs no knowledge of where a file lies and does not depend on how a path is spelled. Where the home directory is the checkout itself (a PaaS with `HOME=/app`), a repository's `.npmrc` is the user's file, as it is for every other user-level setting. [Phase 1b](phase-1b-credential-hardening.md#project-config-cannot-choose-the-user-or-global-file) removes a project's ability to name those files at all.

pnpm instead fails on the key in project config; npm warns and carries on, as it does for other settings it ignores.

An unscoped `tokenHelper=` in a user or global file is ignored with a warning that names the line to write instead: `//<registry>/:tokenHelper=<value>` for the `registry=` the same file sets, which is also where pnpm 12 pins it, so the rewritten line behaves the same in pnpm 12, and starts working in pnpm 11, which ignores the unscoped form. When the file sets no `registry=`, the warning asks for the registry the helper serves, since pnpm 12 would send this helper's token to registry.npmjs.org.

npm does not rewrite the file itself: `npm config fix` repairs only what makes every command fail, and it scopes keys to the registry in effect, which a project `.npmrc` can choose. `npm config set` refuses the unscoped form, and refuses to write the key into project config.

### How the helper runs

The runner lives in npm/cli, on `@npmcli/promise-spawn`; npm-registry-fetch holds no process code ([Implementation](#implementation)).

- **Value.** An absolute path with no arguments, which may contain spaces (`C:\Program Files\…`). Anything else fails with `ETOKENHELPER` and a message that says what to do ([Output and failures](#output-and-failures)). `${VAR}` in the value expands, and an unescaped `#` or `;` ends it (write `\#`, as in a path under `C#`), as in any npm config value.
- **Key.** A key whose registry part does not end in `/` (`//host:tokenHelper`, as pnpm's docs show it) never matches a request, so it is ignored with a warning naming `//host/:tokenHelper`.
- **Windows.** A `.cmd` or `.bat` helper runs through `cmd.exe`, as pnpm does, and `@npmcli/promise-spawn` does the quoting for `cmd.exe`; a path containing `"` or `%` is refused there, since `cmd.exe` would reinterpret it. Anything else is executed directly, never through a shell. A `.ps1` or `.js` file is not started by Windows directly and needs a `.cmd` wrapper.
- **Working directory.** The helper's own directory, never npm's, which is usually the repository: on Windows a command started by bare name (the `node` in a cmd-shim) is looked up in the current directory first.
- **Input.** None: stdin is closed at once, so a helper that reads it gets end of input.
- **Limits.** 1 MiB of output, and 60 seconds: `@npmcli/promise-spawn` has no timeout, so the runner owns it and sends SIGTERM at 60 seconds and SIGKILL 2 seconds later, ending the whole process tree on Windows. Elsewhere only the helper process is signalled.
- **Recursion.** npm sets a variable for the helper; an npm that the helper itself runs sees it and starts no helper, so a wrapper that calls `npm` cannot loop.

#### Environment

The helper gets npm's environment without what npm set from a project's config or about itself:

- Removed: what npm exported from its own config. That is every `npm_config_*` variable, and four others, each set only from the config key named: `NODE_OPTIONS` from `node-options`, `EDITOR` from `editor`, `NODE_ENV` (set to `production` when the resulting `omit` list holds `dev`, whether from `omit`, `only` or `production`) and `COLOR` from `color`. Where npm overwrote a value the user had in the environment it started with, the helper gets that value back; where there was none, the variable is absent. A project's `.npmrc` reaches a child this way, and `node-options` alone would let a repository load code into a node-based helper and read the credential it prints.
- Where npm does this ([npm/cli at 12.2.1](sources.md#external-facts)): `set-envs.js` writes the `npm_config_*` variables and sets `EDITOR` and `NODE_OPTIONS` from the `editor` and `node-options` config; `definitions.js` sets `NODE_ENV` while resolving `omit`, and `lib/npm.js` sets `COLOR`, both on npm's own process environment, so the runner records the user's values when npm starts.
- `PATH` loses the directories npm put in front of it for a script: each `node_modules/.bin` from the package up to the root, and the `node-gyp-bin` directory. A `node_modules/.bin` the user put on `PATH` elsewhere stays.

Why the path matters: a helper script calls its tools by name, and a dependency's bin is linked into `node_modules/.bin` even when its install scripts never ran (npm 12's default, or `--ignore-scripts`). Without this, `npm run release` calling `npm publish` would hand the credential to a dependency's `aws`, code the user had declined to run.

This does not protect the helper from a project's own script, which can set any `PATH` before it calls npm and runs as the user anyway. A helper that needs a tool only a project installs calls it by its absolute path.

#### When it runs

The first time a request to that registry is about to be sent, at most once per registry and helper per npm process, whatever the outcome. A token that expires during a long command is not fetched again: the registry's 401 is reported as for a stored token, and Phase 2's `expiresAt` and retry are what cover it.

Never for a request made offline. The packument (the registry's metadata document for a package) fetch that precedes a write is made online whatever `--offline` says, and so runs the helper. A helper also runs before a `--prefer-offline` request the HTTP cache could have answered, since npm resolves the credential before the cache is consulted. A helper therefore caches what it fetches: it is started once per npm process.

#### stderr

What the helper writes to stderr is shown as npm warnings when the helper fails and at `verbose` when it succeeds. The helper's exact token is replaced by `***` wherever it appears in a line, and control characters (C0 and C1 except tab) are removed, so that an escape sequence a helper relays cannot rewrite the terminal.

That is all the masking there is. It is for a token a helper echoes by accident. A helper that encodes its credential on purpose (base64, split over lines, cut short) is not stopped and could not be: it is the user's own program, it holds the credential, and what it writes to the user's terminal is the user's to read. Guessing at forms of a credential gives false positives (an error that says "Token expired" must stay readable) without stopping anything deliberate. As warnings these also reach npm's debug log, whose directory a project `.npmrc` can set with `logs-dir`, as for everything npm logs.

### Output and failures

npm trims the output, including a leading byte order mark such as Windows PowerShell 5.1 writes. A raw token is sent as `Authorization: Bearer <token>`; output that starts with ASCII letters and a space (`Bearer …`, `Basic …`) is used as the header value as is.

| Condition | Result |
|---|---|
| Non-zero exit, or a spawn error | `ETOKENHELPER`, carrying the `exitCode` and `signal`; a missing `#!` interpreter is named |
| Empty output | `ETOKENHELPER` |
| Not a valid header value (a second line, a control character other than tab, or a non-ASCII character) | `ETOKENHELPER`, without quoting the output: the HTTP layer's own error would print the credential |
| More than 1 MiB of output | `ETOKENHELPER`; the helper is killed |
| Running longer than 60 seconds | `ETOKENHELPER`; the helper is killed |

Every failure names the helper, and npm does not fall back to another credential for that registry. A failure is also logged as a warning with the helper's stderr. Killing a helper on POSIX signals the helper process only, so a helper script should `exec` the command that does the work.

A message that can be acted on says how:

| Cause | The message says |
|---|---|
| The value has arguments | Put the command in a two-line script and give its path |
| The value is a bare name | Give the absolute path |
| On Windows, a `.ps1` or `.js` file | Use a `.cmd` wrapper that starts it |
| Exit status 127, a shell's "command not found" | The helper could not find a tool it calls; use its absolute path |

### Which requests get the credential

A helper's credential is treated as a stored `_authToken` for the same registry key:

- **Which URLs.** A request whose URL falls under the key, and a full URL on the registry's host (npm's fallback for tarballs), get it; a tarball on another host or port does not. The key carries no scheme, so a lockfile `resolved` URL over `http:` on the registry's host gets the credential as it would get a stored token. The port is part of the key: `//host:8443/` is not `//host/`, and a default port is no port.
- **Redirects** are followed as make-fetch-happen follows them for a stored token.
- **Transport.** `proxy`, `https-proxy`, `noproxy`, `ca`, `cafile`, `strict-ssl` and `local-address` come from wherever npm reads them today, a project `.npmrc` included.
- **On disk and in errors.** The HTTP cache and error responses behave as they do for a stored token ([sources.md](sources.md#external-facts) records make-fetch-happen's `Vary` handling).

| Limit | Reason | Widens when |
|---|---|---|
| A project `.npmrc` can choose the proxy and certificates a helper's credential goes through, and a registry served over `http:` receives it in the clear | Both are today's rules for a stored token; a helper held to a stricter rule than the token it replaces would make the helper the only credential that cannot reach an `http:` registry, and would settle for one credential a question that belongs to all of them | [Phase 1b](phase-1b-credential-hardening.md) applies one rule to every credential: `https:` or loopback only, transport from config a project cannot write |

### Precedence and commands

| Situation | Behaviour |
|---|---|
| A helper and a stored token for the same registry | The helper is used; npm warns once per registry, naming the `_authToken` it ignores |
| OIDC trusted publishing in use | The OIDC token wins over both |
| `publish`, `whoami`, `get-identity` (which `access list packages` also uses to check for a login) | A configured helper counts as being logged in |
| `logout` | Says why it cannot act: the helper setting has to be removed, and a stored token is named, not revoked, since revoking would send the helper's credential |
| `login` | Refuses: the token it saved would never be sent, and its requests would carry the helper's credential |
| `profile enable-2fa` | Says why it cannot work through a helper |
| `config set` | Refuses the key in project config and the unscoped form |

Warnings for the unscoped, slash-less and per-scope forms name the line to write instead.

### Compared with pnpm

pnpm 12, the latest release, is a Rust CLI; the TypeScript CLI is pnpm 11, which pnpm still maintains. The table names the one it means where they differ, and [sources.md](sources.md#external-facts) has the source line and the local run behind each cell.

| | pnpm | npm (this RFC) |
|---|---|---|
| Value | Documented as an absolute path with no arguments; the parser splits on whitespace with no quoting, refusing `$`, `%`, `"`, `'` and a backtick, so it also runs a bare name from `PATH` and cannot express a path that contains a space | One absolute path, spaces allowed, no arguments |
| Unscoped `tokenHelper=` | pnpm 12 pins it at load to the `registry=` of the same file, or to registry.npmjs.org if the file names none, with a deprecation warning ([pnpm 11.4](https://pnpm.io/blog/releases/11.4)); pnpm 11 ignores it without a warning | Ignored with a warning naming the scoped line to write; not fatal under `strict-npmrc`; `npm config set` refuses it |
| Key without a slash before the colon (`//host:tokenHelper`, as pnpm's docs show) | Accepted by both; the slash is added | Ignored with a warning naming `//host/:tokenHelper` |
| `//<registry>/:@scope:tokenHelper` | Parsed by both: the helper serves that scope's packages (the docs show the form for `_authToken` only) | Ignored with a warning naming the per-registry key |
| Key in project `.npmrc` | Error in both, unless the user's file has the same value; the environment form is dropped | Ignored with a warning |
| Output | Install: `trimEnd()`, then a leading scheme (`Bearer …`, `Basic …`) is kept and anything else gets `Bearer`. Publish: pnpm 11 trims both ends, strips `Bearer` and always sends `Bearer`, so `Basic …` goes out as `Bearer Basic …`; pnpm 12 maps as for install | Trimmed at both ends, BOM removed, refused if not a valid header value; the same mapping on every request |
| Windows `.cmd` | Through `cmd.exe` in all three paths: pnpm 11 install (Node's `shell` option), pnpm 11 publish (execa), pnpm 12 (`cmd /C`) | Through `cmd.exe`; `"` and `%` refused. pnpm's parser refuses them in every value |
| Directory, environment, stdin | The directory pnpm runs in (the project's) and its whole environment; stdin closed | The helper's own directory; the environment without `npm_config_*` and the script `PATH` entries; stdin closed |
| Time limit | 60 s, then the helper is killed, in pnpm 12 and in pnpm 11 install; pnpm 11 publish has none | 60 s, then the helper is killed; the whole process tree on Windows |
| Output size and stderr | No limit set by pnpm (pnpm 12 reads to the end); stderr is dropped, except in pnpm 11 publish, which shows it as warnings | 1 MiB, then `ETOKENHELPER`; stderr shown as warnings with the exact token masked when the helper fails, at `verbose` when it succeeds |
| When it runs | pnpm 12: at the first matching request, once per registry and scope key per process. pnpm 11 install: when the client is set up, for every registry with a helper, and again at each setup. pnpm 11 publish: at each publish | At the first request to that registry, once per registry and helper per process; a failure is cached too |
| When it fails | pnpm 11: an error, before any request. pnpm 12: logged, and the request goes out without `Authorization` | `ETOKENHELPER`, and no fallback to another credential |
| Helper and `_authToken` for one registry | The helper wins; in pnpm 11 `publish` the `_authToken` wins and the helper does not run. OIDC wins over both in `publish` | The helper wins, with one warning per registry naming the ignored `_authToken`; OIDC wins over both |
| `publish` | Runs the helper since 8.14.1 ([issue 7316](https://github.com/pnpm/pnpm/issues/7316)); pnpm 11 has a path of its own for it | Runs the helper, and counts it as being logged in |
| Registry on `http:`, or on another port | Both send the credential: the lookup key drops the scheme, and pnpm 11 falls back to the key without the port, so `//host/`'s credential also goes to `host:8080` | Sends it over `http:` as a stored `_authToken` is sent; the port is part of the key, as npm's `//host[:port]/` keys have always been, so `//host/`'s credential does not go to `host:8080`. [Phase 1b](phase-1b-credential-hardening.md) tightens both for every credential |

The two agree on an absolute path with no spaces and no arguments that prints a one-line token, for what a request carries; around the run they differ, as the rows say. Where npm is stricter, it is for a reason particular to npm:

- **No unscoped form:** a project `.npmrc` may set `registry=`, so "the default registry" is partly chosen by the repository, and the helper's credential would follow it to another host. This is why npm 9 made an unscoped `_authToken` an error. pnpm 12 closes the same hole by pinning the key to the registry declared in the same file, but falls back to registry.npmjs.org when the file declares none, which sends a corporate helper's token to the public registry, and pnpm has deprecated the form; pnpm 11 ignores it. The scoped key works in all of them.
- **No bare names, ever:** a bare name would be looked up on a `PATH` that npm extends with the project's `node_modules/.bin` when it runs inside a script, which would let a dependency choose the helper.
- **No arguments:** pnpm documents the value as an absolute path with no arguments, so this costs no documented pnpm setup; a command that needs arguments goes in a two-line script, or in Phase 2's `credentialProvider`, whose value is an argument list.
- **No per-scope helpers:** one helper per registry is what Phase 1a offers; telling scopes apart is what Phase 2's request context is for.
- **A failure ends the request:** npm stops with the helper named, as pnpm 11 does. pnpm 12 sends the request without the credential, so a registry that serves public packages to anyone answers as if no login existed, and a private one answers 401 or 404 with nothing to say why.
- **The helper's own directory and environment:** pnpm gives the helper the project directory and everything in its environment. For npm, which exports a project's config to what it starts, that would let a repository's `.npmrc` reach the helper through `NODE_OPTIONS` or `PATH` ([How the helper runs](#how-the-helper-runs)).

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

Phase 1a has no context, no cache control and no way to learn that a token was rejected; those are what Phase 2 adds.

## Rationale and Alternatives

### Why not environment variables or `${VAR}` in `.npmrc`?

They move the secret instead of removing it. An environment variable is inherited by every lifecycle script, and pnpm recently stopped expanding `${…}` in repository `.npmrc` files because a malicious repository could use it to exfiltrate CI secrets to a registry of its choosing ([pnpm docs](https://pnpm.io/npmrc)).

### Why per registry and not a protocol?

It is the right first step: compatible with pnpm, small next to the protocol, and enough for a single-registry setup. But a helper learns nothing about the request, cannot say how long its token lives, cannot be told that a token was rejected, and runs once per process. Per-scope tokens, publish-time step-up, long installs that outlive a token, and `npm login` delegation all need the protocol. Phase 1a is therefore the pnpm-compatible step, and the protocol is [Phase 2](phase-2-credential-provider.md).

## Implementation

This section is informative: it describes one way to meet the requirements above.

- **Where it plugs in.** In `npm-registry-fetch`, `regFetch()` resolves auth synchronously (`getAuth()` in `lib/auth.js`) before the asynchronous fetch starts. A helper call is asynchronous, so a helper-backed credential has to be resolved inside the async fetch path, which `regFetch()` already returns as a promise. pnpm's TypeScript CLI runs `tokenHelper` with `spawnSync`, which blocks the event loop while the helper runs and rules out a long-lived session.
- **The seam in npm-registry-fetch.** A new option, proposed as `opts.getAuthorization(regKey)`: async, it returns a header value or nothing. The library keeps matching a request to a registry key where it does today (`lib/auth.js`), calls the function for that key when no OIDC token is in effect, and sends what it returns. It has no process code, so another tool that uses the library is never left with a child, and never runs a program because a config key says so.
- **The runner in npm/cli.** A module in `lib/utils` on `@npmcli/promise-spawn` implements [How the helper runs](#how-the-helper-runs): the checks on the value, the directory, environment and `PATH`, the recursion guard, the time and size limits, the mapping of output to a header, the masking of stderr and the error messages. It keeps one promise per registry per process, and npm passes it to the library as `getAuthorization`.
- **Config.** `@npmcli/config` gains the per-registry `tokenHelper` key, filtered by source as [Trust](#trust) requires. The key is read from trusted files only, and a `//<registry>/:tokenHelper` key among the options a caller passes to the library does nothing: tools other than npm (npm-check-updates among them) merge every `.npmrc` key they read, a project's included, into those options.
- **Commands.** `publish`, `whoami` and `get-identity` count a helper as a login; `logout` and `profile enable-2fa` say why they cannot act; `config set` refuses the key in project config. The OIDC exchange in `oidc.js` is changed as little as makes it win over a helper.
- **Prototype.** [phase-1-implementation.md](phase-1-implementation.md) describes the earlier, hardened prototype, the checks it went through and what each statement in this document maps to. The prototype is being reworked to this split; its checks carry over where they cover the runner and the trust rule, and [sources.md](sources.md) holds what it says about npm, pnpm and others.

| Setting | Where | Default | Description |
|---|---|---|---|
| `//<registry>/:tokenHelper` | user, global | none | Phase 1a: absolute path of a program that prints a token. |

## Prior Art

pnpm's `tokenHelper` is the model, compared row by row in [Compared with pnpm](#compared-with-pnpm). Git and Docker have run credential helpers for a decade, Cargo and NuGet have protocols; [Phase 2's Prior Art](phase-2-credential-provider.md#prior-art) compares them all.

## Migration Plan

No change for anyone who has not configured a helper.

| Phase | Release | Ships | Done when |
|---|---|---|---|
| 1a: `tokenHelper` | next minor | `//<registry>/:tokenHelper` where [Trust](#trust) allows it, its output mapped to a header as pnpm does; a warning for it anywhere else and for pnpm's unscoped and per-scope forms; `publish`, `whoami` and `get-identity` counting a helper as a login, `logout` explaining it, `login` and `profile enable-2fa` refusing, OIDC winning over it | One helper serves npm and pnpm from the same `~/.npmrc` |

[Phase 1b](phase-1b-credential-hardening.md) is a separate proposal with its own migration plan: it changes how every credential travels, behind an opt-in setting in a minor release and by default in the next major. Phase 1a does not wait for it, and the helper needs no change when it lands.

## Open decisions for the npm maintainers

Phase 1a has none open. The trust rule is decided ([Where it may be set](#where-it-may-be-set)), and so is the rest of the behaviour above. What the maintainers are asked to confirm in a design note is naming only: the option `opts.getAuthorization` and the environment variable that guards recursion, either of which can change without changing a rule.

The protocol's own are in [Phase 2's open decisions](phase-2-credential-provider.md#open-decisions-for-the-npm-maintainers).
