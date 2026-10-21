# Phase 1 implementation

How the `tokenHelper` prototype described in [Phase 1](phase-1-token-helper.md) is built and how it was checked. [Rule by rule](#rule-by-rule) maps each statement in Phase 1 to the test or source behind it, and [sources.md](sources.md) holds what the RFC says about npm, pnpm and others.

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
| Claims | every piece of evidence this file, [phase-2-conformance.md](phase-2-conformance.md) and [sources.md](sources.md) cite still exists | [`poc/claims/check.js`](poc/claims/check.js) |

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

## Rule by rule

Each statement of Phase 1 about the prototype is pinned to a test or a check, written as `kind: text`. [`poc/claims/check.js`](poc/claims/check.js) confirms in CI that each one still exists, so a renamed or deleted test fails instead of leaving a claim without evidence.

What the check proves: it finds the text as a substring of the files of its kind. It does not run the test, and finding the text does not show that the test asserts what the row says: that is for the row's wording and for a reader of the test.

Kinds: `fetch` is a test title in npm-registry-fetch `test/token-helper.js`; `config` a test title in npm-cli `workspaces/config/test/`; `cli` a test title in npm-cli `test/lib/`; `e2e` a check in [`poc/npm-e2e/run.js`](poc/npm-e2e/run.js); `probe` a check (not an `info` line) in [`poc/platform-probes/run.js`](poc/platform-probes/run.js).

### Where `tokenHelper` may come from

| Claim | Evidence |
|---|---|
| Honoured from user and global config only; ignored with a warning in project config, env and cli | `config: tokenHelper is honored only from user and global config`, `e2e: project-config` |
| npm-registry-fetch runs no helper named by a config key among its options, only one in `opts.tokenHelpers`, which @npmcli/config fills from trusted files | `fetch: a tokenHelper key among the options runs nothing: only opts.tokenHelpers names a helper`, `config: tokenHelper is honored only from user and global config` |
| A user or global file selected by a project setting is not trusted | `config: userconfig set in the project`, `config: globalconfig set in the project`, `config: prefix set in the project moves the default global file`, `e2e: project-redirects-userconfig` |
| Keys are compared after environment expansion | `config: a key that expands to a selecting setting` |
| globalconfig provenance follows the layer that holds the value in effect | `config: globalconfig set in the project over one from`, `config: a project globalconfig over a user one, with one from`, `config: a trusted user file overrides a project globalconfig` |
| A child npm is told which files the parent did not trust | `config: a child npm keeps distrusting files its parent did not trust`, `config: a child npm is told which config files the parent did not trust for a token helper`, `e2e: parent-runs-child`, `e2e: child-project-globalconfig` |
| npm started by a repository's scripts (`npm run` in the repository or a workspace, `npm exec -c`, a script that drops the marker) gets no helper from a repository-chosen file; a script that drops the marker and leaves the project is outside what the rule can stop | `e2e: the child npm reaches the registry`, `e2e: the repository file supplies no credential to it`, `e2e: a script that drops the marker and starts npm outside the project reaches the registry`, `e2e: a script that drops the marker and starts npm outside the project gets the repository file` (asserted from 2026-10-21: the helper of the repository file is used, which is the stated limit) |
| A file inside a project is not trusted however chosen, including through a cli or env prefix | `config: a file inside the project chosen by`, `e2e: prefix-into-repository` |
| Projects are every ancestor with package.json or node_modules | `config: a file in an outer project is not trusted from a nested one` |
| Whether a run is global is read only from layers a project cannot write | `config: a cli prefix outside the project in`, `config: does not make a cli prefix global` |
| Containment by device and inode, which Node reports nonzero and distinct on NTFS, a FAT32 volume and an SMB share alike (the probes run on all three in CI); spellings only for paths that do not exist, and for a file system that reports a zero inode, which none of the three does | `config: a file in the project spelled with`, `config: a file in the project spelled with an 8.3 short name is not trusted`, `config: a directory in the project named ..`, `config: a file under a prefix that does not exist yet, named through a link`, `config: without inode numbers, paths are compared as spelled`, `probe: the project file in another letter case is refused`, `probe: the project file through an NFD spelling is refused` |
| The home directory is not a project; default files stay trusted when a project names them | `config: the default user file is trusted in a home directory that is a project`, `config: a user-chosen file under a home directory that is a project is trusted`, `config: a project .npmrc that names the default user file changes nothing` |
| 2048 combinations of which of the project file, the environment, the command line and the user file set `userconfig` (not the user file: three sources), `globalconfig` and `prefix` (four each): no project-chosen helper in effect (asserted for every combination npm loads; the few it refuses, because a file would load twice, are skipped), none lost (asserted only where the project chose none of the three settings and the user file, the environment or the command line sets `globalconfig` or `prefix`, and not for a command-line `prefix` with no `globalconfig`, which outside a global run is the project directory itself) | [`poc/npm-config-matrix/run.js`](poc/npm-config-matrix/run.js), run in CI on three OSes |
| None of the sampled spellings of the key in a project or workspace `.npmrc`, `npm_config_*`, a flag or `publishConfig` makes npm use a helper (case, Unicode lookalikes, `${VAR?}`, ini sections and quoting, BOM, CRLF) | [`poc/npm-config-fuzz/spellings.js`](poc/npm-config-fuzz/spellings.js): by default 2000 spellings in-process, in CI 500 (seed: the run number), and in both 30 with a real npm and a marker-writing helper and 10 through `npm publish`; positive controls in user config |
| `publishConfig` cannot supply a helper | `cli: publishConfig cannot supply a tokenHelper`, `e2e: publishConfig-helper` |
| pnpm's unscoped and per-package-scope forms are warned about and not fatal; `config set` refuses the unscoped form and project config | `config: pnpm-only tokenHelper forms get a pointer to the registry form and are not fatal`, `cli: config set tokenHelper` |
| The unscoped form's warning names the line to write for the file's own `registry=`, or asks for the registry when there is none; a key without a slash before the colon is ignored with a warning naming the key to write | `config: pnpm-only tokenHelper forms are pointed at the exact line to write` |

### Running the helper

| Claim | Evidence |
|---|---|
| A helper's output becomes the same Authorization value in the prototype and in the Python model, or is refused by both, and a refusal quotes none of it; a `tokenHelper` value is accepted or refused (not absolute, arguments, not found) the same way by both, on a tree of real files | [`tests/fuzz_helper.py`](tests/fuzz_helper.py), run in the `prototype` workflow on each OS and Node version |
| Control characters in helper stderr are removed before it is logged; `cmd.exe` runs with `/v:off` | `fetch: control characters in stderr never reach the terminal`, `fetch: batch files run through cmd.exe on Windows only`, [`poc/helper-fuzz/names.js`](poc/helper-fuzz/names.js) (helpers named with `& ^ ( ) ! , ; = '` and spaces, in directories named so, run as themselves and nothing else, `%` refused; on Linux and macOS names with `$ ` ; & | ' " * ? [`, a newline or a leading dash are only names; each seen to fail when the quoting was weakened) |
| An absolute path with no arguments; anything else refused with `ETOKENHELPER` | `fetch: a relative path or a command with arguments is refused` |
| On Windows a helper path through a directory with a space, in another letter case, with forward slashes or through an 8.3 short name runs the file it names; one with a trailing space or dot or a slash after the file name is refused; none runs another file beside it, on NTFS, on a FAT32 volume and on an SMB share | `probe: a .cmd helper in a directory with a space in its name is refused or runs that file`, `probe: a helper path with a trailing space, where a file with that name exists beside the decoy, is refused or runs the file it names`, `probe: a helper path with a trailing dot, where a file with that name exists beside the decoy, is refused or runs the file it names`, `probe: a helper path with a slash after the file name is refused or runs nothing`, `probe: a helper path in another letter case is refused or runs that file`, `probe: a helper path through an 8.3 short directory name is refused or runs that file` |
| A `.cmd` or `.bat` helper on an SMB share (`\\host\share`) starts in the Windows directory, not its own: cmd.exe takes no UNC working directory. It is still not the repository | the SMB run of the platform probes (`info a .cmd helper in … started in`) |
| `.cmd`/`.bat` through `cmd.exe` on Windows only; `"` or `%` refused there; `& ^ ! ; ( ) ' , =`, spaces and non-ASCII in the directory reach the helper unchanged and inject nothing | `fetch: batch files run through cmd.exe on Windows only`, `probe: runs as itself, in its own directory`, `probe: is refused with a reason`, [`poc/helper-fuzz/names.js`](poc/helper-fuzz/names.js) |
| A path with `"` or `%` is refused before `cmd.exe` sees it | `fetch: batch files run through cmd.exe on Windows only`, `fetch: cmd.exe cannot be given a path with a quote or a percent sign` |
| Starts in its own directory: the working directory that `command()` returns is the helper's directory, on every OS; a real run is checked only for `.cmd` helpers on Windows (the two tests below skip elsewhere, and the probe's check is Windows-only), and no test pins a real run of another kind of helper's working directory | `fetch: batch files run through cmd.exe on Windows only` (the `command()` assertion), `fetch: a helper does not start in npm`, `fetch: a .cmd helper starts in its own directory`, `probe: runs as itself, in its own directory` |
| No `NODE_OPTIONS`, `npm_config_*` or other variables npm sets from config | `fetch: a helper gets no NODE_OPTIONS and no npm_config_ variables`, `fetch: own variables are not passed on`, `e2e: project-node-options` |
| `PATH` without what npm put in front of it for a script (run-script's block of `node_modules/.bin` directories and its `node-gyp-bin`, a nested run's repeat, the `node_modules/.bin` of the working directory and its parents); a `node_modules/.bin` the user put on `PATH` elsewhere stays; exit 127 or 9009 names the reason | `fetch: and only those`, `fetch: a helper that could not find a command says why the tool may be missing` (a unit test of the environment built, not a run of a script calling a shadowed tool) |
| Lazily, once per registry per process, failures cached | `fetch: the helper runs once per registry per process`, `fetch: a failed run is cached too`, `fetch: a different registry key runs the helper separately` |
| Not for `--offline` | `fetch: an offline request does not run the helper` |
| Raw token → `Bearer`; output starting with a scheme used as is; trimmed, BOM removed (pnpm trims the end only; npm trims the start too, for the BOM); the mapping follows pnpm's rule as read in [its source](https://github.com/pnpm/pnpm/blob/07ab9fa881733154670f803fb4aa96dfd97e6cd9/pnpm11/network/auth-header/src/getAuthHeadersFromConfig.ts#L103-L112), and `fetch: header mapping matches pnpm` is five hand-written assertions of that rule, not a run of pnpm | `fetch: a raw token is sent as a Bearer token`, `fetch: output with an auth scheme is used as the header value`, `fetch: whitespace and a byte order mark around the output are removed`, `fetch: header mapping matches pnpm` |
| Output that is not a valid header value refused without quoting it | `fetch: output that is not a valid header value is refused without quoting it` |
| 60 s deadline; SIGTERM then SIGKILL; whole tree on Windows (the last by `taskkill /pid N /T /F`: the test injects `taskkill`, so it pins the command line and the fallback to ending the process, not that a real process tree dies) | `fetch: a helper has 60 seconds by default`, `fetch: a helper that ignores SIGTERM is rejected at the deadline and then killed`, `fetch: killTree on Windows: taskkill for the whole tree` |
| More than 1 MiB of output, counted in written bytes, ends the helper | `fetch: a helper that prints too much is ended`, `fetch: the output limit counts the bytes the helper wrote`, `fetch: run ends the helper as soon as a stream overflows` |
| Read 250 ms more after exit while a background process holds stdout, and not wait for the process (the test shows the second, not the 250 ms) | `fetch: a helper that exits while a background process holds its stdout` |
| A missing `#!` interpreter is named | `fetch: a script whose interpreter is missing is reported as such`, `probe: a missing #! interpreter is named` |
| stderr shown as warnings; the helper's own token scrubbed, credential-like values masked; for tokens of 8 or more characters a printed token never survives into a logged line, in 3000 seeded cases (one seed; 11 shapes of printed output, 7 shapes of stderr echo, random noise around; a shorter token is hidden only where its output was used and stderr repeats it exactly) | `fetch: stderr lines become warnings and the token is never logged`, `fetch: the helper token is hidden wherever stderr repeats it`, `fetch: a printed token never survives into a logged line`, `fetch: scrub hides the credential as JSON, a shell and a URL write it`, [`tests/fuzz_helper.py`](tests/fuzz_helper.py) (the prototype's `scrub`, `mask` and control-character strip against the helper's token, as it is and as JSON, a shell's single and double quotes and a URL write it: 242 000 outputs in a run of 60 s, none left; measured once, recorded 2026-10-18, not re-run by CI, which runs the fuzzer for 20 s with a seed of its own) |
| A redirect to another host name, and a tarball on another host or port, get no credential; a redirect to the same host on another port gets what a stored token gets | `e2e: the request reached the other host`, `e2e: it carries no more than a stored token would`, `e2e: and no credential at all` |
| A helper's credential goes over `https:` and over `http:` to `localhost`, `127.0.0.1` and `::1`, and to nothing else: a request over `http:` to the registry's host (a lockfile's `resolved` URL) goes out without it and does not start the helper, while a stored token keeps going over `http:` | `fetch: a helper credential goes over https`, `fetch: a request over http: to the registry host goes out without it, and the helper is not run`, `fetch: a registry that is itself http: gets no credential either, while a stored token still goes`, `fetch: http: to ${host} gets the credential, for a local registry` (for localhost and 127.0.0.1), `fetch: http: to [::1] gets the credential, for a local registry`, `fetch: http: to a host that only looks like a loopback address gets nothing`, `e2e: no request carries a credential`, `e2e: the helper was not run`, `e2e: control: a stored token goes over the same http: registry` |
| A redirect that keeps the host name keeps the credential only while the target may carry it: to `https:` and to loopback `http:` it does, to `http:` elsewhere it does not and does not come back on a later hop, to another host name it does not; the redirect's method and body follow the usual rules | `fetch: a redirect to https on the same host keeps the credential`, `fetch: a redirect on the same host from https to http drops the credential`, `fetch: after the credential is dropped it does not come back on a later hop`, `fetch: a redirect from https to http on a loopback address keeps the credential`, `fetch: a redirect to another host drops the credential`, `fetch: a redirect that turns a POST into a GET`, `fetch: a 307 keeps the method and the body`, `fetch: a 303 away from the credential also becomes a GET`, `fetch: a redirect loop ends with EMAXREDIRECT`, `fetch: a redirect without a location is returned as it is` |
| A request that carries a helper's credential takes proxy, https-proxy, noproxy, ca, cafile, strict-ssl and local-address from the defaults, builtin config, environment, command line and the user and global files the trust rules accept, never from a project `.npmrc`; a request without the credential takes its own | `config: tokenHelperTransport holds the user`, `config: tokenHelperTransport also takes the environment and the global file`, `config: there is no tokenHelperTransport when no tokenHelper is configured`, `fetch: a request that carries a helper credential uses the trusted transport`, `fetch: the trusted transport replaces the request`, `fetch: a request without a helper credential uses its own transport`, `fetch: a helper request that is not sent with the credential uses its own transport`, `fetch: a helper request without a trusted transport uses its own`, `fetch: a hop that leaves the credential behind goes back to the request`, `e2e: sees no request at all`, `e2e: control: a stored token goes through` |
| The token appears nowhere but the request: output, debug log, timing file, HTTP cache | `e2e: and nowhere else: output, logs, timing, cache` (run for view, publish and whoami at loglevel silly with --timing) |
| A registry that quotes the credential in a 401 body: npm prints and logs it, the same as for a stored `_authToken` | `e2e: a 401 that quotes the credential leaks no more than a stored token does` |

### Precedence and commands

| Claim | Evidence |
|---|---|
| A helper wins over a stored token | `fetch: getAuth reports the helper and lets it win over a stored token`, `config: getCredentialsByURI reports a tokenHelper ahead of a stored token`, `e2e: helper-beats-stale-token` |
| OIDC trusted publishing wins over a helper | `cli: a configured tokenHelper is masked while the OIDC token is in use` |
| `publish` and `whoami` count a helper as a login | `cli: a tokenHelper in user config satisfies the login check`, `cli: a tokenHelper counts as being logged in`, `e2e: publish-with-helper-only` |
| `logout` explains, names a stored token, revokes nothing | `cli: tokenHelper logout explains instead of claiming no login`, `cli: tokenHelper logout names a token stored beside the helper` |
| `login` refuses, also for a scoped registry | `cli: tokenHelper refuses instead of saving a token it would shadow`, `cli: tokenHelper on a scoped registry refuses a scoped login`, `e2e: login-with-helper` |

### The rest of npm

| Claim | Evidence |
|---|---|
| The prototype breaks nothing else: every npm/cli suite (the root and 16 workspaces, smoke tests included) passes with it wherever it passes without it, with npm running on the prototype's npm-registry-fetch | [`poc/full-suites/compare.js`](poc/full-suites/compare.js), the `full-suites` job on Ubuntu and Windows; a file that fails once is rerun three times in both trees before it counts |

## Limits

Not a list of things left to do: each is outside what the Phase 1 checks claim, for a reason, and each says what would make the claim wider.

| Not claimed | Why | Wider if |
|---|---|---|
| That a helper's credential is hidden from stderr in every encoding: the helper's own token is hidden as it is, as JSON, inside a shell's single or double quotes and percent-encoded (both cases of the digits), and credential-like text is masked; base64, hex, a credential split over lines or cut short are not | The helper is the user's own program and already holds the credential: a helper that encodes it on purpose cannot be stopped by what npm does to its stderr, and every other encoding is unbounded in number. The forms hidden are the ones an accident produces: a token echoed by `set -x`, quoted in an error body, in a logged URL | A helper family is found that writes its credential in another form by default, as `set -x` does in a shell's quotes |
| That the credential never reaches the HTTP cache index on disk | It takes a change to make-fetch-happen, which is not this prototype's to make; the cost and the way to avoid it are in Phase 1 | make-fetch-happen leaves `Authorization` out of the index whatever a response's `Vary` says |
| That the scheme rule and the transport rule are shown against a real https registry end to end: the end-to-end run has no TLS listener, so it shows the http: half (a registry on a network address gets no credential, a repository's proxy sees none) and the unit tests show the rest, with a mocked make-fetch-happen for the options it is given, not for what it does with them | A TLS listener with a certificate the run trusts costs a generated key pair per run on every OS, which the unit tests already cover for the decision itself; what is unshown is only that make-fetch-happen honours `proxy`, `ca` and `strictSSL` per request, which its own tests and the proxy control (`e2e: control: a stored token goes through`) show for `proxy` | The run gains a TLS listener |


## Audit history

Rounds of automated review, then targeted test work. The code findings below were fixed, and the rule each one broke has a test in the prototype ([Rule by rule](#rule-by-rule) names it). Not pinned, because it cannot be reproduced now: the counts and what a round found in code that no longer exists (the 112 failing combinations of round 5 on the earlier fix, what the fuzz runs found before their fixes). Not tested at all: round 6's corrections to the RFC on Cargo, user presence during a publish and interactive timeouts, which are document edits resting on the sources in [sources.md](sources.md).

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
