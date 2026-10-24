# RFC draft: `tokenHelper` for npm (Phase 1a)

> Status: Draft
> Revision: 34 (revision 29 split into Phase 1a and [Phase 1b](phase-1b-credential-hardening.md); revision 34 follows the fourth round of review, two security councils on the rebuilt prototype)
> Date: 2026-10-23

> Phase 1a of an unofficial proposal building on the [npm/rfcs#850](https://github.com/npm/rfcs/pull/850) discussion: npm runs a user-configured program to get a registry credential at the moment it needs one, instead of reading a long-lived secret from `.npmrc` or the environment. [Phase 1b](phase-1b-credential-hardening.md) hardens how every credential travels, and [Phase 2](phase-2-credential-provider.md), a credential provider protocol, is a separate document.

## Summary

npm gains `//<registry>/:tokenHelper`, pnpm's setting of the same name: an executable at an absolute path prints a token, and npm sends it as the `Authorization` header for that registry. It is what [npm/cli#8141](https://github.com/npm/cli/issues/8141) asks for, and one helper serves both package managers where it prints a Bearer token for an `https:` registry and its path has no spaces, `$`, `%` or quotes. It is configured only in user-level or global npm config ([Trust](#trust)) and changes nothing for a user who has not configured it.

A helper's credential is looked up like a stored `_authToken` for the same registry key, but it is not the same thing, and Phase 1a does not pretend it is. A helper mints a fresh token on demand, often a broad one (`gh auth token` carries `repo`), where a stored token is a file's one value that the user has already accepted leaving on disk. So the route of a helper's credential is stricter than a stored token's:

- It is not sent over plain `http:` except to this machine (`localhost`, `127.0.0.0/8`, `[::1]`), and not over a route a project's config chose: `ca`, `cafile` or `strict-ssl=false`, and, for an `http:` request, `proxy` or `https-proxy`. The helper is not run, and the request fails with `ETOKENHELPER`.
- It fails closed, before the HTTP cache: a failing helper, or one refused for those reasons, fails the request even when the cache could have answered it. The route is checked for every request and a refusal is never cached; a helper's own failure is kept for the process, like its success.
- A credential for this run, on the command line or in the environment (and the OIDC token of a trusted publish), is used instead of the helper; one stored in a file is not.

What Phase 1a does not do is change how any credential, a stored token's as much as a helper's, travels once it is sent: redirects, the HTTP cache index, error responses, the rules for stored tokens. That is the separate proposal [Phase 1b](phase-1b-credential-hardening.md), and [the Limit rows](#which-requests-get-the-credential) say which differences remain until it lands.

A helper learns nothing about the request, cannot say how long its token lives and is not told when the registry rejects it; [Phase 2](phase-2-credential-provider.md) adds a protocol for that, configured and trusted the same way.

## What this protects against, and what it does not

**It protects against three things.**

1. **A repository's config, with no repository code running.** A project `.npmrc`, `publishConfig`, a lockfile URL or a `registry=` line cannot choose a helper, serve a project-written credential through one, or choose the route a helper's credential takes. This holds for commands that run no repository code: `npm view`, `npm publish --ignore-scripts`, `npm install` and `npm ci` with `--ignore-scripts`. A bare `npm install` runs the root project's lifecycle scripts and its `.npm-extension.mjs`, and a project `.npmrc` can opt into `allow-git` and `allow-scripts` and name the `git=` program. That is code the repository chose, running as the user: the next paragraph applies to it.
2. **Leaks and theft that are not live code execution.** A token copied from a log, a backup, a disk image, a laptop's `.npmrc` or a CI cache is useless once it expires, and a helper over a short-lived source makes that the common case. No token is written to `.npmrc`, the environment or `npm_config_*`.
3. **Scrapers that look only for npm's own token files** (`.npmrc`, `NPM_TOKEN`): the vendor's store is elsewhere and in another format.

**It does not protect against code already running as the user or in the CI job.** A dependency's install script, a compromised build step or a repository's own code in a command that runs it can:

- run the helper itself, as npm does;
- read the vendor CLI's own store (the `gh`, `gcloud`, `aws` or `az` config and token caches), which holds what the helper prints;
- read an OS keychain item that the helper's script reads. Other processes of the same user can read a keychain on Linux and Windows, and on macOS an item that a `node` binary created, since any script run by that binary is the application that created it.

The trust rule ([Trust](#trust)) and the location rule ([Where it may be set](#where-it-may-be-set)) are therefore repository isolation: they keep what a repository wrote from choosing a helper or its route. They are not protection from a compromised account, and no rule here is meant to be.

**In CI** the credential is usually ambient, and a helper over it adds a short-lived token and a check of where npm sends it, nothing against code in the job. [Phase 2's CI section](phase-2-credential-provider.md#in-ci) says what protects there.

## Motivation

### Registry credentials are standing secrets

npm registry authentication ends in a bearer secret stored in `.npmrc` (where `npm login` writes it) or passed through an environment variable. Every lifecycle script that runs during an install can read both. [RFC 0054](https://github.com/npm/rfcs/blob/f291deccbb4c0d244a8b71f321de9042626922cb/accepted/0054-make-scripts-install-opt-in.md) records what that costs: the Shai-Hulud worm (September 2025) spread by stealing maintainer tokens from compromised machines and publishing infected versions of the victims' other packages. A helper does not stop a worm that also reads cloud and GitHub credentials, or one that runs the helper: on a developer machine the gain is against npm-specific scrapers and leaks ([What this protects against](#what-this-protects-against-and-what-it-does-not)); on ephemeral CI it is a short-lived token in place of a standing one.

### Registries already issue short-lived tokens, and npm cannot ask for them

The registries companies run next to npmjs.com already hand out short-lived credentials, and users already trust the tools that fetch them. What npm lacks is a way to ask: each tool writes the credential somewhere npm will read, to be renewed by hand.

| Registry | Token lifetime | How the token reaches npm today |
|---|---|---|
| AWS CodeArtifact | 12 h by default, 15 min to 12 h | `aws codeartifact login --tool npm` writes it into npm's config ([docs](https://docs.aws.amazon.com/codeartifact/latest/ug/tokens-authentication.html)) |
| Google Artifact Registry | 60 min | written into `.npmrc`, and "if your access token has expired, you must generate a new access token" ([docs](https://docs.cloud.google.com/artifact-registry/docs/nodejs/authentication)) |
| Azure Artifacts | the PAT's lifetime | `vsts-npm-auth` writes a personal access token into the user `.npmrc` ([docs](https://learn.microsoft.com/en-us/azure/devops/artifacts/npm/npmrc?view=azure-devops)) |
| GitLab Artifact Registry (a product of its own, not GitLab's npm package registry) | 15 min by default, 12 h at most | `glab artifact-registry login --npm` writes an `_authToken` into `~/.npmrc`, to be run again before it expires; for Docker the same command registers glab as a credential helper that fetches a fresh token on every pull. GitLab's page calls the command an experiment that is not ready for production use ([docs](https://docs.gitlab.com/cli/artifact-registry/login/)) |

What this proposal removes is the step that turns a short-lived credential into a file on disk.

### npmjs.com itself is moving to short-lived, action-scoped tokens

- **2025-09-29:** new write-enabled granular tokens default to 7 days ([GitHub Changelog](https://github.blog/changelog/2025-09-29-strengthening-npm-security-important-changes-to-authentication-and-token-management/)).
- **2025-11-05:** all granular write tokens are capped at 90 days ([GitHub Changelog](https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes/)).
- **2025-12-09:** `npm login` issues "a two-hour session token instead of long-lived tokens", and classic tokens are revoked ([GitHub Changelog](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/)).
- **2026-07-08:** npm 12 makes install scripts, git dependencies and remote tarball URLs opt-in, and points automation to trusted publishing (OIDC) or staged publishing with human approval ([npm v12 announcement](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)). Stage-only granular tokens can stage a version for a maintainer to approve with 2FA, but cannot publish.
- **2026-07-31:** bypass-2FA tokens can no longer perform account-governance actions; GitHub targets January 2027 for ending their direct publishing ([GitHub Changelog](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/), [npm docs](https://docs.npmjs.com/about-access-tokens)).

npm still saves the two-hour token as `_authToken` in the user `~/.npmrc`, so even the registry's own credentials are short-lived secrets that npm can only keep by writing them to disk. And these changes cover publishing from CI; none says how a developer's machine or a build agent should hold read credentials for private registries, which is the gap this proposal fills.

npm 12's default closes install-time code execution for dependencies' install scripts. A repository can still run code through its own scripts, or opt itself into git dependencies with `git=`, so the rule that only the user may name a helper does not rest on npm 12 having closed everything. It is worth having because `npm view` and `--ignore-scripts` runs execute none of that, and a helper a repository could name would run there ([Trust](#trust)). The obvious question is why `git=` and `script-shell` may come from a project and `tokenHelper` may not. Git runs only for git dependencies, which npm 12 makes opt-in; a helper runs on every network command, and its output is a credential.

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
- How any credential travels once it is sent: redirects, the HTTP cache index, error responses, and the rules for a stored token's proxy, certificates and `http:`. Phase 1a refuses a few routes for a helper's credential ([Which requests get the credential](#which-requests-get-the-credential)); [Phase 1b](phase-1b-credential-hardening.md) hardens all of it for every credential.
- Protecting credentials from code that already runs as the same user: it can run a helper or provider exactly as npm does, as any process can run `git credential fill`. What changes is what it finds: no standing secret in `.npmrc` or the environment, short-lived tokens, and write credentials gated by the provider ([Threat model](phase-2-credential-provider.md#threat-model)).

## Detailed Explanation

### Trust

A helper or provider is a program npm runs, so only the user and the machine's owner may configure one. This rule covers both phases:

- `tokenHelper` and `credentialProvider` are accepted only from the user config file and the global config file.
- In a project or workspace `.npmrc`, in `publishConfig`, in `npm_config_*` environment variables and on the command line they are ignored with a warning.
- A user or global file does not count when the repository chose it, or when the command line or the environment put it inside the project; [Where it may be set](#where-it-may-be-set) says what that means.

### The setting

`tokenHelper` turns a helper's output into a header the way pnpm does for a read request, so a helper at an absolute path that prints a one-line token serves both package managers, within the limits of [the comparison](#compared-with-pnpm): a Bearer token, an `https:` registry, a path without spaces, `$`, `%` or quotes. Phase 2 and pnpm do not mix for one registry. The configuration is pnpm's per-registry form:

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
| **Precedence** | Over a token stored in a file; a credential for this run (command line, environment, an OIDC token) over the helper |
| **Route** | Not over plain `http:` except to this machine, not over a CA or `strict-ssl=false` a project chose, nor a proxy it chose for an `http:` request; refused before the helper runs |

### Where it may be set

Only in a user or global file that the repository did not choose. npm loads project config before the user and global files, and a project `.npmrc` can name those files; the command line and the environment can name them too, and a job that sets them is not always the user (`npm ci --prefix sub` makes `sub/etc/npmrc` the global file, a CI job writes `NPM_CONFIG_USERCONFIG=$CI_PROJECT_DIR/.npmrc`, and a repository can carry either file, with a helper whose value may use `${VAR}`). So the rule is:

- **Honoured** only from the user config file and the global config file, and only when a project `.npmrc` did not choose that file: the user file is not honoured when the project sets `userconfig`, and the global file is not honoured when it sets `globalconfig` or `prefix` (the global file's default path derives from `prefix`; the user file's does not). A project `prefix=` leaves the user file, and the settings in it, alone. Keys are compared as npm applies them, after `${VAR}` expansion: `user${UNSET?}config=` is `userconfig`.
- **Not honoured** when the file's path was chosen on the command line or in the environment (`--userconfig`, `--globalconfig`, `--prefix`, `NPM_CONFIG_USERCONFIG`, `NPM_CONFIG_GLOBALCONFIG`, `NPM_CONFIG_PREFIX`, `PREFIX`) and the file lies in a project. Where the project is comes from the file alone: npm takes the file's real path (`fs.realpathSync.native`, so a link or a spelling does not hide it) and looks at the directory the file is in and each one above it. A directory that holds a `package.json` or a `.git` (a directory, or the file a worktree or a submodule has) is a project. `node_modules` is not a mark: a global prefix on Windows holds one.
- **Where the walk ends.** At the real home directory, which is never looked at: the user's own files are in it or below it (`~/.npmrc.work`, `$XDG_CONFIG_HOME/npm/npmrc`), and a stray `package.json` in home must not make them a project's. A file that is not below home is walked up to the filesystem root, which is looked at. A home that is itself a filesystem root, or does not exist, stops nothing.
- **What plays no part.** The current directory, `--prefix`, `--global`, `location` and `localPrefix`, which a project `.npmrc` can set or a command line can change. A repository root that holds only a `.git`, a nested package no `workspaces` field names, `npm -g --prefix` into a repository from anywhere, and `location=global` in the project are all decided by where the file lies.
- **A default path** is never refused by this: a home directory that is the checkout (a PaaS with `HOME=/app`) makes the default user file the repository's own `.npmrc`, which is not a chosen path. A path in the environment that equals the default one is the same: a parent npm exports the prefix, the global file and the user file it computed to every npm it starts, and a default prefix can lie inside a git checkout (nvm, Homebrew on Apple silicon) or `~/.npmrc` be a link into a dotfiles repository.
- **Otherwise not honoured:** the key is ignored with a warning that names the directory that made the file a project and the mark in it, and the remedy (use the default path, `~/.npmrc`, for the file, or move the `tokenHelper` line into the default user file). That includes every key in a file that a project's setting selected, wherever that file lies.
- **A child npm** inherits the chosen paths as environment values and applies the rule itself. A child that stays in the project reads the same project `.npmrc`, and a file chosen inside the repository is refused from the file alone. A child that leaves the project (the install of a git dependency runs in the clone) sees a path that no `.npmrc` names and no mark surrounds. So the parent lists the user and global files it refused that hold a `tokenHelper` key in `npm_config_token_helper_untrusted`, and a child distrusts them whatever path its environment gives, and passes the list on. Nothing is set without a helper key. The route keys have a marker of their own, below.

The rule needs no inode comparison and no current directory. What remains are limits, with their reasons in [the implementation notes](phase-1a-implementation.md#limits):

- A `HOME` that is the checkout. Every tool trusts `HOME` (git runs the programs `~/.gitconfig` names), so npm cannot draw a line there.
- Two paths to one directory that a real path does not join: a Linux bind mount, a Windows administrative share (`\\localhost\C$`) of a local drive, a case-insensitive mount on Linux. The walk follows the path it is given, so a mount of a subdirectory hides the marks above its mount point, and a home reached under another spelling is not recognised as home (a false refusal). Comparing directories by device and inode, as the hardened branch did, stays retired.
- A file chosen inside a git-managed dotfiles directory below home (`~/.config` with a `.git`) is refused, which is a refusal that should not have happened; the message gives the remedy.

[Phase 1b](phase-1b-credential-hardening.md#project-config-cannot-choose-the-user-or-global-file) stops a project `.npmrc` from naming the user or global file at all, which does not touch a file chosen on the command line or in the environment: that is this rule's, and 1b leaves it here.

pnpm instead fails on the key in project config; npm warns and carries on, as it does for other settings it ignores.

An unscoped `tokenHelper=` in a user or global file is ignored with a warning that names the line to write instead: `//<registry>/:tokenHelper=<value>` for the `registry=` the same file sets, which is also where pnpm 12 pins it, so the rewritten line behaves the same in pnpm 12, and starts working in pnpm 11, which ignores the unscoped form. When the file sets no `registry=`, the warning asks for the registry the helper serves, since pnpm 12 would send this helper's token to registry.npmjs.org.

npm does not rewrite the file itself: `npm config fix` repairs only what makes every command fail, and it scopes keys to the registry in effect, which a project `.npmrc` can choose.

### How the helper runs

The runner lives in npm/cli, on `@npmcli/promise-spawn`; npm-registry-fetch holds no process code ([Implementation](#implementation)).

- **Value.** An absolute path with no arguments, which may contain spaces (`C:\Program Files\…`). Anything else fails with `ETOKENHELPER` and a message that says what to do ([Output and failures](#output-and-failures)). `${VAR}` in the value expands, and an unescaped `#` or `;` ends it (write `\#`, as in a path under `C#`), as in any npm config value.
- **Key.** A key whose registry part does not end in `/` (`//host:tokenHelper`, as pnpm's docs show it) never matches a request, so it is ignored with a warning naming `//host/:tokenHelper`.
- **Windows.** A `.cmd` or `.bat` helper runs through `cmd.exe`, as pnpm does, and `@npmcli/promise-spawn` does the quoting for `cmd.exe`; a helper in a directory whose path is longer than 258 characters is refused there, since `cmd.exe` cannot start a program in it. The path is the user's own, so a `"`, `%` or `!` in it, which `cmd.exe` would reinterpret, is not looked at ([retired](poc/retired/README.md)). Anything else is executed directly, never through a shell. A `.ps1` or `.js` file is not started by Windows directly and needs a `.cmd` wrapper.
- **Working directory.** The helper's own directory, never npm's, which is usually the repository: on Windows a command started by bare name (the `node` in a cmd-shim) is looked up in the current directory first.
- **Input.** None: stdin is closed at once, so a helper that reads it gets end of input.
- **Limits.** 1 MiB on each of stdout and stderr, and 60 seconds: `@npmcli/promise-spawn` has no timeout, so the runner owns it and sends SIGTERM at 60 seconds and SIGKILL 2 seconds later, ending the whole process tree on Windows. Elsewhere only the helper process is signalled. After the helper exits, npm reads its output for at most 250 ms more and then stops waiting, so a background process it left holding stdout does not keep npm waiting until the deadline.
- **Recursion.** npm sets `NPM_INTERNAL_TOKEN_HELPER_RUNNING` for the helper. An npm that the helper itself runs, and that would run a helper, finds it and fails with `ETOKENHELPER` ("a token helper's own npm cannot run a token helper"), so a wrapper that calls `npm` cannot loop, and cannot hide that it tried. The name is long and specific on purpose: `NPM_TOKEN_HELPER` or `TOKEN_HELPER` is a name a user or a CI job could have set for their own reasons, and a guard that fails would then break every command with a helper configured. An npm that needs no helper (another registry, none configured) is unaffected.

#### Environment

The helper gets npm's environment without what npm set from a project's config or about itself:

- Removed: every `npm_config_*` variable, and `NODE_OPTIONS`, which npm sets from `node-options`. Where npm overwrote a value the user had in the environment it started with, the helper gets that value back; where there was none, the variable is absent. A project's `.npmrc` reaches a child this way, and `node-options` alone would let a repository load code into a node-based helper and read the credential it prints.
- An npm that a script started (a script that runs `npm publish`) finds `NODE_OPTIONS` already set by its parent, and a value equal to `npm_config_node_options` is npm's too, absent for the helper. A value the user had set to the same thing is lost to this, because the two cannot be told apart; the helper then gets none.
- Not removed: `EDITOR`, `NODE_ENV` and `COLOR`. npm sets them from the `editor`, `omit` and `color` config, and a helper gets them as its npm has them. None of the three carries code or a credential into a helper, and recognising what a parent had set by looking at its `npm_config_*` values lost the user's own values.
- Where npm does this ([npm/cli at 12.2.1](sources.md#external-facts)): `set-envs.js` writes the `npm_config_*` variables and sets `EDITOR` and `NODE_OPTIONS` from the `editor` and `node-options` config, so the runner records the user's `NODE_OPTIONS` when npm starts.
- `PATH` loses the directories npm put in front of it for a script: each `node_modules/.bin` from the package up to the root, and the `node-gyp-bin` directory. A `node_modules/.bin` the user put on `PATH` elsewhere stays.

Why the path matters: a helper script calls its tools by name, and a dependency's bin is linked into `node_modules/.bin` even when its install scripts never ran (npm 12's default, or `--ignore-scripts`). Without this, `npm run release` calling `npm publish` would hand the credential to a dependency's `aws`, code the user had declined to run.

This does not protect the helper from a project's own script, which can set any `PATH` before it calls npm and runs as the user anyway. A helper that needs a tool only a project installs calls it by its absolute path.

#### When it runs

The first time a request to that registry is about to be sent, at most once per registry and helper per npm process, whatever the outcome. A token that expires during a long command is not fetched again: the registry's 401 is reported as for a stored token, and Phase 2's `expiresAt` and retry are what cover it.

Never for a request made offline. The packument (the registry's metadata document for a package) fetch that precedes a write is made online whatever `--offline` says, and so runs the helper. A write is still sent with `--offline`, and carries no credential from a helper, though a stored token would go with it: `--offline` asks no helper at all (a [limit](phase-1a-implementation.md#limits)).

A helper also runs before a `--prefer-offline` request the HTTP cache could have answered, since npm resolves the credential before the cache is consulted, and a helper that fails fails every request to that registry, public packages included, where a request without the credential might have been answered from the cache or by the registry. That is deliberate: a failure is visible, as in pnpm 11, where pnpm 12 sends the request without `Authorization` and a private registry answers 401 or 404 with nothing to say why. A helper therefore caches what it fetches: it is started once per npm process.

This is failing closed, and it is a difference from a stored token, which is read from a file and cannot fail a request the cache could answer. The checks of [Which requests get the credential](#which-requests-get-the-credential) come first, for every request, so a refused request starts nothing.

#### stderr

What the helper writes to stderr is shown as npm warnings when the helper fails and at `verbose` when it succeeds. The helper's exact token, and what follows its scheme word, is replaced by `***` wherever it appears in a line. That is all the masking there is: the helper is the user's own, and what it relays is shown as it is.

That is all the masking there is. It is for a token a helper echoes by accident. A helper that encodes its credential on purpose (base64, split over lines, cut short) is not stopped and could not be: it is the user's own program, it holds the credential, and what it writes to the user's terminal is the user's to read. Guessing at forms of a credential gives false positives (an error that says "Token expired" must stay readable) without stopping anything deliberate. As warnings these also reach npm's debug log, whose directory a project `.npmrc` can set with `logs-dir`, as for everything npm logs.

### Output and failures

npm trims the output, including a leading byte order mark such as Windows PowerShell 5.1 writes. A raw token is sent as `Authorization: Bearer <token>`; output that starts with ASCII letters and a space (`Bearer …`, `Basic …`) is used as the header value as is.

| Condition | Result |
|---|---|
| Non-zero exit, or a spawn error | `ETOKENHELPER`, whose message names the exit status, carrying the `signal`; a missing `#!` interpreter is named |
| Empty output | `ETOKENHELPER` |
| Not a valid header value (a second line, a control character other than tab, or a non-ASCII character) | `ETOKENHELPER`, without quoting the output: the HTTP layer's own error would print the credential |
| More than 1 MiB on stdout or on stderr | `ETOKENHELPER`; the helper is killed |
| Running longer than 60 seconds | `ETOKENHELPER`; the helper is killed |

Every failure names the helper, and npm does not fall back to another credential for that registry, the stored `_authToken` included: a user who migrates to a helper has usually left a token behind that expired long ago, and falling back to it would turn the helper's failure into a 401 from a credential nobody is maintaining, hiding the real cause. The status is in the message, not in `exitCode`, which npm's exit handler would take for its own: npm exits as for any error. A failure is also logged as a warning with the helper's stderr. Killing a helper on POSIX signals the helper process only, so a helper script should `exec` the command that does the work.

A value that is not an existing file is never printed, in any message (the refusals, the failures, `login`, `logout`, `profile` and the warnings for the unscoped, slash-less and per-scope forms), because it may be a token pasted into the setting by mistake, and a base64 token has `/` in it and passes for a path. The message names the config key and says the value is not shown; a value that names a file is shown.

A message that can be acted on says how:

| Cause | The message says |
|---|---|
| The value has arguments | Put the command in a two-line script and give its path |
| The value is a bare name | Give the absolute path |
| On Windows, a `.ps1` or `.js` file | Use a `.cmd` wrapper that starts it |
| Exit status 127, a shell's "command not found" | The helper could not find a tool it calls; use its absolute path |
| A script whose `#!` interpreter is missing | The interpreter is named, with a pointer to Windows line endings where the line ends in a carriage return |

### Which requests get the credential

A helper's credential is looked up as a stored `_authToken` for the same registry key is, and sent over a stricter route:

- **Which keys.** The library asks for the keys a stored credential would be looked up under, longest first, and stops at the first key that holds a stored credential which sets `Authorization` (a token, `_auth`, or a username and password). A key that holds only a client certificate and key (mTLS) sets no `Authorization` and does not stop the walk, so an mTLS pair at a longer key does not shadow a helper at a shorter one.
- **Which URLs.** A request whose URL falls under the key, and a full URL on the registry's host (npm's fallback for tarballs), get it; a tarball on another host or port does not. The key carries no scheme, so a lockfile `resolved` URL over `http:` on the registry's host is a request for that key, and is refused below unless it goes to this machine. The port is part of the key: `//host:8443/` is not `//host/`, and a default port is no port.
- **Plain `http:`.** A request whose URL is `http:` is refused when its host is not this machine: `localhost`, an address in `127.0.0.0/8`, or `[::1]`, as the parsed URL reads the host. The helper is not run, and the request fails with `ETOKENHELPER` naming the host and saying to use `https:`.
- **A route a project chose.** When `ca` or `cafile` has its value from the project layer, or `strict-ssl` is `false` there, the request is refused and the helper not run; so is `proxy` or `https-proxy`, for an `http:` request only.
  - npm sends an `http:` request to the proxy itself (a loopback one too), where the proxy sees the whole request. Over `https:` a proxy sees only a CONNECT tunnel and the credential travels inside it, so a corporate repository whose `.npmrc` names a proxy keeps working for an `https:` registry; a `ca` beside it still refuses.
  - The message names each key and the file it comes from, and the remedy: remove it from the project's `.npmrc` or `publishConfig`, or set it on the command line, which overrides project config. The same settings from the user or global file, the command line or the defaults are the user's own.
  - `noproxy` and `local-address` are not in this list (see the Limit rows).
- **The project layer.** For these keys the project layer is the project `.npmrc`; a user or global file that the location rule did not trust, that is, one whose path the command line or the environment chose inside a project (GitLab's `NPM_CONFIG_USERCONFIG=$CI_PROJECT_DIR/.npmrc`), or one that a project's `userconfig` (the user file), `globalconfig` or `prefix` (the global file) selected; and the `publishConfig` below. A `ca` in such a file refuses the helper as a `ca` in the `.npmrc` does.
- **A child npm.** A parent npm exports its resolved config, a project's values included, to the processes it starts as `npm_config_*`, which a child reads as its own environment. When a helper is configured it also lists the route keys it took from a project in `npm_config_token_helper_project_transport`, and a child counts a listed key whose value comes from its environment as the project's, whatever directory it runs in, and lists it for its own children. A value the parent did not list is the user's, even where a `.npmrc` holds the same value, and so is one that the user gave the child on its command line.
- **A child in another project.** The install that prepares a git dependency runs `npm install` in the clone, which has a project of its own. Comparing the environment with that directory's `.npmrc` would take the parent's `proxy` for the user's, so the list needs no comparison. The same holds for the files: a project's `userconfig=${HOME}/.npmrc` hides the user's file from the parent but not from the clone's npm, and a tree with no marks whose `.npmrc` chooses `./u.npmrc` with a helper would have the clone's npm run it. `npm_config_token_helper_untrusted` closes both, and the two lists are independent.
- **`publishConfig`.** `publish` and `unpublish` register the route keys of the manifest's `publishConfig` (`proxy`, `https-proxy`, `ca`, `cafile`, `strict-ssl`) when they read the manifest, and the same per-request check sees them, replacing what the layers say as `publishConfig` does for the request. A request for a registry a helper serves is refused with the helper not run, naming `publishConfig of package.json`; remove it from `publishConfig`, or set it on the command line, which overrides `publishConfig`. Each manifest sets them anew. Where an OIDC token is in use the helper is never asked, so nothing is refused; where no helper serves the registry, nothing is checked.
- **Every request, never cached.** These checks are made for each request, before the HTTP cache and before the program is started, so a refusal does not start the helper and is not remembered.
- **Redirects** are followed as make-fetch-happen follows them for a stored token.
- **On disk and in errors.** The HTTP cache and error responses behave as they do for a stored token ([sources.md](sources.md#external-facts) records make-fetch-happen's `Vary` handling).

What is the principle? Phase 1a refuses for a helper what npm/cli can decide before the program starts, from the URL of the request and from which layer a setting came from: plain `http:`, and the route settings a project chose.

What it leaves to [Phase 1b](phase-1b-credential-hardening.md) is what happens to a credential after it is sent, which is the library's and the same for every credential: the redirect that keeps a credential for another port of the same host, the cache index that records `Authorization` when a response says `Vary: Authorization`, the redaction of an error response, `noproxy` and `local-address`, and the same rules for a stored token, which still travels over `http:` and through a project's proxy as it does today.

| Limit | Reason | Widens when |
|---|---|---|
| A helper cannot serve an `http:` registry on a network address, as a stored `_authToken` and pnpm's helper still can | A helper mints a fresh token for each process, often a broad one (`gh auth token` carries `repo`), so sending it in the clear costs more than a token the user stored on purpose; the cost falls on the helper's users only, and on nobody who has none (the message says to use `https:`). [Phase 1b](phase-1b-credential-hardening.md#where-a-credential-may-go) adds a per-registry `allow-http-credential` allowance for stored tokens only, and it does not cover a helper's credential: a fresh, often broad token stays refused over non-loopback `http:` | Not 1b's allowance, which is for stored tokens by design; a helper over an `http:` registry on a private network needs that registry served over `https:` |
| What a credential meets after it is sent is as it is for a stored token: a redirect to another port of the registry's host, the cache index, an error response that echoes the request, `noproxy` and `local-address` from a project | These are in the library and in make-fetch-happen, they are the same for every credential, and a rule in npm/cli's runner cannot reach them | [Phase 1b](phase-1b-credential-hardening.md) changes them for every credential |

| Limit | Reason | Widens when |
|---|---|---|
| A non-npm tool that starts npm and exports a project's `.npmrc` keys to it as `npm_config_*` itself is not covered by the two lists, which an npm parent sets | npm cannot see what another runner exported: the child's environment looks like the user's own. No runner is known to do it | A runner is shown to export project `.npmrc` keys to npm |
| A project's `userconfig=` that names a file with no helper hides the helper in `~/.npmrc`: the request goes without a credential, and npm prints nothing | The project's choice replaces the user file, so the helper is never read; seeing it would take a second read of the default file, and the warning for every project `userconfig=` is [Phase 1b](phase-1b-credential-hardening.md)'s | Phase 1b is adopted, or a way is found to see a hidden helper without a second read |
| A helper in a directory that others can write is run as it is | The helper is the user's own program at a path the user chose, and a check of ownership and modes differs on every platform (ACLs on Windows, network shares) | A platform check is specified, or the helper is run through [Phase 2](phase-2-credential-provider.md)'s provider with its own trust rule |
| A repository can make npm run the user's helper: its `registry=` or a lockfile `resolved` URL names the host whose key the helper is configured under, and the helper's credential goes to that host over `https:` or to this machine | The credential is the user's for that host: a project that points npm at it gets what the user gave that host, as with a stored `_authToken` for it, and the helper is not run for a host the user did not configure | Not [Phase 1b](phase-1b-credential-hardening.md), which limits where a credential may go and not whether a helper starts; [Phase 2](phase-2-credential-provider.md)'s provider can gate write credentials |

### Precedence and commands

| Situation | Behaviour |
|---|---|
| A helper and a credential stored in a file for the same registry key | The helper is used; npm warns once per registry, naming the `_authToken` it ignores. A token stored under a longer key than the helper's, such as the path of a package's registry, is the more specific credential and wins |
| A credential for the same key given on the command line or in the environment (`_authToken`, `_auth`, or `username` with `_password`) | That credential is used, the helper is not run, and npm warns once per registry, naming the key. The user wrote it for this run; one in a file does not win. It then travels as a stored token does |
| OIDC trusted publishing in use | The OIDC token is a credential for this run: it is set in the command-line layer, so the rule above makes it win, with no separate mask |
| A request over plain `http:` to a host that is not this machine, or over a route a project chose | `ETOKENHELPER`, and the helper is not run ([Which requests get the credential](#which-requests-get-the-credential)) |
| The weekly check for a newer npm, which any command may start | Asks no helper: its request for the public `npm` package carries no credential from one |
| `publish`, `whoami`, `get-identity` (which `access list packages` also uses to check for a login) | A configured helper counts as being logged in |
| The registry answers 401 | The error says that the registry refused the token the helper printed and to refresh the login or the cache of the tool behind it; it does not suggest `npm login`, which does not change what a helper prints |
| `logout` | Says why it cannot act: the helper setting has to be removed, and a stored token is named, not revoked, since revoking would send the helper's credential |
| `login` | Refuses: the token it saved would never be sent, and its requests would carry the helper's credential |
| `profile enable-2fa` | Says why it cannot work through a helper, before any request, so the helper is not started |

Warnings for the unscoped, slash-less and per-scope forms name the line to write instead.

### Compared with pnpm

pnpm 12 is a Rust CLI; the TypeScript CLI is pnpm 11, which pnpm still maintains. The table names the one it means where they differ, and [sources.md](sources.md#external-facts) has the source line and the local run behind each cell, for the pnpm versions that row names.

| | pnpm | npm (this RFC) |
|---|---|---|
| Value | Documented as an absolute path with no arguments; the parser splits on whitespace with no quoting, refusing `$`, `%`, `"`, `'` and a backtick, so it also runs a bare name from `PATH` and cannot express a path that contains a space | One absolute path, spaces allowed, no arguments |
| Unscoped `tokenHelper=` | pnpm 12 pins it at load to the `registry=` of the same file, or to registry.npmjs.org if the file names none, with a deprecation warning ([pnpm 11.4](https://pnpm.io/blog/releases/11.4)); pnpm 11 ignores it without a warning | Ignored with a warning naming the scoped line to write; not fatal under `strict-npmrc`; `npm config set` writes it, and the next load warns |
| Key without a slash before the colon (`//host:tokenHelper`, as pnpm's docs show) | Accepted by both; the slash is added | Ignored with a warning naming `//host/:tokenHelper` |
| `//<registry>/:@scope:tokenHelper` | Parsed by both: the helper serves that scope's packages (the docs show the form for `_authToken` only) | Ignored with a warning naming the per-registry key |
| Key in project `.npmrc` | Error in both, unless the user's file has the same value; the environment form is dropped | Ignored with a warning |
| Output | Install: `trimEnd()`, then a leading scheme (`Bearer …`, `Basic …`) is kept and anything else gets `Bearer`. Publish: pnpm 11 trims both ends, strips `Bearer` and always sends `Bearer`, so `Basic …` goes out as `Bearer Basic …`; pnpm 12 maps as for install | Trimmed at both ends, BOM removed, refused if not a valid header value; the same mapping on every request |
| Windows `.cmd` | Through `cmd.exe` in all three paths: pnpm 11 install (Node's `shell` option), pnpm 11 publish (execa), pnpm 12 (`cmd /C`) | Through `cmd.exe`; a directory path over 258 characters is refused. pnpm's parser refuses `"` and `%` in every value; npm does not look at them, since the path is the user's own |
| Directory, environment, stdin | The directory pnpm runs in (the project's) and its whole environment; stdin closed | The helper's own directory; the environment without `npm_config_*` and the script `PATH` entries; stdin closed |
| Time limit | 60 s, then the helper is killed, in pnpm 12 and in pnpm 11 install; pnpm 11 publish has none | 60 s, then SIGTERM and SIGKILL 2 s later; the whole process tree on Windows |
| Output size and stderr | No limit set by pnpm (pnpm 12 reads to the end); stderr is dropped, except in pnpm 11 publish, which shows it as warnings | 1 MiB per stream, then `ETOKENHELPER`; stderr shown as warnings with the exact token masked when the helper fails, at `verbose` when it succeeds |
| When it runs | pnpm 12: at the first matching request, once per registry and scope key per process. pnpm 11 install: when the client is set up, for every registry with a helper, and again at each setup. pnpm 11 publish: at each publish | At the first request to that registry, once per registry and helper per process; a failure is cached too |
| When it fails | pnpm 11: an error, before any request. pnpm 12: logged, and the request goes out without `Authorization` | `ETOKENHELPER`, and no fallback to another credential |
| Helper and `_authToken` for one registry | The helper wins; in pnpm 11 `publish` the `_authToken` wins and the helper does not run. OIDC wins over both in `publish` | The helper wins over one in a file, with one warning per registry naming the ignored `_authToken`; one given on the command line or in the environment wins over the helper, and OIDC is one of those |
| Proxy, `ca`, `cafile`, `strict-ssl` from a project `.npmrc` | Not read for this document | Refused before the helper runs, naming the key and the file (a proxy for an `http:` request only); the same settings from the command line, the environment or the user's files are used |
| `publish` | Runs the helper since 8.14.1 ([issue 7316](https://github.com/pnpm/pnpm/issues/7316)); pnpm 11 has a path of its own for it | Runs the helper, and counts it as being logged in |
| Registry on `http:`, or on another port | Both send the credential: the lookup key drops the scheme, and pnpm 11 falls back to the key without the port, so `//host/`'s credential also goes to `host:8080` | Refuses `http:` except to `localhost`, `127.0.0.0/8` and `[::1]`, which a stored `_authToken` is still sent over; the port is part of the key, as npm's `//host[:port]/` keys have always been, so `//host/`'s credential does not go to `host:8080`. [Phase 1b](phase-1b-credential-hardening.md) applies the `http:` rule, and the redirect rule for another port, to every credential |

The two agree on an absolute path with no spaces and no arguments that prints a one-line token, for what a request carries; around the run they differ, as the rows say. Where npm is stricter, it is for a reason particular to npm:

- **No unscoped form:** a project `.npmrc` may set `registry=`, so "the default registry" is partly chosen by the repository, and the helper's credential would follow it to another host. This is why npm 9 made an unscoped `_authToken` an error. pnpm 12 closes the same hole by pinning the key to the registry declared in the same file, but falls back to registry.npmjs.org when the file declares none, which sends a corporate helper's token to the public registry, and pnpm has deprecated the form; pnpm 11 ignores it. The scoped key works in all of them.
- **No plain `http:` and no project-chosen route:** a helper mints a fresh, often broad token for each process, and a repository's `.npmrc` can name a proxy or a CA, so sending it in the clear, through a proxy that sees the request, or past a CA the repository chose would hand it the credential. pnpm sends a helper's credential over `http:` ([sources.md](sources.md#external-facts)); what it does with a project's proxy was not read.
- **A credential for this run beats the helper:** one on the command line or in the environment is the user's choice for this run, unlike a token left in a file, which a user who set up a helper has usually forgotten.
- **No bare names, ever:** a bare name would be looked up on a `PATH` that npm extends with the project's `node_modules/.bin` when it runs inside a script, which would let a dependency choose the helper.
- **No arguments:** pnpm documents the value as an absolute path with no arguments, so this costs no documented pnpm setup; a command that needs arguments goes in a two-line script, or in Phase 2's `credentialProvider`, whose value is an argument list.
- **No per-scope helpers:** one helper per registry is what Phase 1a offers; telling scopes apart is what Phase 2's request context is for.
- **A failure ends the request:** npm stops with the helper named, as pnpm 11 does. pnpm 12 sends the request without the credential, so a registry that serves public packages to anyone answers as if no login existed, and a private one answers 401 or 404 with nothing to say why.
- **The helper's own directory and environment:** pnpm gives the helper the project directory and everything in its environment. For npm, which exports a project's config to what it starts, that would let a repository's `.npmrc` reach the helper through `NODE_OPTIONS` or `PATH` ([How the helper runs](#how-the-helper-runs)).

### Vendor CLIs

Vendor CLIs already print what a helper needs; since a helper takes no arguments, each becomes a two-line script. The header column is what each vendor's documentation shows npm being given, checked on 2026-10-22:

| Registry | Command printing the credential | Lifetime | Header |
|---|---|---|---|
| AWS CodeArtifact | `aws codeartifact get-authorization-token --domain D --domain-owner ACCOUNT --duration-seconds 900 --query authorizationToken --output text` | 15 min as written (`--duration-seconds 900`); without it the token lasts the default 12 h, up to 12 h ([docs](https://docs.aws.amazon.com/codeartifact/latest/ug/tokens-authentication.html)) | Bearer: the documented npm setting is `_authToken=$CODEARTIFACT_AUTH_TOKEN` ([npm with CodeArtifact](https://docs.aws.amazon.com/codeartifact/latest/ug/npm-auth.html)) |
| Google Artifact Registry | `gcloud auth print-access-token` | 60 min ([docs](https://docs.cloud.google.com/artifact-registry/docs/nodejs/authentication)) | Bearer: Google's own npm tool, `google-artifactregistry-auth`, writes `<registry>:_authToken=<access token>` and migrates the older `_password` pair into it ([source](https://github.com/GoogleCloudPlatform/artifact-registry-npm-tools/blob/eae37c393241cae13a7d0ff05566abe16a624c41/src/update.js#L41-L58)), which npm sends as Bearer; the script prints the bare token. Google's page names no header and forms the credential as the pair `oauth2accesstoken:<token>`, so the Bearer form rests on the tool, not on the page |
| GitHub Packages | a classic personal access token with `read:packages`, kept in the OS keychain and printed by a two-line script (`security find-generic-password -w -s npm-packages` on macOS, `secret-tool lookup service npm-packages` with libsecret on Linux) | as long as the token's own expiry; the helper moves it off the disk and does not shorten it | Bearer: GitHub documents `_authToken=TOKEN` with a classic personal access token for Packages ([npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)). `gh auth token` is not recommended as the migration: its `gho_` OAuth token carries `repo`, `read:org` and `gist`, broader than a `read:packages` token, and GitHub documents only classic personal access tokens for Packages ([the GitHub Packages example](examples/github-packages.md)) |
| JFrog Artifactory | `jf atc --expiry=3600 \| jq -r .access_token` | as requested, within the platform limit | Bearer: JFrog documents `_authToken=<identity token>` and says `_auth` is not supported by npm 9 and newer ([npm repositories](https://docs.jfrog.com/artifactory/docs/npm-repositories)). That page names an identity token and does not say that an access token minted by `jf atc` is accepted there; the row is untested against a live Artifactory |

Not every row narrows to reading. `gh auth token` prints a token that always carries `repo`, `read:org` and `gist` besides the package scope ([gh auth login](https://cli.github.com/manual/gh_auth_login)), which is why the GitHub row does not use it; `jf atc` prints a token with the rights of the user it is minted for. Each npm process runs `aws` once, which takes about a second, so a long chain of scripts that each call npm repeats it and can meet the service's throttling; a helper that caches a token for its own minutes (in a file only the user can read) avoids that, at the price of a second place a token lives.

Azure Artifacts has no row: its npm page documents a personal access token only, a base64 `_password` with any `username` (a Basic credential), and `vsts-npm-auth` to refresh it ([docs](https://learn.microsoft.com/en-us/azure/devops/artifacts/npm/npmrc?view=azure-devops)). Microsoft documents Microsoft Entra tokens for Azure DevOps (resource `499b84ac-1321-427f-aa17-267ca6975798`, [docs](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/entra-oauth?view=azure-devops)), but not that an npm feed accepts one, so no short-lived route through `az account get-access-token` is claimed. A helper that prints `Basic <base64(user:PAT)>` works with a long-lived PAT, which is what the helper is meant to move off the disk, not to introduce.

For npmjs.com itself a helper helps less: the two-hour session token comes from an interactive browser login with 2FA, so a helper can keep it in the OS keychain instead of `~/.npmrc` but cannot renew it silently.

Phase 1a has no context, no cache control and no way to learn that a token was rejected; those are what Phase 2 adds.

## Rationale and Alternatives

### Why not environment variables or `${VAR}` in `.npmrc`?

They move the secret instead of removing it. An environment variable is inherited by every lifecycle script, and pnpm no longer expands `${…}` in a repository's `.npmrc` for registry and proxy URLs, `//` keys and credentials, because a malicious repository could use it to exfiltrate CI secrets to a registry of its choosing ([pnpm docs](https://pnpm.io/npmrc), [sources.md](sources.md#external-facts)).

### Why per registry and not a protocol?

It is the right first step: compatible with pnpm, small next to the protocol, and enough for a single-registry setup. But a helper learns nothing about the request, cannot say how long its token lives, cannot be told that a token was rejected, and runs once per process. Per-scope tokens, publish-time step-up, long installs that outlive a token, and `npm login` delegation all need the protocol. Phase 1a is therefore the pnpm-compatible step, and the protocol is [Phase 2](phase-2-credential-provider.md).

## Implementation

This section is informative: it describes one way to meet the requirements above.

- **Where it plugs in.** In `npm-registry-fetch`, `regFetch()` resolves auth synchronously (`getAuth()` in `lib/auth.js`) before the asynchronous fetch starts. A helper call is asynchronous, so a helper-backed credential has to be resolved inside the async fetch path, which `regFetch()` already returns as a promise. pnpm's TypeScript CLI runs `tokenHelper` with `spawnSync`, which blocks the event loop while the helper runs and rules out a long-lived session.
- **The seam in npm-registry-fetch.** A new option, proposed as `opts.getAuthorization({ regKey, uri })`: async, it takes an object so that later phases can add fields without breaking callers, and returns a header value or nothing. The library keeps matching a request to a registry key where it does today (`lib/auth.js`), calls the function for each key a stored credential would be looked up under, and sends the first value it returns. A function that returns nothing leaves the stored credential in use, which is how npm steps aside for a credential given for this run.
- **No process code in the library.** It exports `getAuth.supportsGetAuthorization`, `true` where the option is honoured. It has no process code, so another tool that uses the library is never left with a child, and never runs a program because a config key says so.
- **The runner in npm/cli.** A module in `lib/utils` on `@npmcli/promise-spawn` implements [How the helper runs](#how-the-helper-runs): the checks on the value, the directory, environment and `PATH`, the recursion guard, the time and size limits, the mapping of output to a header, the masking of stderr and the error messages. It keeps one promise per registry and helper per process, a refusal of the value (which looks at the file system) and a failure included, so the file system is looked at once and not once per request, and npm passes the function to the library as `getAuthorization`.
- **Route checks.** The runner's function receives the URL of the request, and, before it consults its cache or starts anything, steps aside for a credential the command line or the environment gave for the key (`config.credentialKeysFromCliOrEnv(regKey)`), refuses `http:` to a host that is not loopback, and refuses when `config.tokenHelperProjectTransport` lists a route setting from the project layer.
  - `@npmcli/config` answers both from the layer each value came from (a route key from the environment counts as the project's when a parent npm listed it as taken from its project, a file chosen inside a project is the project layer, and `publishConfig` route values are registered by `publish` and `unpublish`); the runner leaves a project's `proxy` and `https-proxy` alone for an `https:` request. For a child npm the config exports the list of the route keys that came from a project, and only when a helper is configured.
- **How Phase 2 uses the same seam.** Phase 1a's library makes one call per key and no more. [Phase 2](phase-2-credential-provider.md) adds a second: after a 401 or 403 npm-registry-fetch calls `opts.getAuthorization` again, with `{ regKey, uri, rejected: { status, challenges } }`. The Phase 1a runner is to return `undefined` for such a call, so a helper's rejected token is not sent again and no retry happens (a helper cannot be told it was rejected; neither the library's second call nor this answer is in the prototype). The operation (`read`, `publish`, ...) comes from npm/cli and the command that makes the request, not from the library, which only passes along what it is given.
- **Version skew.** An npm-registry-fetch that predates the option ignores it and sends every request with no credential, silently. npm/cli therefore raises its dependency floor to `^20.1.0`, the next minor after 20.0.1 (the first release with the option), and every command but `config` (and its aliases `get` and `set`), `help` and `completion` fails with `ETOKENHELPER` and a message naming the missing capability when a helper is configured and `getAuth.supportsGetAuthorization` is not set; those three can still run, so the setting can be removed. Only the copy npm itself resolves is checked: a library bundled further down a dependency that carries its own copy is not.
- **Config.** `@npmcli/config` gains the per-registry `tokenHelper` key, filtered by source as [Trust](#trust) and the [location rule](#where-it-may-be-set) require (the walk up from the chosen file for a `package.json` or a `.git`, stopping at home). The key is read from trusted files only, and a `//<registry>/:tokenHelper` key among the options a caller passes to the library does nothing: tools other than npm (npm-check-updates among them) merge every `.npmrc` key they read, a project's included, into those options.
- **Commands.** `publish`, `whoami` and `get-identity` count a helper as a login; `logout` and `profile enable-2fa` say why they cannot act. The OIDC token goes into the command-line layer, where a credential for the key replaces a helper, and the exchange request itself passes no `getAuthorization`; `publish` and `unpublish` register the `publishConfig` route keys, which the per-request check then sees.
- **Prototype.** [phase-1a-implementation.md](phase-1a-implementation.md) describes the three upstream submissions, the prototype, the checks it went through and what each statement in this document maps to; the earlier, hardened prototype is on the branches named there. [sources.md](sources.md) holds what the RFC says about npm, pnpm and others.

| Setting | Where | Default | Description |
|---|---|---|---|
| `//<registry>/:tokenHelper` | user, global | none | Phase 1a: absolute path of a program that prints a token. |

## Prior Art

pnpm's `tokenHelper` is the model, compared row by row in [Compared with pnpm](#compared-with-pnpm). Git and Docker have run credential helpers for a decade, Cargo and NuGet have protocols; [Phase 2's Prior Art](phase-2-credential-provider.md#prior-art) compares them all.

## Migration Plan

No change for anyone who has not configured a helper.

| Phase | Release | Ships | Done when |
|---|---|---|---|
| 1a: `tokenHelper` | next minor | `//<registry>/:tokenHelper` where [Trust](#trust) allows it, its output mapped to a header as pnpm does; a warning for it anywhere else and for pnpm's unscoped and per-scope forms; `publish`, `whoami` and `get-identity` counting a helper as a login, `logout` explaining it, `login` and `profile enable-2fa` refusing, a credential for the run (OIDC included) winning over it, and a helper's credential refused over plain `http:` except to this machine and over a route a project chose | One helper serves npm and pnpm from the same `~/.npmrc`, where it prints a Bearer token for an `https:` registry and its path has no spaces, `$`, `%` or quotes (pnpm's parser refuses them); Phase 2 and pnpm do not mix for one registry |

[Phase 1b](phase-1b-credential-hardening.md) is a separate proposal with its own migration plan: it changes how every credential travels, behind an opt-in setting in a minor release and by default in the next major. Phase 1a does not wait for it, and the helper needs no change when it lands.

## Open decisions for the npm maintainers

The rules above are this proposal's position, and the maintainers may reasonably choose differently on these points, each of which changes behaviour a user can see:

- **The callback.** Its name, `opts.getAuthorization({ regKey, uri })`, where the capability flag hangs (`getAuth.supportsGetAuthorization` here), and whether the object is the extension point for Phase 2's second call.
- **Precedence over file credentials.** A helper beats a token stored in a file for the same key, with a warning, where a stored token could instead win or the combination could be an error. The helper-first order is what lets a user migrate without deleting an expired token first.
- **Failing closed before the cache.** A failing helper fails a request the HTTP cache could have answered. The alternative, pnpm 12's, is to send the request without a credential.
- **The helper-only route refusals ahead of 1b.** Refusing plain `http:` except to this machine, and a project-chosen proxy or CA, for helpers alone leaves a stored token on the old rules until [Phase 1b](phase-1b-credential-hardening.md). The maintainers may prefer to wait for 1b and apply one rule to every credential at once.
- **The name of the recursion guard.** `NPM_INTERNAL_TOKEN_HELPER_RUNNING`, which can change without changing a rule, as can the names `npm_config_token_helper_project_transport` and `npm_config_token_helper_untrusted` of the two lists a parent npm gives its children.

The protocol's own are in [Phase 2's open decisions](phase-2-credential-provider.md#open-decisions-for-the-npm-maintainers).
