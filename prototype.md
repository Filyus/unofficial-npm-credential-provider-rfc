# The Phase 1 prototype

How the `tokenHelper` prototype described in [the RFC](rfc-credential-provider.md) is built and how it was checked. [claims.md](claims.md) maps each statement in the RFC to the test or source behind it.

## Where the code is

| Repository | Size | What it adds |
|---|---|---|
| npm-registry-fetch | about 440 lines | a `tokenHelper` module (own deadline and kill, one cached result per registry and process, stderr forwarded with credentials masked), a branch in `getAuth()`, and a step in `regFetch()` that waits for the helper while watching the request body and abort signal, skipped for `--offline` |
| npm/cli | about 370 lines | config trust (who selected a file, where it lies, what a parent npm passed on), `publishConfig` filtering, `publish`, `whoami`, `login`, `logout`, `profile`, `config set`/`ls` and OIDC handling, docs |

Both are published as [patches](poc/patches) against upstream commits, and each comes with tests at the repository's 100% coverage.

## How it is checked

| Check | What it shows | Where |
|---|---|---|
| Unit tests | every rule in the RFC, 100% coverage in both repositories | the patches |
| End to end, 56 checks | a real npm against a local registry: helpers in user config work; project, `publishConfig`, child-process and `--prefix` routes are refused; no token reaches output, logs, timing or cache; redirects and tarballs on other hosts get none; `login` refuses | [`poc/npm-e2e/run.js`](poc/npm-e2e/run.js) |
| Config matrix | 2048 combinations of project, environment, command line and user file setting `userconfig`, `globalconfig` and `prefix`: no project-chosen helper in effect, none lost | [`poc/npm-config-matrix/run.js`](poc/npm-config-matrix/run.js) |
| Trust fuzzer | random layer, path-spelling and home-directory combinations | [`poc/npm-config-fuzz/fuzz.js`](poc/npm-config-fuzz/fuzz.js) |
| Spelling fuzzer | the key spelled every way ini, environment expansion and flattening allow, from every untrusted source, in-process and with a real npm | [`poc/npm-config-fuzz/spellings.js`](poc/npm-config-fuzz/spellings.js) |
| Leak oracle | 3000 generated outputs and stderr echoes: a printed token never survives into a logged line | npm-registry-fetch tests |
| Platform probes | letter case, Unicode forms, linked temp directories, 8.3 names, `..\x` names, missing `#!` interpreters, `cmd.exe` special characters | [`poc/platform-probes/run.js`](poc/platform-probes/run.js) |
| Every npm/cli suite | the root and its 16 workspaces pass with the prototype wherever they pass without it | [`poc/full-suites/compare.js`](poc/full-suites/compare.js) |
| Claims | every piece of evidence [claims.md](claims.md) cites still exists | [`poc/claims/check.js`](poc/claims/check.js) |

The [CI workflow](.github/workflows/prototype.yml) runs all of it on macOS, Linux and Windows, with Node 22.22.2, 24.15.0 and 26.x; on 26.x the prototype's own code runs with deprecations as errors.

What the macOS runs confirmed about the platform: APFS is case-insensitive and realpath returns the stored case; an NFD spelling reaches an NFC directory and realpath returns the stored form; the temp directory is reached through `/var` → `/private/var`, and device and inode agree through the link; a helper script without a `#!` line fails with ENOEXEC there, while Linux runs it through `/bin/sh`.

## Audit history

Rounds of automated review, then targeted test work. Each finding below is fixed and pinned by a test.

| Round | Method | Found |
|---|---|---|
| 1 | review | a project `.npmrc` could set `userconfig` to a repository file and have its helper treated as the user's |
| 2 | review | `user${UNSET?}config=` and a child npm inheriting the path still could |
| 3 | review | output with a second line or a non-ASCII character reached the HTTP layer, whose error quotes the header and so printed the credential; on Windows a helper behind a `.cmd` wrapper that printed too much was left running |
| 4 | review | a child npm, which always inherits `globalconfig` from its parent's environment, let a project `globalconfig` choose the global file |
| 5 | review | the fix for round 4 modelled npm wrongly: the first layer to assign `globalconfig` stores it beneath all the others, so the layer holding the value in effect has to be asked; the config matrix found 112 failing combinations on the earlier fix and none after |
| 6 | review for wrong mental models | `npm --prefix client` (or a prefix in a CI job's environment) made a repository's `client/etc/npmrc` the trusted global config; a repository's `node-options`, exported as `NODE_OPTIONS`, loaded code into a node-based helper that read the credential it printed, with no script running. It also corrected the RFC on Cargo, user presence during a publish, and interactive timeouts |
| 7 | fuzzing | a project `.npmrc` with `location=global` switched the inside-project test off; a nested project hid the outer one; `\\?\`, 8.3 and `..ci.npmrc` spellings slipped through; a home directory that is a project cost users their own helper; a helper in a directory deeper than Windows can start a program in crashed npm; a token was lost when a helper left a background process holding stdout; the output limit counted decoded bytes; `EDITOR` and `NODE_ENV` reached the helper |
| 8 | fuzzing on Linux | on POSIX a directory named `..\evil` read as a way out of the checkout, and on a case-insensitive mount another letter case did the same; both closed by comparing directories by device and inode |
| CI | macOS | a path that does not exist yet under the `/var` → `/private/var` link was resolved inconsistently |
| Final | review of the whole proposal | npm-registry-fetch ran a helper named by any `//<registry>/:tokenHelper` key in its options, and other tools (npm-check-updates) pass a project's `.npmrc` keys there; helpers now arrive only in `opts.tokenHelpers`, which @npmcli/config fills from trusted files |
