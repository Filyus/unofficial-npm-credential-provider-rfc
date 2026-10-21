# The Phase 1 prototype

How the `tokenHelper` prototype described in [Phase 1](phase-1-token-helper.md) is built and how it was checked. [claims.md](claims.md) maps each statement in the RFC to the test or source behind it.

## Where the code is

| Repository | Size | What it adds |
|---|---|---|
| npm-registry-fetch | 641 lines added in `lib/` (`git diff --numstat 6b4159a de1d74f -- lib`, counted on 2026-10-21 at the branch commit de1d74f; the patch in `poc/patches` has the same 641) and a README section | a `tokenHelper` module (own deadline and kill, one cached result per registry and process, stderr forwarded with credentials masked), a branch in `getAuth()`, and a step in `regFetch()` that waits for the helper while watching the request body and abort signal, skipped for `--offline` and for a request that may not carry the credential (http: but a loopback address), with the redirects of a credentialed request followed there a hop at a time and the transport taken from `opts.tokenHelperTransport` |
| npm/cli | about 420 lines of code (423 added in `lib/` and `workspaces/config/lib/`) and 14 of docs | config trust (who selected a file, where it lies, what a parent npm passed on) and `tokenHelperTransport` (the proxy, certificate, strict-ssl and local-address settings of the layers a project cannot write), `publishConfig` filtering, `publish`, `whoami`, `login`, `logout`, `profile`, `config set`/`ls` and OIDC handling, docs |

Both are published as [patches](poc/patches) against upstream commits, and each comes with tests. Lines are counted as added lines of the diff in each patch outside `test/` (`git diff --numstat` over the patch gives the same).

Coverage: tap's check fails `npm test` below 100%, and CI runs it wherever `npm test` runs.

- npm-registry-fetch and `@npmcli/config`: on every run.
- The rest of npm/cli: only inside the `full-suites` job, which runs each suite's `npm test` with and without the prototype and counts a suite that fails with no failing test file as a regression, but only where the base passes. A coverage shortfall in a suite that already fails on the base is not caught.
- The workflow's targeted step for the npm/cli commands runs with `--no-coverage` and checks no coverage.

## How it is checked

| Check | What it shows | Where |
|---|---|---|
| Unit tests | every rule in the RFC; coverage is enforced by tap, as described above | the patches |
| End to end (65 checks in a local run on 2026-10-21, counted by hand; the script lists each check and fails on any that does not pass, but asserts no total) | a real npm against a local registry: helpers in user config work; project, `publishConfig`, child-process and `--prefix` routes are refused; no token reaches output, logs, timing or cache; redirects and tarballs on other hosts get none; a repository's proxy sees no helper credential and an http: registry on a network address gets none; `login` refuses | [`poc/npm-e2e/run.js`](poc/npm-e2e/run.js) |
| Config matrix | 2048 combinations of project, environment, command line and user file setting `userconfig`, `globalconfig` and `prefix`: no project-chosen helper in effect (in every combination npm loads); none lost, asserted only where the project chose none of the three and the user file, the environment or the command line sets `globalconfig` or `prefix`, and not for a command-line `prefix` with no `globalconfig` | [`poc/npm-config-matrix/run.js`](poc/npm-config-matrix/run.js) |
| Trust fuzzer | random layer, path-spelling and home-directory combinations | [`poc/npm-config-fuzz/fuzz.js`](poc/npm-config-fuzz/fuzz.js), run by hand: at its seed it still reports cases on the safe side, which its header lists, so it is no pass-or-fail gate; the workflow runs `spellings.js` and the 2048-combination matrix instead |
| Spelling fuzzer | the key spelled every way ini, environment expansion and flattening allow, from every untrusted source, in-process and with a real npm | [`poc/npm-config-fuzz/spellings.js`](poc/npm-config-fuzz/spellings.js) |
| Leak oracle | 3000 seeded cases (one seed; tokens of 8 to 47 characters, 11 shapes of printed output, 7 shapes of stderr echo; the test asserts the count): for tokens of 8 or more characters, a printed token never survives into a logged line | npm-registry-fetch tests |
| Platform probes | letter case, Unicode forms, linked temp directories, 8.3 names, `..\x` names, missing `#!` interpreters, `cmd.exe` special characters | [`poc/platform-probes/run.js`](poc/platform-probes/run.js) |
| Every npm/cli suite | the root and its 16 workspaces (the four named in the root `package.json` plus the 12 under `workspaces/` at the base commit) pass with the prototype wherever they pass without it | [`poc/full-suites/compare.js`](poc/full-suites/compare.js) |
| Claims | every piece of evidence [claims.md](claims.md) cites still exists | [`poc/claims/check.js`](poc/claims/check.js) |

The [CI workflow](.github/workflows/prototype.yml) runs all of it on macOS, Linux and Windows, with Node 22.22.2, 24.15.0 and 26.x, except the comparison of every npm/cli suite with and without the prototype, which runs on Ubuntu and Windows with Node 24; on 26.x the prototype's own code runs with deprecations as errors.

What the macOS runs showed about the platform:

- the temp volume is case-insensitive, and realpath returns the stored case;
- an NFD spelling reaches an NFC directory, and realpath returns the stored form;
- the temp directory is reached through `/var` → `/private/var`, and device and inode agree through the link;
- a helper script without a `#!` line fails with ENOEXEC there, while Linux runs it through `/bin/sh`.

Until 2026-10-21 the probes only printed these (`info` lines), read from the CI log of run 39489980343 (all three macOS jobs and the Linux ones); since then they assert them on macOS (and the last one on Linux too), which CI has not run yet. The probes do not name the file system, so APFS is not claimed.

## Reproducing the checks

The `token-helper` branches are not published; the prototype is the two patches in [poc/patches](poc/patches), made against fixed upstream commits. These are the steps of the [CI workflow](.github/workflows/prototype.yml) (`NPM_CLI_BASE`, `NPM_REGISTRY_FETCH_BASE` and the `prototype` job), in a POSIX shell, starting in an empty working directory that holds a checkout of this repository as `rfc`. The Windows runs also set `core.longpaths` (npm/cli has fixtures deeper than its path limit) and `core.autocrlf false` (the patches have LF endings). Use Node 22.22.2, 24.15.0 or 26.x, and Python 3.12 with `jsonschema` for the Python step.

```sh
git config --global core.autocrlf false
git config --global core.longpaths true      # Windows only
NPM_CLI_BASE=83ea1a1c19648a6b4f5e52a498d8a6aaaf60e52b
NPM_REGISTRY_FETCH_BASE=6b4159a2519ce5aab26cc4dd8d4596a0b47781d2

# npm-registry-fetch at its base commit, with the patch applied
git init -q npm-registry-fetch
(cd npm-registry-fetch &&
  git fetch -q --depth 1 https://github.com/npm/npm-registry-fetch.git "$NPM_REGISTRY_FETCH_BASE" &&
  git checkout -q FETCH_HEAD &&
  git -c user.name=ci -c user.email=ci@localhost am -q ../rfc/poc/patches/npm-registry-fetch.patch &&
  npm install --ignore-scripts --no-audit --no-fund &&
  npm test --ignore-scripts && npm run eslint --ignore-scripts)

# npm/cli at its base commit, with the patch applied
git init -q npm-cli
(cd npm-cli &&
  git fetch -q --depth 1 https://github.com/npm/cli.git "$NPM_CLI_BASE" &&
  git checkout -q FETCH_HEAD &&
  git -c user.name=ci -c user.email=ci@localhost am -q ../rfc/poc/patches/npm-cli.patch &&
  node scripts/resetdeps.js &&
  node . test --ignore-scripts --workspace @npmcli/config)

# the checks that need both trees (any scratch directory, any seed)
export RUNNER_TEMP=$(mktemp -d)
node rfc/poc/npm-config-matrix/run.js npm-cli "$RUNNER_TEMP"
node rfc/poc/npm-e2e/run.js npm-cli npm-registry-fetch
node rfc/poc/npm-config-fuzz/spellings.js npm-cli npm-registry-fetch "$RUNNER_TEMP" 500 1
node rfc/poc/platform-probes/run.js npm-cli npm-registry-fetch
node rfc/poc/helper-fuzz/names.js npm-registry-fetch
(cd rfc && python3 -m tests.fuzz_helper --prototype ../npm-registry-fetch --seconds 20 --seed 1)
node rfc/poc/claims/check.js npm-cli npm-registry-fetch
```

The workflow also runs the npm/cli command tests the prototype changes with `node node_modules/tap/bin/run.js --no-coverage` (the step "Test the npm-cli commands the prototype changes"), and its `full-suites` job builds a base tree and a patched tree and compares every suite (`node rfc/poc/full-suites/compare.js base next`; the job allows 150 minutes, and its tree setup is in the workflow). With `NPM_REGISTRY_FETCH=<npm-registry-fetch checkout>` set, `python -m unittest discover` also runs the helper comparison of [`tests/test_helper_differential.py`](tests/test_helper_differential.py).

Two scripts are run by hand rather than by CI:

- [`poc/npm-config-fuzz/fuzz.js`](poc/npm-config-fuzz/fuzz.js) takes the npm/cli checkout from `NPM_CLI` (default: a directory named `npm-cli` next to the directory of this repository) and a scratch directory from `FUZZ_DIR`. Its 8.3 short-name cases need `cmd.exe` and are skipped, with a line saying so, on Linux and macOS.
- [`poc/full-suites/compare.js`](poc/full-suites/compare.js) counts a test file as a regression only when it fails all three reruns with the prototype and passes all three without it. A file that fails one or two of the three is listed under "failed once, not every time" and the run still passes: a regression that shows up only intermittently is not caught by the gate, so the list has to be read.

## Audit history

Rounds of automated review, then targeted test work. The code findings below were fixed, and the rule each one broke has a test in the prototype (claims.md names it). Not pinned, because it cannot be reproduced now: the counts and what a round found in code that no longer exists (the 112 failing combinations of round 5 on the earlier fix, what the fuzz runs found before their fixes). Not tested at all: round 6's corrections to the RFC on Cargo, user presence during a publish and interactive timeouts, which are document edits resting on the sources in claims.md.

| Round | Method | Found |
|---|---|---|
| 1 | review | a project `.npmrc` could set `userconfig` to a repository file and have its helper treated as the user's |
| 2 | review | `user${UNSET?}config=` and a child npm inheriting the path still could |
| 3 | review | output with a second line or a non-ASCII character reached the HTTP layer, whose error quotes the header and so printed the credential; on Windows a helper behind a `.cmd` wrapper that printed too much was left running (the fix ends the whole tree with `taskkill /T /F`; its test injects `taskkill`, so it pins the command line and the fallback, not that a real tree dies) |
| 4 | review | a child npm, which always inherits `globalconfig` from its parent's environment, let a project `globalconfig` choose the global file |
| 5 | review | the fix for round 4 modelled npm wrongly: the first layer to assign `globalconfig` stores it beneath all the others, so the layer holding the value in effect has to be asked; the config matrix found 112 failing combinations on the earlier fix and none after |
| 6 | review for wrong mental models | `npm --prefix client` (or a prefix in a CI job's environment) made a repository's `client/etc/npmrc` the trusted global config; a repository's `node-options`, exported as `NODE_OPTIONS`, loaded code into a node-based helper that read the credential it printed, with no script running. It also corrected the RFC on Cargo, user presence during a publish, and interactive timeouts |
| 7 | fuzzing | a project `.npmrc` with `location=global` switched the inside-project test off; a nested project hid the outer one; `\\?\`, 8.3 and `..ci.npmrc` spellings slipped through; a home directory that is a project cost users their own helper; a helper in a directory deeper than Windows can start a program in crashed npm; a token was lost when a helper left a background process holding stdout; the output limit counted decoded bytes; `EDITOR` and `NODE_ENV` reached the helper |
| 8 | fuzzing on Linux | on POSIX a directory named `..\evil` read as a way out of the checkout, and on a case-insensitive mount another letter case did the same; both closed by comparing directories by device and inode |
| CI | macOS | a path that does not exist yet under the `/var` → `/private/var` link was resolved inconsistently |
| Fuzz | the output of a helper against the Python model, and what is logged of its stderr against its token ([`tests/fuzz_helper.py`](tests/fuzz_helper.py)); helpers named awkwardly, run for real ([`poc/helper-fuzz/names.js`](poc/helper-fuzz/names.js)) | a credential the helper echoed as JSON, in a shell's quotes or percent-encoded was logged; now each of those forms is hidden ([notes](#fuzz-notes)) |
| Final | review of the whole proposal | npm-registry-fetch ran a helper named by any `//<registry>/:tokenHelper` key in its options, and other tools (npm-check-updates) pass a project's `.npmrc` keys there; helpers now arrive only in `opts.tokenHelpers`, which @npmcli/config fills from trusted files |

#### Fuzz notes

- The helper's own token was hidden only as it is, so a token with a quote, a backslash or a character a URL escapes got through when the helper echoed it as JSON, inside a shell's quotes (`set -x`) or percent-encoded.
- The header the prototype makes and the model makes agreed on 242 000 outputs in a run of 60 s, with nothing leaked (measured once, recorded on 2026-10-18, not re-run by CI, which runs the fuzzer for 20 s with a seed of its own).
- `names.js` on Windows tried 384 helper paths (6 directories, 32 names, `.cmd` and `.bat`) with `&`, `^`, `(`, `)`, `!` and a second command among the names: the 290 with no `%` ran as themselves and nothing else ran, and the 94 with a `%` were refused. CI runs `names.js` on each OS.
