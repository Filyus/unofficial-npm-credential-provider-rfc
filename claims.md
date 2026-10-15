# Evidence for the RFC's claims

Every checkable statement in [rfc-credential-provider.md](rfc-credential-provider.md), and what backs it. External facts were checked against the source on the date given. Statements about the prototype are pinned to a test or a check, written as `kind: text`; [`poc/claims/check.js`](poc/claims/check.js) confirms that each one still exists, so a renamed or deleted test fails CI instead of leaving a claim without evidence.

Kinds: `fetch` is a test title in npm-registry-fetch `test/token-helper.js`; `config` a test title in npm-cli `workspaces/config/test/`; `cli` a test title in npm-cli `test/lib/`; `e2e` a check in [`poc/npm-e2e/run.js`](poc/npm-e2e/run.js); `probe` a check in [`poc/platform-probes/run.js`](poc/platform-probes/run.js); `spec` a key in [`spec/policy-v1.json`](spec/policy-v1.json); `py` a test module in [`tests/`](tests).

## External facts (checked 2026-10-15)

| Claim | Source | How it was checked |
|---|---|---|
| Shai-Hulud (September 2025) spread by stealing maintainer tokens and publishing infected versions; RFC 0054 records it | [RFC 0054](https://github.com/npm/rfcs/blob/main/accepted/0054-make-scripts-install-opt-in.md) | read: Motivation names it, dated September 2025, 500+ packages |
| CodeArtifact tokens: 12 h default, 15 min to 12 h | [GetAuthorizationToken](https://docs.aws.amazon.com/codeartifact/latest/APIReference/API_GetAuthorizationToken.html) | read: "between 900 (15 minutes) and 43200 (12 hours)" |
| Artifact Registry access tokens last 60 minutes | [GAR npm auth](https://docs.cloud.google.com/artifact-registry/docs/nodejs/authentication) | read |
| `vsts-npm-auth` writes a token into the user `.npmrc`; Azure feeds use username + base64 PAT | [Azure Artifacts npmrc](https://learn.microsoft.com/en-us/azure/devops/artifacts/npm/npmrc?view=azure-devops) | read |
| `glab artifact-registry login --docker` is a credential helper; `--npm` writes `_authToken`, 15 min default, 12 h max | [glab login](https://docs.gitlab.com/cli/artifact-registry/login/) | read |
| `npm login` issues two-hour session tokens; classic tokens revoked (2025-12-09) | [GitHub Changelog](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/) | read |
| New write-enabled granular tokens default to 7 days (2025-09-29); granular write tokens capped at 90 days (2025-11-05) | [2025-09-29](https://github.blog/changelog/2025-09-29-strengthening-npm-security-important-changes-to-authentication-and-token-management/), [2025-11-05](https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes/) | read |
| Bypass-2FA tokens lost account actions on 2026-07-31; their direct publish is due to go in January 2027 | [GitHub Changelog 2026-07-31](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/) | read |
| npm 9 stopped accepting auth settings not scoped to a registry | [npm v9.0.0 release](https://github.com/npm/cli/releases/tag/v9.0.0) | read: "auth related settings that are not scoped to a specific registry … no longer supported" |
| npm 12 warns about an unknown `.npmrc` key ("This will stop working in the next major version of npm") and errors under `strict-npmrc` | npm/cli `lib/base-cmd.js` at 83ea1a1; [PR 9729](https://github.com/npm/cli/pull/9729) | read the source |
| npm/cli issue 8141: 41 👍, no comments, `Priority 1` added by nkolev92 on 2026-10-01 | [issue](https://github.com/npm/cli/issues/8141) | GitHub API, issue and timeline |
| pnpm runs `tokenHelper` in its TypeScript CLI and its Rust rewrite | `pnpm11/network/auth-header/src/getAuthHeadersFromConfig.ts`, `pnpm/crates/network/src/token_helper.rs` in [pnpm/pnpm](https://github.com/pnpm/pnpm) | read the source |
| pnpm maps output with `/^[A-Z]+ /i` to a header as is, else `Bearer`, after `trimEnd()` | `getAuthHeadersFromConfig.ts` (2026-09-30) | read the source |
| pnpm's parser splits the value on whitespace into a command and arguments | `pnpm11/config/reader/src/parseCreds.ts` | read the source |
| pnpm's key parser accepts `//host/:@scope:tokenHelper`; docs show the form for `_authToken` (11.7) | `getNetworkConfigs.ts` `AUTH_SUFFIX_RE`; [pnpm npmrc](https://pnpm.io/npmrc) | read |
| pnpm rejects `tokenHelper` in project config with an error | [pnpm issue 12759](https://github.com/pnpm/pnpm/issues/12759) | read |
| pnpm 11.4 pins an unscoped `tokenHelper` to the registry declared in the same file, or to registry.npmjs.org when the file declares none, with a deprecation warning, and intends to remove the form | [pnpm 11.4](https://pnpm.io/blog/releases/11.4); `pnpm11/config/reader/src/rescopeUnscopedCreds.ts` | read the source |
| pnpm's parser refuses `$ % " '` and a backtick in a `tokenHelper` value; pnpm's docs show the per-registry key as `//registry.corp.com:tokenHelper=`, without a slash before the colon | `parseCreds.ts` `RESERVED_CHARACTERS`; `pnpm11/docs/npmrc.md` | read the source |
| Cargo: hello `{"v":[1]}`, `--cargo-plugin`, cache `never`/`session`/`expires`, `operation_independent`, errors incl. `url-not-supported` | [Cargo credential provider protocol](https://doc.rust-lang.org/cargo/reference/credential-provider-protocol.html) | read |
| Cargo operations: read, publish, yank, unyank, owners | `credential/cargo-credential/src/lib.rs` `enum Operation` in [rust-lang/cargo](https://github.com/rust-lang/cargo) | read the source |
| Cargo's chain: `UrlNotSupported` and `NotFound` move on, any other error stops; exhausted, it fails; the stored token is the `cargo:token` entry, and a token the chain does not use is ignored with a warning | `src/util/auth/mod.rs` (`credential_action`, `credential_provider`) in [rust-lang/cargo](https://github.com/rust-lang/cargo) | read the source |
| Cargo asks for a read credential only for a registry whose `config.json` says `auth-required`, or after a 401 | `src/sources/registry/http_remote.rs` (`auth_required`) | read the source |
| Git asks its helpers after a 401, or up front when the URL names a user or `http.proactiveAuth` is set | `http.c` in [git/git](https://github.com/git/git) | read the source |
| NuGet sends `nuget.config` credentials first and asks plugins only after a 401 or 403, passing over a plugin that is not applicable | `HttpSourceAuthenticationHandler.cs`, `CredentialService.cs` in [NuGet/NuGet.Client](https://github.com/NuGet/NuGet.Client) | read the source |
| Stage-only npmjs.com tokens keep dist-tag and deprecate | [GitHub Changelog 2026-09-18](https://github.blog/changelog/2026-09-18-stage-only-npm-tokens-for-safer-automation) | read |
| `npm stage approve` and `reject` prompt for 2FA; every `npm stage` command needs write permission on the package; approve and reject take only a stage id | npm/cli `docs/lib/content/commands/npm-stage.md`, `lib/commands/stage/` at 83ea1a1 | read the source |
| Verdaccio lets the account that staged a version, or anyone who may publish it, reject it | [Verdaccio staged publishing](https://verdaccio.org/docs/staged-publishing) | read |
| `npm publish` runs `prepublishOnly`, `prepack`, `prepare` and `postpack` before the upload, reads the manifest again after packing, and asks for OIDC and OTP after them | npm/cli `lib/commands/publish.js`, `workspaces/libnpmpack`, pacote `lib/dir.js` at 83ea1a1 | read the source |
| npmjs.com documents the reads behind `access`, `team` and `org` (collaborators, visibility, org packages and members, scope teams, team packages and members) and `GET /-/npm/v1/tokens` for session tokens only, and their writes for session, npmAccessToken or granular tokens | [npm registry API](https://api-docs.npmjs.com/), per-operation security | read (documented, not tested live) |
| npmjs.com documents `GET`/`POST /-/package/{pkg}/trust` and `DELETE /-/package/{pkg}/trust/{id}` for npmAccessToken or granular tokens only, and listing trusted publishers as requiring write permission on the package and 2FA | [npm registry API](https://api-docs.npmjs.com/) getTrustedPublishers, addTrustedPublisher, deleteTrustedPublisher | read (documented, not tested live) |
| Every `npm trust` command needs 2FA and write permission, and refuses bypass-2FA tokens and basic auth | [npm-trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/) | read |
| `access set status` reads the visibility back after setting it, and `org rm` lists the members after removing one | npm/cli `lib/commands/access.js` (`#setStatus`), `lib/commands/org.js` at 83ea1a1 | read the source |
| `npm trust` is a command family of its own on `/-/package/<pkg>/trust`; its requests, and `access list collaborators` and `access get status`, pass no `spec` to npm-registry-fetch, while `access set`, `grant` and `revoke` do | npm/cli `lib/commands/trust/`, `lib/trust-cmd.js`, `workspaces/libnpmaccess/lib/index.js` at 83ea1a1 | read the source |
| `get-identity` serves `whoami` and `access list packages`, and the tab completion of `deprecate` and `unpublish` | `git grep get-identity` at npm/cli 83ea1a1 | read the source |
| Verdaccio, GitLab and GitHub Packages implement none of the access, team, org or trust endpoints | Verdaccio `packages/api/src/index.ts`; [GitLab npm API](https://docs.gitlab.com/api/packages/npm/); [GitHub Packages npm](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry) | read |
| `npm token revoke` lists tokens and `npm profile set` reads the profile before writing | npm/cli `lib/commands/token.js` (`rm`), `lib/commands/profile.js` (`set`) at 83ea1a1 | read the source |
| Verdaccio answers 403 to a read-only generated token on DELETE, PATCH, POST and PUT, and to a token used outside its address allowlist | `packages/middleware/src/middlewares/token-auth.ts` in [verdaccio/verdaccio](https://github.com/verdaccio/verdaccio) | read the source |
| npm treats a 401 as a one-time-password challenge when `WWW-Authenticate` names `otp`, when there is no such header and the raw body matches `one-time pass`, or when the header names neither and a non-JSON body matches it; `ipaddress` gives `EAUTHIP` first | npm-registry-fetch `lib/check-response.js`; npm/cli `lib/utils/auth.js` (`otplease`) at 83ea1a1 | read the source |
| An OIDC exchange sends the CI identity token on the exchange request, and npm clears the exchanged token at its next exchange attempt | npm/cli `lib/utils/oidc.js` at 83ea1a1 | read the source |
| `npm login --auth-type=web` posts to `/-/v1/login` and polls the returned done URL for a token; Verdaccio serves the same flow behind `webLogin` | npm-profile 13.0.1 `lib/index.js`; [Verdaccio web login](https://verdaccio.org/docs/web-login) | read |
| The builtin `npmrc` ranks lowest of npm's config files and may set `globalconfig` or `prefix`, which the trust rule accepts since no project chose them | npm/cli `workspaces/config/lib/index.js` at 83ea1a1; the prototype's `#globalconfigSource` | read the source |
| npmjs.com lists granular tokens (`npmAccessToken`, and `granularAccessToken` as its alias) as the security of every `/-/stage` path, naming no tier; it documents 401 on the list and 401 and 404 on the record and the tarball, no 403 on these reads, 403 and `npm-otp` on approve and delete, and that the list returns only items visible to the caller | [npm registry API](https://api-docs.npmjs.com/) | read (documented, not tested live) |
| Short-lived trusted-publishing tokens can be used with `npm stage publish` and `npm publish`, not the other `npm stage` subcommands | npm/cli `docs/lib/content/commands/npm-stage.md` at 83ea1a1 | read the source |
| npm's message for a 404 says the package "could not be found or you do not have permission to access it" | npm/cli `lib/utils/error-message.js` | read the source |
| Cargo starts a provider per request and closes stdin after one response | `src/util/credential/process.rs` (`perform`, `run`) | read the source |
| NuGet: plugins since 4.8; protocol 2.0.0 with a handshake; 5 s handshake and request timeouts, extended by progress; idle shutdown after 1 minute; `Uri`, `isRetry`, `NonInteractive`, `CanShowDialog`; discovery in `~/.nuget/plugins`, `NUGET_PLUGIN_PATHS`, `nuget-plugin-*` on PATH since 6.13 | [cross-platform plugins](https://learn.microsoft.com/en-us/nuget/reference/extensibility/nuget-cross-platform-plugins), [authentication plugin](https://learn.microsoft.com/en-us/nuget/reference/extensibility/nuget-cross-platform-authentication-plugin) | read |
| RFC #850 caches the token in memory for the life of the process | [npm/rfcs PR 850](https://github.com/npm/rfcs/pull/850), step 5 | read |
| `jf atc` (`access-token-create`) takes `--expiry` and prints JSON with `access_token` | `main.go` in [jfrog/jfrog-cli](https://github.com/jfrog/jfrog-cli), `auth/authutils.go` in jfrog-client-go | read the source |
| Starting node takes about 60 ms on Windows 11 | measured 2026-10-15: `node -e 0`, 7 rounds of 10 | local measurement |
| macOS: APFS case-insensitive with realpath returning the stored case; NFD reaches an NFC directory; `/var` links to `/private/var`; a script without `#!` fails with ENOEXEC | `probe: filesystem is case-insensitive`, `probe: realpath of the NFD spelling returns`, `probe: a script without a #! line` | CI on macos-latest |

## Phase 1: where `tokenHelper` may come from

| Claim | Evidence |
|---|---|
| Honoured from user and global config only; ignored with a warning in project config, env and cli | `config: tokenHelper is honored only from user and global config`, `e2e: project-config` |
| A user or global file selected by a project setting is not trusted | `config: userconfig set in the project`, `config: globalconfig set in the project`, `config: prefix set in the project moves the default global file`, `e2e: project-redirects-userconfig` |
| Keys are compared after environment expansion | `config: a key that expands to a selecting setting` |
| globalconfig provenance follows the layer that holds the value in effect | `config: globalconfig set in the project over one from`, `config: a project globalconfig over a user one, with one from`, `config: a trusted user file overrides a project globalconfig` |
| A child npm is told which files the parent did not trust | `config: a child npm keeps distrusting files its parent did not trust`, `config: a child npm is told which config files the parent did not trust for a token helper`, `e2e: parent-runs-child`, `e2e: child-project-globalconfig` |
| npm started by a repository's scripts (`npm run` in the repository or a workspace, `npm exec -c`, a script that drops the marker) gets no helper from a repository-chosen file; a script that drops the marker and leaves the project is outside what the rule can stop | `e2e: the child npm reaches the registry`, `e2e: the repository file supplies no credential to it`, `e2e: a script that drops the marker and starts npm outside the project` |
| A file inside a project is not trusted however chosen, including through a cli or env prefix | `config: a file inside the project chosen by`, `e2e: prefix-into-repository` |
| Projects are every ancestor with package.json or node_modules | `config: a file in an outer project is not trusted from a nested one` |
| Whether a run is global is read only from layers a project cannot write | `config: a cli prefix outside the project in`, `config: does not make a cli prefix global` |
| Containment by device and inode; spellings only for paths that do not exist | `config: a file in the project spelled with`, `config: a file in the project spelled with an 8.3 short name is not trusted`, `config: a directory in the project named ..`, `config: a file under a prefix that does not exist yet, named through a link`, `config: without inode numbers, paths are compared as spelled`, `probe: the project file in another letter case is refused`, `probe: the project file through an NFD spelling is refused` |
| The home directory is not a project; default files stay trusted when a project names them | `config: the default user file is trusted in a home directory that is a project`, `config: a user-chosen file under a home directory that is a project is trusted`, `config: a project .npmrc that names the default user file changes nothing` |
| 2048 combinations of userconfig, globalconfig and prefix from four sources: no project-chosen helper in effect, none lost | [`poc/npm-config-matrix/run.js`](poc/npm-config-matrix/run.js), run in CI on three OSes |
| No spelling of the key in a project or workspace `.npmrc`, `npm_config_*`, a flag or `publishConfig` makes npm use a helper (case, Unicode lookalikes, `${VAR?}`, ini sections and quoting, BOM, CRLF) | [`poc/npm-config-fuzz/spellings.js`](poc/npm-config-fuzz/spellings.js): 2000 spellings in-process, 30 with a real npm and a marker-writing helper, 10 through `npm publish`; positive controls in user config; 500 per CI job |
| `publishConfig` cannot supply a helper | `cli: publishConfig cannot supply a tokenHelper`, `e2e: publishConfig-helper` |
| pnpm's unscoped and per-package-scope forms are warned about and not fatal; `config set` refuses the unscoped form and project config | `config: pnpm-only tokenHelper forms get a pointer to the registry form and are not fatal`, `cli: config set tokenHelper` |
| The unscoped form's warning names the line to write for the file's own `registry=`, or asks for the registry when there is none; a key without a slash before the colon is ignored with a warning naming the key to write | `config: pnpm-only tokenHelper forms are pointed at the exact line to write` |

## Phase 1: running the helper

| Claim | Evidence |
|---|---|
| An absolute path with no arguments; anything else refused with `ETOKENHELPER` | `fetch: a relative path or a command with arguments is refused` |
| `.cmd`/`.bat` through `cmd.exe` on Windows only; `"` or `%` refused there; `& ^ ! ; ( ) ' , =`, spaces and non-ASCII in the directory reach the helper unchanged and inject nothing | `fetch: batch files run through cmd.exe on Windows only`, `probe: runs as itself, in its own directory`, `probe: is refused with a reason` |
| A path with `"` or `%` is refused before `cmd.exe` sees it | `fetch: batch files run through cmd.exe on Windows only`, `fetch: cmd.exe cannot be given a path with a quote or a percent sign` |
| Starts in its own directory | `fetch: a helper does not start in npm`, `fetch: a .cmd helper starts in its own directory` |
| No `NODE_OPTIONS`, `npm_config_*` or other variables npm sets from config | `fetch: a helper gets no NODE_OPTIONS and no npm_config_ variables`, `fetch: own variables are not passed on`, `e2e: project-node-options` |
| Lazily, once per registry per process, failures cached | `fetch: the helper runs once per registry per process`, `fetch: a failed run is cached too`, `fetch: a different registry key runs the helper separately` |
| Not for `--offline` | `fetch: an offline request does not run the helper` |
| Raw token → `Bearer`; output starting with a scheme used as is; trimmed, BOM removed | `fetch: a raw token is sent as a Bearer token`, `fetch: output with an auth scheme is used as the header value`, `fetch: whitespace and a byte order mark around the output are removed`, `fetch: header mapping matches pnpm` |
| Output that is not a valid header value refused without quoting it | `fetch: output that is not a valid header value is refused without quoting it` |
| 60 s deadline; SIGTERM then SIGKILL; whole tree on Windows | `fetch: a helper has 60 seconds by default`, `fetch: a helper that ignores SIGTERM is rejected at the deadline and then killed`, `fetch: killTree on Windows: taskkill for the whole tree` |
| More than 1 MiB of output, counted in written bytes, ends the helper | `fetch: a helper that prints too much is ended`, `fetch: the output limit counts the bytes the helper wrote` |
| Read 250 ms more after exit while a background process holds stdout | `fetch: a helper that exits while a background process holds its stdout` |
| A missing `#!` interpreter is named | `fetch: a script whose interpreter is missing is reported as such`, `probe: a missing #! interpreter is named` |
| stderr shown as warnings; the helper's own token scrubbed, credential-like values masked | `fetch: stderr lines become warnings and the token is never logged`, `fetch: the helper token is hidden wherever stderr repeats it`, `fetch: a printed token never survives into a logged line` |
| A redirect to another host name, and a tarball on another host or port, get no credential; a redirect to the same host on another port gets what a stored token gets | `e2e: the request reached the other host`, `e2e: it carries no more than a stored token would`, `e2e: and no credential at all` |
| The token appears nowhere but the request: output, debug log, timing file, HTTP cache | `e2e: and nowhere else: output, logs, timing, cache` (run for view, publish and whoami at loglevel silly with --timing) |
| A registry that quotes the credential in a 401 body: npm prints and logs it, the same as for a stored `_authToken` | `e2e: a 401 that quotes the credential leaks no more than a stored token does` |

## Phase 1: precedence and commands

| Claim | Evidence |
|---|---|
| A helper wins over a stored token | `fetch: getAuth reports the helper and lets it win over a stored token`, `config: getCredentialsByURI reports a tokenHelper ahead of a stored token`, `e2e: helper-beats-stale-token` |
| OIDC trusted publishing wins over a helper | `cli: a configured tokenHelper is masked while the OIDC token is in use` |
| `publish` and `whoami` count a helper as a login | `cli: a tokenHelper in user config satisfies the login check`, `cli: a tokenHelper counts as being logged in`, `e2e: publish-with-helper-only` |
| `logout` explains, names a stored token, revokes nothing | `cli: tokenHelper logout explains instead of claiming no login`, `cli: tokenHelper logout names a token stored beside the helper` |
| `login` refuses, also for a scoped registry | `cli: tokenHelper refuses instead of saving a token it would shadow`, `cli: tokenHelper on a scoped registry refuses a scoped login`, `e2e: login-with-helper` |

## The rest of npm

| Claim | Evidence |
|---|---|
| The prototype breaks nothing else: every npm/cli suite (the root and 16 workspaces, smoke tests included) passes with it wherever it passes without it, with npm running on the prototype's npm-registry-fetch | [`poc/full-suites/compare.js`](poc/full-suites/compare.js), the `full-suites` job on Ubuntu and Windows; a file that fails once is rerun three times in both trees before it counts |

## Phase 2: numbers and rules in the spec

| Claim | Evidence |
|---|---|
| Request kinds, operations, cache policies, granularities, error kinds | `spec: requestKinds`, `spec: operations`, `spec: cachePolicies`, `spec: granularities`, `spec: errorKinds`, `py: test_spec_consistency` |
| Unknown kinds and operations answered with `operation-not-supported` | `spec: unknownRequestKind`, `py: test_forward_compat_and_timeouts` |
| Timeouts: get 30 s, interactive get 5 min, erase 10 s, login 5 min, logout 30 s, hello 10 s | `spec: getInteractive`, `py: test_forward_compat_and_timeouts` |
| A rejected credential is evicted at every granularity before the retry | `py: test_cache_policy`, `py: test_handshake_and_transcripts` |
| Chain: `not-found` moves on; a global chain that declines falls back to the stored credential with a warning, a per-registry list fails; the opt-in covers `not-found` and a version mismatch only; `npm:token`; `url-not-supported` remembered per provider and registry | `spec: globalChainAllUrlNotSupported`, `spec: storedCredentialEntry`, `py: test_chain_policy` |
| Login and logout end the way `get` ends; an OIDC token asks no provider; the one-time-password classification; a `stage-read` answer never serves the write | `spec: loginAndLogout`, `spec: oidcExchangedToken`, `spec: operationBoundRegardless`, `py: test_chain_rules` |
| Hello `registries` and the registry comparison (segment boundary, host case, default port, path case, scheme only for hello entries, IDN) | `py: test_registry_matching`, `py: test_model_schema_agreement` |
| Messages agree with the JSON schema | `py: test_model_schema_agreement`, `py: test_json_schema` |
| Session reuse: 118 µs per lookup against 10.3 ms per fresh process (instant mock) | [`poc/rust/crates/mock-client/examples/round_trip.rs`](poc/rust/crates/mock-client/examples/round_trip.rs), measured once |

## Not verified

- make-fetch-happen as shipped in npm 12 recording a header named in `Vary` in the cache index: seen in a historical version's source and in an audit probe, not re-read in the current source.
- Which npmjs.com token tiers serve the `/-/stage` reads, and so whether the interim `stage-read` mapping there (a stage-only token without bypass-2FA, under write policy) is needed or works at all, and whether a token's selected packages bound `stage list`: unverified; [stage-tiers-test.md](stage-tiers-test.md) is the test.
- Node's Windows installer shipping a builtin `npmrc` that sets `prefix=${APPDATA}\npm`: recalled, not checked on an installed copy.
- registry.npmjs.org answering an anonymous request for a private package with 404 rather than 401: npm's own 404 message allows for it and it is commonly reported, but no request was made for this document.
- Which registries send `Vary: Authorization`: none of the mainstream ones were found to, but no header survey was made.
- Windows filesystems without inode numbers (FAT, some network shares): the fallback to spellings is tested with a simulated zero inode, not on such a filesystem.
