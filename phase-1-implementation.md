# Phase 1a implementation

How the `tokenHelper` prototype described in [Phase 1a](phase-1-token-helper.md) is built and how it was checked. [Rule by rule](#rule-by-rule) maps each statement in Phase 1a to the test or source behind it, and [sources.md](sources.md) holds what the RFC says about npm, pnpm and others. The earlier, hardened prototype, which also did what [Phase 1b](phase-1b-credential-hardening.md) now describes (transport, `http:`, redirects, the HTTP cache index, error responses) and located files by device and inode, is kept on the branches `token-helper-hardened` of npm-registry-fetch and npm/cli and `phase-1-hardened` of this repository; 1b grows from them, and nothing below is claimed about those parts.

## Where the code is

| Repository | Size | What it adds |
|---|---|---|
| npm-registry-fetch | 100 lines added in `lib/` (`git diff --numstat 6b4159a 2e27571 -- lib`, counted on 2026-10-22 at the commit 2e27571; the patch in `poc/patches` has the same 100) and 32 of README | the callback seam `opts.getAuthorization({ regKey, uri })`: `lib/auth.js` walks the registry keys of the request as it does for a stored credential (the URL's keys from the longest up, then the registry's for a URL on its host) and asks the function for each, stopping at the first key that holds a stored credential which sets `Authorization` (a token, `_auth`, a username and password; a certificate and key alone do not stop it); `regFetch()` waits for it while watching the request body, skips it for `--offline` and `forceAuth`, and sends the value it returns as the `Authorization` header; `getAuth.supportsGetAuthorization` is `true`. No process code |
| npm/cli | 769 lines added in `lib/` and `workspaces/config/lib/` (`git diff --numstat ae98c62 f63848b -- lib workspaces/config/lib`, same date; 446 of them the runner) and 65 of docs, in two commits: the core (d2fdc47) and the follow-up (f63848b: `login`, `logout` and `profile` messages, a helper-aware hint for a 401, and the extra diagnostics of the runner: `#!` interpreter, status 127 and 9009, `.ps1` and `.js` on Windows) | the runner `lib/utils/token-helper.js` on `@npmcli/promise-spawn`, config trust (only the user and global files; not when project config chose them (`userconfig`, `globalconfig`, `prefix`), nor when the command line or the environment put the file, by a path that is not the default, inside the project by real path; the marker for a child npm), the `//<registry>/:tokenHelper` key in the flat options and the `getAuthorization` function `lib/npm.js` builds from it (and its refusal to start a command when the library lacks the option, with the dependency floor `^20.1.0`), `publishConfig` filtering, `publish`, `whoami`, `config set`, the OIDC mask, docs |

Both are published as [patches](poc/patches) against upstream commits (npm-registry-fetch one commit, npm/cli an mbox of two, applied with `git am`), and each comes with tests. Lines are counted as added lines of the diff in each patch outside `test/`.

Coverage: tap's check fails `npm test` below 100%, and CI runs it wherever `npm test` runs.

- npm-registry-fetch and `@npmcli/config`: on every run.
- The rest of npm/cli: only inside the `full-suites` job, which runs each suite's `npm test` with and without the prototype and counts a suite that fails with no failing test file as a regression, but only where the base passes. A coverage shortfall in a suite that already fails on the base is not caught.
- The workflow's targeted step for the npm/cli files the prototype changes runs with `--no-coverage` and checks no coverage; the runner's own file has 100% in a local run of its test.

## How it is checked

| Check | What it shows | Where |
|---|---|---|
| Unit tests | every rule in the RFC; coverage is enforced by tap, as described above. The runner's tests replace `@npmcli/promise-spawn` with a fake process, so they cover the Windows and POSIX branches on every OS, and run one real helper | the patches |
| End to end | a real npm against a local registry: helpers in user config work; project, `publishConfig` and child-process routes are refused; a helper beats a stored `_authToken` with one warning, and an OIDC token beats a helper; a failing helper is npm's error with npm's own exit status; a helper that runs npm starts no helper in it; `NODE_OPTIONS` from a project reaches no helper, also one npm further down; redirects, a foreign tarball, a repository's proxy and an `http:` registry treat the credential as a stored token's. The script lists each check and fails on any that does not pass | [`poc/npm-e2e/run.js`](poc/npm-e2e/run.js) |
| Helper output fuzz | what a helper printed becomes the same header in the runner and in the Python model, or both refuse it, and a refusal quotes none of it; the helper's exact token is never in what is logged of stderr, and no control character is; a `tokenHelper` value is accepted or refused as the model says. The runner is driven through the factory npm uses, with a stub config, and only the process replaced | [`tests/fuzz_helper.py`](tests/fuzz_helper.py) with [`poc/helper-fuzz/bridge.js`](poc/helper-fuzz/bridge.js), and its own tests in [`tests/test_helper_differential.py`](tests/test_helper_differential.py) |
| Awkward names | helpers named as awkwardly as the file system allows, in directories named so, run for real: each runs as itself and nothing else, a `.cmd` path with `"`, `%` or `!` is refused | [`poc/helper-fuzz/names.js`](poc/helper-fuzz/names.js) |
| Platform probes | helper path spellings on Windows (trailing space or dot, slashes, `\\?\`, letter case, 8.3 names), `cmd.exe` special characters, the refusals for `"`, `%`, `!`, a `.ps1` or `.js` file and a directory longer than 258 characters, missing `#!` interpreters; on Windows also on an SMB share, where a helper is a UNC path | [`poc/platform-probes/run.js`](poc/platform-probes/run.js) |
| Every npm/cli suite | the root and its 16 workspaces (the four named in the root `package.json` plus the 12 under `workspaces/` at the base commit) pass with the prototype wherever they pass without it | [`poc/full-suites/compare.js`](poc/full-suites/compare.js) |
| Claims | every piece of evidence this file, [phase-2-conformance.md](phase-2-conformance.md) and [sources.md](sources.md) cite still exists | [`poc/claims/check.js`](poc/claims/check.js) |

The [CI workflow](.github/workflows/prototype.yml) runs all of it on macOS, Linux and Windows, with Node 22.22.2, 24.15.0 and 26.x, except the comparison of every npm/cli suite with and without the prototype, which runs on Ubuntu and Windows with Node 24; on 26.x the prototype's own code runs with deprecations as errors.

Retired with the split, and kept on `phase-1-hardened`: the 2048-combination config matrix, the trust fuzzer and the spelling fuzzer, the probes for containment by device and inode (letter case, Unicode forms, linked temp directories, FAT32 volumes), and the end-to-end checks for transport, `http:`, redirect hops, error responses and the cache. Phase 1a has no rule about where a file lies, so nothing is left for them to decide; the 1b ones return with 1b.

What the macOS runs showed about the platform: a helper script without a `#!` line fails with ENOEXEC there, while Linux runs it through `/bin/sh`. The probes assert it (macOS, and Linux for the second half); the earlier probes' findings about case, Unicode forms and `/var` links concerned containment and are on the hardened branch.

## Reproducing the checks

The `token-helper` branches are not published; the prototype is the two patches in [poc/patches](poc/patches), made against fixed upstream commits. These are the steps of the [CI workflow](.github/workflows/prototype.yml) (`NPM_CLI_BASE`, `NPM_REGISTRY_FETCH_BASE` and the `prototype` job), in a POSIX shell, starting in an empty working directory that holds a checkout of this repository as `rfc`. The Windows runs also set `core.longpaths` (npm/cli has fixtures deeper than its path limit) and `core.autocrlf false` (the patches have LF endings). Use Node 22.22.2, 24.15.0 or 26.x, and Python 3.12 with `jsonschema` for the Python step.

```sh
git config --global core.autocrlf false
git config --global core.longpaths true      # Windows only
NPM_CLI_BASE=ae98c62586b6fea44114f72e249e246a2981de70
NPM_REGISTRY_FETCH_BASE=6b4159a2519ce5aab26cc4dd8d4596a0b47781d2

# npm-registry-fetch at its base commit, with the patch applied
git init -q npm-registry-fetch
(cd npm-registry-fetch &&
  git fetch -q --depth 1 https://github.com/npm/npm-registry-fetch.git "$NPM_REGISTRY_FETCH_BASE" &&
  git checkout -q FETCH_HEAD &&
  git -c user.name=ci -c user.email=ci@localhost am -q ../rfc/poc/patches/npm-registry-fetch.patch &&
  npm install --ignore-scripts --no-audit --no-fund &&
  npm test --ignore-scripts && npm run eslint --ignore-scripts)

# npm/cli at its base commit, dependencies installed, then the two commits of
# the patch (it raises the npm-registry-fetch floor to ^20.1.0, which is not
# published, so the install comes first)
git init -q npm-cli
(cd npm-cli &&
  git fetch -q --depth 1 https://github.com/npm/cli.git "$NPM_CLI_BASE" &&
  git checkout -q FETCH_HEAD &&
  node scripts/resetdeps.js &&
  git -c user.name=ci -c user.email=ci@localhost am -q ../rfc/poc/patches/npm-cli.patch &&
  node . test --ignore-scripts --workspace @npmcli/config)

# the checks that need the trees (the end-to-end run overlays the prototype's
# npm-registry-fetch on npm/cli's bundled copy and undoes it before it exits)
node rfc/poc/npm-e2e/run.js npm-cli npm-registry-fetch
node rfc/poc/platform-probes/run.js npm-cli
node rfc/poc/helper-fuzz/names.js npm-cli
(cd rfc && python3 -m tests.fuzz_helper --prototype ../npm-cli --seconds 20 --seed 1)
node rfc/poc/claims/check.js npm-cli npm-registry-fetch
```

The workflow also runs the npm/cli files the prototype changes with `node node_modules/tap/bin/run.js --no-coverage` (the step "Test the npm-cli files the prototype changes"), and its `full-suites` job builds a base tree and a patched tree and compares every suite (`node rfc/poc/full-suites/compare.js base next`; the job allows 150 minutes, and its tree setup is in the workflow). With `NPM_CLI=<npm-cli checkout>` set, `python -m unittest discover` also runs the helper comparison of [`tests/test_helper_differential.py`](tests/test_helper_differential.py).

[`poc/full-suites/compare.js`](poc/full-suites/compare.js) is run by CI and counts a test file as a regression only when it fails all three reruns with the prototype and passes all three without it. A file that fails one or two of the three is listed under "failed once, not every time" and the run still passes: a regression that shows up only intermittently is not caught by the gate, so the list has to be read.

## Rule by rule

Each statement of Phase 1a about the prototype is pinned to a test or a check, written as `kind: text`. [`poc/claims/check.js`](poc/claims/check.js) confirms in CI that each one still exists, so a renamed or deleted test fails instead of leaving a claim without evidence.

What the check proves: it finds the text as a substring of the files of its kind. It does not run the test, and finding the text does not show that the test asserts what the row says: that is for the row's wording and for a reader of the test.

Kinds: `fetch` is a test title in npm-registry-fetch `test/auth.js`; `config` a test title in npm-cli `workspaces/config/test/`; `cli` a test title in npm-cli `test/lib/`; `e2e` a scenario or a check in [`poc/npm-e2e/run.js`](poc/npm-e2e/run.js); `probe` a check (not an `info` line) in [`poc/platform-probes/run.js`](poc/platform-probes/run.js).

### Where `tokenHelper` may come from

| Claim | Evidence |
|---|---|
| Honoured from user and global config only; ignored with a warning in project config, env and cli | `config: tokenHelper is honored only from user and global config`, `e2e: project-config` |
| A user or global file is not trusted when project config sets `userconfig`, `globalconfig` or `prefix`, however the key is spelled after `${VAR}` expansion; the same settings from the command line or the environment are the user's own | `config: a user or global file that project config chose cannot configure a tokenHelper`, `config: userconfig spelled through an expansion`, `config: the same settings from the command line are the user`, `e2e: project-redirects-userconfig`, `e2e: child-project-globalconfig` |
| A user or global file whose path the command line or the environment chose, and whose real path is inside the project (`--userconfig` or `NPM_CONFIG_USERCONFIG` into the checkout, `npm ci --prefix sub`, `NPM_CONFIG_PREFIX` or `PREFIX` into it, a link from outside), is not trusted; a chosen file outside the project, a default path inside it (`HOME` is the checkout) and a prefix in the environment outside it are the user's | `config: a user or global file that the command line or the environment put inside the project is not trusted`, `config: --userconfig into the checkout`, `config: NPM_CONFIG_USERCONFIG into the checkout, as a CI job writes it`, `config: npm ci --prefix sub: the global file is sub/etc/npmrc`, `config: NPM_CONFIG_PREFIX into the checkout`, `config: PREFIX into the checkout`, `config: --globalconfig into the checkout`, `config: a link from outside the project to a file inside it`, `config: files outside the project, and a default path inside it, stay the user`, `e2e: prefix-sub-global-file`, `e2e: env-userconfig-into-the-checkout`, `e2e: env-prefix-into-the-checkout`, `e2e: userconfig-flag-into-the-checkout` |
| A child npm is told which files the parent did not trust, and only when one of them has a helper | `config: a child npm keeps distrusting files its parent did not trust`, `config: a file without a helper is never marked`, `config: a child npm is told which config files the parent did not trust for a token helper`, `e2e: parent-runs-child` |
| npm started by a repository's scripts (`npm run` in the repository or a workspace, `npm exec -c`, a script that drops the marker but stays in the project) gets no helper from a repository-chosen file; a script that drops the marker and leaves the project is outside what the rule can stop | `e2e: the child npm reaches the registry`, `e2e: the repository file supplies no credential to it`, `e2e: a script that drops the marker and starts npm outside the project reaches the registry`, `e2e: a script that drops the marker and starts npm outside the project gets the repository file` (asserted: the helper of the repository file is used, which is the stated limit) |
| `publishConfig` cannot supply a helper | `cli: publishConfig cannot supply a tokenHelper`, `e2e: publishConfig-helper` |
| pnpm's unscoped, slash-less and per-package-scope forms are warned about and not fatal, each with the line to write; `config set` refuses the unscoped form and project config | `config: pnpm-only tokenHelper forms get a pointer to the registry form and are not fatal`, `config: the unscoped form names the key for the registry the same file sets`, `config: the slashless key, as pnpm documents it, names the key to write`, `cli: config set tokenHelper` |
| What `getAuthorization` is made from is the trusted map only; a `//<registry>/:tokenHelper` key among the options is not a helper | `config: as tokenHelpers, never as a config key`, `cli: flatOptions.getAuthorization runs the token helper of user config`, `cli: flatOptions has no getAuthorization without a token helper` |

### Running the helper

| Claim | Evidence |
|---|---|
| A helper's output becomes the same Authorization value in the runner and in the Python model, or is refused by both, and a refusal quotes none of it; a `tokenHelper` value is accepted or refused (not absolute, arguments, not found) the same way by both, on a tree of real files | [`tests/fuzz_helper.py`](tests/fuzz_helper.py), run in the `prototype` workflow on each OS and Node version |
| An absolute path with no arguments; anything else refused with `ETOKENHELPER` and a message that says what to do: a two-line script for arguments, an absolute path for a bare name, a `.cmd` wrapper for a `.ps1` or `.js` file on Windows | `cli: values that are not an absolute path with no arguments say what to do`, `probe: a .ps1 helper is refused and a .cmd wrapper suggested`, `probe: a .js helper is refused and a .cmd wrapper suggested` |
| A value that is not an existing file is never printed, in the refusals, the failures, `login`, `logout` and the config warnings: the message names the key and says the value is not shown (a pasted base64 token with `/` included) | `cli: a value that is not an existing file is never shown`, `cli: tokenHelper that is not a file is not shown`, `cli: tokenHelper logout does not show a value that is not a file`, `config: pnpm-only tokenHelper forms get a pointer to the registry form and are not fatal`, `e2e: pasted-token-is-not-shown`, `e2e: pasted-token-login` |
| `.cmd`/`.bat` through `cmd.exe` on Windows only; a path with `"`, `%` or `!` refused there, and a directory longer than 258 characters; `& ^ ; ( ) ' , =`, spaces and non-ASCII in the directory reach the helper unchanged and inject nothing | `cli: a Windows .cmd or .bat helper runs through cmd.exe with a quoted path`, `cli: an exclamation mark or a long path is fine where cmd.exe is not involved`, `probe: a .cmd helper with a double quote in its path is refused with a reason`, `probe: a helper in a directory longer than 258 characters is refused with a reason`, `probe: is refused with a reason`, `probe: runs as itself, in its own directory`, [`poc/helper-fuzz/names.js`](poc/helper-fuzz/names.js) (helpers named with `& ^ ( ) , ; = '` and spaces, in directories named so, run as themselves and nothing else, `%` and `!` refused; on Linux and macOS names with `$ ` ; & | ' " * ? [`, a newline or a leading dash are only names) |
| On Windows a helper path through a directory with a space, in another letter case, with forward slashes or through an 8.3 short name runs the file it names; one with a trailing space or dot or a slash after the file name is refused; none runs another file beside it, on NTFS and on an SMB share | `probe: a .cmd helper in a directory with a space in its name is refused or runs that file`, `probe: a helper path with a trailing space, where a file with that name exists beside the decoy, is refused or runs the file it names`, `probe: a helper path with a trailing dot, where a file with that name exists beside the decoy, is refused or runs the file it names`, `probe: a helper path with a slash after the file name is refused or runs nothing`, `probe: a helper path in another letter case is refused or runs that file`, `probe: a helper path through an 8.3 short directory name is refused or runs that file` |
| A `.cmd` or `.bat` helper on an SMB share (`\\host\share`) starts in the Windows directory, not its own: cmd.exe takes no UNC working directory. It is still not the repository | the SMB run of the platform probes (`info a .cmd helper in … started in`) |
| Starts in its own directory with stdin closed | `cli: the helper has no input, its own directory and its own environment`, `probe: runs as itself, in its own directory` |
| No `npm_config_*` variables; `NODE_OPTIONS`, `EDITOR`, `NODE_ENV` and `COLOR` as the user's environment had them when npm started, or absent; a value an npm started by npm inherited from its parent's config is npm's too, recognised by what the parent exported (`NODE_ENV` while `npm_config_omit` holds `dev`, or `production`, or `only` is `prod`; `COLOR` of `0` or `1` below a parent npm) | `cli: the environment`, `e2e: project-node-options`, `e2e: the repository code never ran in the helper`, `e2e: nested-node-options`, `e2e: the child npm sends the helper token`, `e2e: nested-node-env-and-color`, `e2e: and got neither the NODE_ENV nor the COLOR its parent set` |
| `PATH` without what npm put in front of it for a script (run-script's block of `node_modules/.bin` directories and its `node-gyp-bin`, a nested run's repeat, the `node_modules/.bin` of the working directory and its parents); a `node_modules/.bin` the user put on `PATH` elsewhere stays; exit 127 or 9009 names the reason | `cli: PATH loses what npm added for a script`, `cli: a signal, a missing tool and a spawn error each say what happened` (unit tests of the environment built, not a run of a script calling a shadowed tool) |
| A helper that runs npm gets an npm that fails with `ETOKENHELPER` where it would have run a helper (the guard is `NPM_INTERNAL_TOKEN_HELPER_RUNNING`, a name nobody sets by accident); an npm that needs no helper is unaffected | `cli: nothing runs for a registry without a helper`, `cli: a helper\'s own npm fails instead of running a helper`, `e2e: recursion-guard`, `e2e: and failed with ETOKENHELPER, saying a token helper` |
| Lazily, once per registry per process, failures cached; a refusal of the value is cached with them, so the file system is looked at once | `cli: one run per registry, and a failure counts`, `cli: a refusal is looked up once per registry` |
| A helper configured with an npm-registry-fetch that cannot ask for it fails the command with `ETOKENHELPER`, except `config`, `help` and `completion`; the dependency floor is `^20.1.0` | `cli: a token helper with an npm-registry-fetch that cannot ask for it fails loudly`, `fetch: getAuth says it serves opts.getAuthorization` |
| Not for `--offline` | `fetch: is not asked offline or with forceAuth` |
| Raw token → `Bearer`; output starting with a scheme used as is; trimmed, BOM removed (pnpm's install path trims the end only; npm trims the start too, for the BOM); the mapping follows pnpm's rule as read in [its source](https://github.com/pnpm/pnpm/blob/fe4a0c232384289de82be3d502896ca7e070050c/pnpm11/network/auth-header/src/getAuthHeadersFromConfig.ts#L103-L112) | `cli: a raw token is sent as a Bearer token, a scheme as it is` |
| Output that is not a valid header value refused without quoting it | `cli: output that is not a header value is refused without quoting it` |
| 60 s deadline; SIGTERM then SIGKILL 2 s later; whole tree on Windows (the last by `taskkill /pid N /T /F`: the test injects `taskkill`, so it pins the command line and the fallback to ending the process, not that a real process tree dies); a helper that already exited is not signalled | `cli: the time limit: SIGTERM, then SIGKILL, and the request fails at once`, `cli: on Windows the whole process tree is ended`, `cli: a helper that already exited is not signalled` |
| More than 1 MiB on either stream ends the helper at once, and what it writes later is ignored | `cli: an overflow of either stream ends the helper at once`, `cli: a late result after the helper was stopped is ignored` |
| Read 250 ms more after exit while a background process holds stdout, and not wait for the process | `cli: a helper that left a process holding its pipes does not keep npm waiting` |
| A missing `#!` interpreter is named; status 127 or 9009 says a tool was not found | `cli: a missing #! interpreter is named`, `probe: a missing #! interpreter is named` |
| stderr shown as warnings when the helper fails and at `verbose` when it works; the helper's exact token, and what follows its scheme, replaced by `***`; control characters removed | `cli: stderr: the exact token is hidden, control characters go, warn on failure, verbose on success`, `e2e: the helper token echoed on stderr is hidden`, [`tests/fuzz_helper.py`](tests/fuzz_helper.py) (the runner's logged lines against the helper's token, whole and without its scheme, in random shapes of output and stderr; measured once, recorded 2026-10-18 for the pre-split masking, not re-run by CI, which runs the fuzzer for 20 s with a seed of its own) |
| A failure is `ETOKENHELPER` and carries the helper's status as `helperExitCode` and `signal`, never its output; npm exits as for any of its errors, not with the helper's status; no other credential is tried | `cli: a failure names the helper, carries helperExitCode and signal and never the output`, `cli: a failing helper does not set npm`, `e2e: view fails with ETOKENHELPER`, `e2e: npm exits with its own status`, `e2e: no request is sent, with the stored token or without` |

### Which requests get the credential

| Claim | Evidence |
|---|---|
| The seam is called with `{ regKey, uri }`, asks for the registry keys a stored credential would be looked up under, longest first, then the registry's for a URL on its host, and for no other host; it stops at a stored credential that sets `Authorization`, not at a certificate and key alone (mTLS) | `fetch: is given an object with the key and the URL of the request`, `fetch: an mTLS pair at a longer key does not shadow the function at a shorter one`, `fetch: is asked for the keys a stored credential would match, longest first`, `fetch: a tarball on the registry host is matched through the registry keys`, `fetch: a tarball on another host is not matched through the registry` |
| The value is the header as returned; an error from the function rejects the request as it is; a body that fails while it runs rejects the request, and a stream is sent after it | `fetch: the value is the header, as is`, `fetch: an error from the function rejects the request as it is`, `fetch: a body that fails while the function runs rejects the request`, `fetch: a body that is a stream is sent after the function is done` |
| The credential travels as a stored `_authToken` does: a redirect to another host name, a tarball on another host or port, a repository's proxy and an `http:` registry on a network address are each treated as the same request with a stored token is treated (the controls show the stored token takes that route) | `e2e: the request reached the other host`, `e2e: it carries what a stored token would`, `e2e: control: a stored token goes through the repository`, `e2e: the helper token is treated the same`, `e2e: control: a stored token goes over the same http: registry`, `e2e: so does the helper token` |

### Precedence and commands

| Claim | Evidence |
|---|---|
| A helper wins over a stored token for the same key, with one warning per registry naming what is ignored; a token stored under a longer key wins | `fetch: wins over a stored token for the same key`, `fetch: a stored token under a longer key wins`, `config: getCredentialsByURI reports a tokenHelper ahead of a stored token`, `cli: the helper wins over a stored credential, with one warning per registry`, `e2e: helper-beats-stale-token`, `e2e: npm warns once, naming the _authToken it ignores` |
| OIDC trusted publishing wins over a helper, and the exchange does not use it | `cli: a configured tokenHelper is masked while the OIDC token is in use`, `e2e: oidc-beats-helper`, `e2e: the PUT carries the OIDC token`, `e2e: no request carries the helper token` |
| `publish` and `whoami` count a helper as a login | `cli: a tokenHelper in user config satisfies the login check`, `cli: a tokenHelper counts as being logged in`, `e2e: publish-with-helper-only` |
| `logout` explains, names a stored token, revokes nothing | `cli: tokenHelper logout explains instead of claiming no login`, `cli: tokenHelper logout names a token stored beside the helper`, `e2e: logout-with-helper` |
| `login` refuses, also for a scoped registry | `cli: tokenHelper refuses instead of saving a token it would shadow`, `cli: tokenHelper on a scoped registry refuses a scoped login`, `e2e: login-with-helper` |
| A 401 while a helper is configured says the helper's token was refused and to refresh the tool behind it, not `npm login` | `cli: 401 with a token helper for the registry` |

### The rest of npm

| Claim | Evidence |
|---|---|
| The prototype breaks nothing else: every npm/cli suite (the root and 16 workspaces, smoke tests included) passes with it wherever it passes without it, with npm running on the prototype's npm-registry-fetch | [`poc/full-suites/compare.js`](poc/full-suites/compare.js), the `full-suites` job on Ubuntu and Windows; a file that fails once is rerun three times in both trees before it counts |

## Limits

Not a list of things left to do: each is outside what the Phase 1a checks claim, for a reason, and each says what would make the claim wider. How a credential travels (transport, `http:`, redirects, the HTTP cache index, error responses) is [Phase 1b](phase-1b-credential-hardening.md)'s, and for 1a the claim is only that a helper's credential does what a stored token's does.

| Not claimed | Why | Wider if |
|---|---|---|
| That a helper's credential is hidden from stderr in every encoding: its exact token, and what follows its scheme, is replaced; base64, JSON-escaped, a credential split over lines or cut short are not | The helper is the user's own program and already holds the credential: a helper that encodes it on purpose cannot be stopped by what npm does to its stderr, and guessing at forms gives false positives (an error that says "Token expired" must stay readable) | A helper family is found that writes its credential in another form by default |
| That a registry's error response, the HTTP cache index, a repository's proxy and certificates, `http:` and redirects treat a helper's credential better than a stored token's | They are the same rules for every credential, and a rule that held a helper to more than the token it replaces would settle for one credential a question that belongs to all | [Phase 1b](phase-1b-credential-hardening.md) is adopted |
| That the end-to-end run shows these against a real https registry: it has no TLS listener, so the parity checks are made over `http:` | A listener with a certificate the run trusts costs a generated key pair per run on every OS, and what 1a claims is parity with a stored token, which the same route shows | The run gains a TLS listener |
| That a script which drops the marker and starts npm outside the project gets no helper from a repository-chosen file | The repository's own code is already running as the user and could run the helper itself; asserted as it is (`e2e: a script that drops the marker and starts npm outside the project gets the repository file`) | [Phase 1b](phase-1b-credential-hardening.md) stops a project from naming the files at all |
| That a file's location matters: a home directory that is the checkout, a `--prefix` or environment value pointing into a repository, and a file a project did not choose but a script of it can change are the user's own | The rule is about who chose the file, not where it lies, which needs no filesystem identity and no spellings; a user who points npm at a file in a checkout has chosen it | [Phase 1b](phase-1b-credential-hardening.md) |
| That a nested npm's helper gets the user's own `NODE_ENV` or `COLOR` when the user set the same value the parent's config would set (`NODE_ENV=production` with `--omit=dev` exported, `COLOR` of `0` or `1`) | A value that is what the parent set is dropped, because it cannot be told from the user's; the helper then gets none | The parent marks what it set |
| That a user or global file outside `localPrefix` but inside the checkout (a sibling package of a monorepo that is not the root) is refused when the command line or the environment chose it | The rule compares against npm's own project root and needs no walk up the tree or inode comparison | [Phase 1b](phase-1b-credential-hardening.md) |
| That a global file under an explicit `--prefix X` is trusted | The root is then `X`, so the file is refused, which also costs a user's own `npm -g --prefix ~/.npm-global` its helper in that global file; the user file is unaffected | [Phase 1b](phase-1b-credential-hardening.md) |
| That a helper in a directory others can write is not run | The helper is the user's program at a path the user chose; checking ownership and modes differs on each platform | A platform check is specified |
| That a repository cannot make npm run the user's helper (its `registry=` or a lockfile `resolved` URL naming a host the user configured a helper for) | The credential is the user's for that host, as a stored `_authToken` for it is | [Phase 1b](phase-1b-credential-hardening.md) restricts where any credential goes |
| That only the npm-registry-fetch npm itself resolves is checked for the option | A library bundled under a dependency with its own copy is not asked | The check follows each copy |
| A real run of a helper other than a `.cmd` on Windows and a `sh` script elsewhere, and a real run that ends a whole process tree | The runner's tests replace the process, and the end-to-end run uses one kind of helper per OS | A run per kind of helper |

## Audit history

The history of the pre-split prototype, kept as it was written. Its code is on the hardened branches; the rule each finding broke is covered in 1a where 1a still has the rule (the trust rows above, the helper's environment, output handling, the process limits) and in [Phase 1b](phase-1b-credential-hardening.md) where it moved.

Not pinned, because it cannot be reproduced now: the counts and what a round found in code that no longer exists (the 112 failing combinations of round 5 on the earlier fix, what the fuzz runs found before their fixes). Not tested at all: round 6's corrections to the RFC on Cargo, user presence during a publish and interactive timeouts, which are document edits resting on the sources in [sources.md](sources.md).

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
| Fuzz | the output of a helper against the Python model, and what is logged of its stderr against its token ([`tests/fuzz_helper.py`](tests/fuzz_helper.py)); helpers named awkwardly, run for real ([`poc/helper-fuzz/names.js`](poc/helper-fuzz/names.js)) | a credential the helper echoed as JSON, in a shell's quotes or percent-encoded was logged; the pre-split prototype hid each of those forms, and 1a keeps only the exact token ([notes](#fuzz-notes)) |
| Final | review of the whole proposal | npm-registry-fetch ran a helper named by any `//<registry>/:tokenHelper` key in its options, and other tools (npm-check-updates) pass a project's `.npmrc` keys there; helpers now arrive only through trusted config, and the library runs none |
| Split | three critics, 2026-10-22 | the hardening of every credential's route had grown into the helper and held it to a stricter rule than the stored token it replaces; filesystem-identity containment and fourteen-encoding masking were machinery for rules that a narrower trust rule and exact masking made unnecessary. Split into Phase 1a (this prototype) and Phase 1b; the evidence for the removed parts is retired with them |

| 2nd review | critics of the prototype, 2026-10-22 (the second round of decisions) | a user or global file chosen by the command line or the environment (`npm ci --prefix sub`, `NPM_CONFIG_USERCONFIG` into the checkout) could come from the repository and define a helper; the library's key walk stopped at an mTLS entry; the callback took a bare key; an old library ignored the option silently; a refusal hit the file system on every request; a nested npm's helper got its parent's `NODE_ENV` and `COLOR`; the recursion guard's name could be set by a user and it skipped quietly; messages printed a value pasted into the setting |

#### Fuzz notes

- The pre-split prototype hid the helper's own token only as it is at first, so a token with a quote, a backslash or a character a URL escapes got through when the helper echoed it as JSON, inside a shell's quotes (`set -x`) or percent-encoded. 1a does not hide those forms: they are what a helper that encodes on purpose does, and the Limits row says so.
- The header the prototype makes and the model makes agreed on 242 000 outputs in a run of 60 s, with nothing leaked (measured once on the pre-split prototype, recorded on 2026-10-18, not re-run by CI, which runs the fuzzer for 20 s with a seed of its own).
- `names.js` on Windows tried helper paths with `&`, `^`, `(`, `)`, `!` and a second command among the names in directories named so: those with no `"`, `%` or `!` ran as themselves and nothing else ran, and the others were refused. CI runs `names.js` on each OS.
