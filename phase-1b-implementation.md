# Phase 1b implementation

Where the pieces of [Phase 1b](phase-1b-credential-hardening.md) stand: what is to be submitted upstream, which rule each piece carries, and what exists of it. Nothing of 1b is written on a current branch and no check runs for it yet. The `${VAR}` rule, the `http:` allowance and the project-layer rule have no prototype at all. The earlier, hardened prototype did much of it for a helper's credential alone, and is the starting point ([Prior implementation](#prior-implementation)); its rows below say what it showed and where it differs from 1b.

## Submissions

[Phase 1a](phase-1a-implementation.md) already refuses two routes for a helper's credential, plain `http:` except to this machine and a proxy or CA that a project chose, in npm/cli's runner, before the program starts. 1b extends the same two rules to every credential, a stored `_authToken` included (with the proxy keys narrowed to the `http:` case), stops npm expanding `${VAR}` in a project's files, counts a user or global file that lies inside a project as the project's, and adds what the library does after a credential is chosen. Every submission is design only.

| # | Where | What | Depends on / condition to move on | State |
|---|---|---|---|---|
| 1 | make-fetch-happen, and minipass-fetch under it | `Authorization` is never written to the HTTP cache index; a redirect compares `host`, not `hostname`, when deciding whether to keep `Authorization` (the same one-token change in minipass-fetch) | Depends on nothing. Moves on when both are released, so that the warning of 3 can stop mentioning the index and the library can stop comparing ports itself | Design only |
| 2 | npm-registry-fetch | A credentialed request goes only over `https:`, loopback `http:` or an `http:` registry the caller says the user allowed; takes the settings that reveal a credential only from options the caller says a project cannot write; has its redirects judged per hop; and loses the request headers and the exact credential in an error response. Behind an option | Depends on nothing; it applies to a helper's or a provider's credential once those exist. Moves on when it is released | Design only |
| 3 | npm/cli | The `strict-credentials` setting, opt-in in a minor release; the project layer (a user or global file chosen inside a project counts as the project's); no `${VAR}` expansion in it; the `http:` allowance `//host:port/:allow-http-credential`; the messages for ignored keys; a project `.npmrc` cannot set `userconfig` or `globalconfig`; the marker for a child npm; the warnings | Depends on 2 released. The layer provenance and the child marker of [Phase 1a submission 2](phase-1a-implementation.md#2-npmcli-the-token-helper) are built there for helpers; this generalises them to every credential, and builds them if 1a has not landed. Moves on when a minor ships it | Design only |
| 4 | npm/cli, next major | `strict-credentials` is `true` by default, and a project `.npmrc` setting `userconfig` or `globalconfig` is an error | Depends on 3 shipped in a minor. Moves on when the major ships | Design only |

### 1. make-fetch-happen and minipass-fetch: `Authorization` out of the cache index, redirects compare host

- **What it will contain.** Two changes, proposed first because they are the smallest and help every caller of the libraries.
  - Where make-fetch-happen writes the headers a response names in `Vary` to its cache index, `Authorization` is left out whatever the response says. Without it, a registry that sends `Vary: Authorization` leaves the credential in the index ([sources.md](sources.md#external-facts)).
  - Where a redirect decides whether to keep `Authorization`, the comparison is of `host`, which includes the port, and not `hostname`. make-fetch-happen 16.0.1 (`lib/fetch.js`) and minipass-fetch 6.0.0 (`lib/index.js`), as npm/cli's tree has them, each compare `hostname`, and a comment in the first says a port change keeps the header on purpose. The change is one token in each, with the Fetch standard's origin comparison as the argument.
- **Size.** Not written. The prior implementation did not touch make-fetch-happen.
- **Proposal rules it carries.** [The HTTP cache](phase-1b-credential-hardening.md#the-http-cache) and the library half of [Redirects](phase-1b-credential-hardening.md#redirects).
- **Tests that pin it.** None yet.
- **How to try it.** Not yet possible.

#### Pull request text

Design only: text written when the change is proposed to make-fetch-happen and minipass-fetch, which the proposal does separately from the other pieces.

### 2. npm-registry-fetch: the route and the answer of a credentialed request

- **What it will contain.** An option, off by default, that the caller sets when `strict-credentials` is on. With it, a request that carries a credential (a stored token, a helper's or a provider's):
  - is sent only over `https:`, `http:` to a loopback address, or `http:` to a host and port the caller names as allowed, else without the credential, and a loopback request does not go through a proxy;
  - takes `ca`, `cafile` and `strict-ssl` always, and `proxy` and `https-proxy` for an `http:` request, from a set of options the caller says came from layers a project cannot write;
  - has its redirects followed by the library itself, one hop at a time, each hop judged alone: the credential goes with a hop of the same `host` and a scheme that may carry it, and is added on an eligible hop even when the first request went without;
  - gets the request headers dropped from the error for a non-2xx answer, and the exact credential npm sent replaced by `***` in its `message` and the text of its `body`.
- **Why the redirect loop stays.** The one-token fix of submission 1 closes the port leak, but a library cannot add a header it did not send, and it keeps a header across `https:` to `http:` on the same host. The per-hop rule (an `http:` registry redirecting to `https:` gets the credential on the `https:` hop) and the downgrade check need the library to follow redirects itself. That is all the loop is for: with submission 1 released it does not compare ports, and if the per-hop rule is declined it has no reason to exist.
- **Size.** Not written. In the prior implementation the redirect loop, the scheme check and the transport option are in `lib/index.js` (0fcdbb7: 148 lines changed there), and the removal from error responses in `lib/token-helper.js`, which also holds the helper's process code that 1b does not use. That removal walked JSON and masked three encodings; the one here is a short replace and is smaller.
- **Proposal rules it carries.** [Where a credential may go](phase-1b-credential-hardening.md#where-a-credential-may-go), the library half of [Which settings a credentialed request may take from a project](phase-1b-credential-hardening.md#which-settings-a-credentialed-request-may-take-from-a-project), [Redirects](phase-1b-credential-hardening.md#redirects) and [Error responses](phase-1b-credential-hardening.md#error-responses).
- **Tests that pin it.** None yet. The prior implementation's tests are in the rows of [Rule by rule](#rule-by-rule).
- **How to try it.** Not yet possible. See [Prior implementation](#prior-implementation) for the branch that does it for a helper.

#### Pull request text

Design only: text written when the maintainers have confirmed the name `strict-credentials` and the release it first appears in, which the proposal leaves to them ([Open decisions](phase-1b-credential-hardening.md#open-decisions-for-the-npm-maintainers)), because the library's option is named after the setting and its caller is submission 3.

### 3. npm/cli: `strict-credentials`

- **What it will contain.**
  - The boolean setting, default `false` in a minor release, which any layer may set and a project `.npmrc` may not turn off. When on, npm passes the option of submission 2 and the transport taken from layers a project cannot write. With it off, npm warns at the default level for what the rules would change.
  - The project layer: the project `.npmrc`, `publishConfig`, and a user or global file whose path the command line or the environment chose and that lies inside a project, by the walk of [Phase 1a's location rule](phase-1a-token-helper.md#where-it-may-be-set). `@npmcli/config` answers, for each value, whether it came from that layer, and every rule below asks it.
  - No `${VAR}` expansion in a file of the project layer when the setting is on; with it off, one default-level warning per file naming the keys that strict mode would stop expanding.
  - The allowance `//host:port/:allow-http-credential=true`, read from the user and global files, the environment and the command line only, passed to submission 2 as the list of allowed hosts and ports; it does not apply to a helper.
  - For each credentialed request that ignores a key of the project layer, a default-level message naming the key and the file, once per registry; with the setting off, the same text as a warning of what would change.
  - A marker, set only when a credential could be sent and only for the keys that came from the project layer, tells a child npm which transport values to ignore for credentialed requests. Phase 1a's `npm_config_token_helper_project_transport` is that marker for helpers.
  - A project `.npmrc` setting `userconfig` or `globalconfig` is warned about and still applied, and a project `prefix` no longer locates the global file.
- **Size.** Not written.
- **Proposal rules it carries.** [The setting](phase-1b-credential-hardening.md#the-setting), [The project layer](phase-1b-credential-hardening.md#the-project-layer), [`${VAR}` expansion](phase-1b-credential-hardening.md#var-expansion), the npm/cli half of [Where a credential may go](phase-1b-credential-hardening.md#where-a-credential-may-go) (the warning and the allowance), [Which settings a credentialed request may take from a project](phase-1b-credential-hardening.md#which-settings-a-credentialed-request-may-take-from-a-project) with its message and child npm processes, and [Project config cannot choose the user or global file](phase-1b-credential-hardening.md#project-config-cannot-choose-the-user-or-global-file).
- **Tests that pin it.** None yet.
- **How to try it.** Not yet possible. The marker for a child, as Phase 1a built it for a helper, is tried by the end-to-end run in [Reproducing the checks](phase-1a-implementation.md#reproducing-the-checks).

#### Pull request text

Design only: text written when submission 2 is released, since the setting passes the option that submission adds.

### 4. npm/cli, next major: `strict-credentials` on by default

- **What it will contain.** The default of the setting becomes `true`, and a project `.npmrc` that sets `userconfig` or `globalconfig` is refused with an error naming the file and the line. `strict-credentials=false` in the user or global file restores today's behaviour for a setup that cannot change ([Compatibility](phase-1b-credential-hardening.md#compatibility)).
- **Size.** A change of a default and of a warning into an error; not written.
- **Proposal rules it carries.** The next-major row of the [Migration Plan](phase-1b-credential-hardening.md#migration-plan).
- **Tests that pin it.** None yet.
- **How to try it.** Not yet possible.

#### Pull request text

Design only: text written when submission 3 has shipped in a minor release, so that the warnings have been seen for a release before anything is refused.

### Prior implementation

The hardened prototype is on the branches `token-helper-hardened` of npm-registry-fetch (0fcdbb7) and npm/cli (7836c74), which are not published, and `phase-1-hardened` of this repository (3752e8a), which is. It did the following for the credential of a helper alone: the scheme check, the redirect loop, the transport taken from layers a project cannot write, the removal from error responses, and the end-to-end checks for each. It also held machinery that 1b does not use, containment by filesystem identity and the masking of fourteen encodings.

On `phase-1-hardened`, the Phase 1 implementation page in the root has its rule table, with the test behind each rule, and `poc/npm-e2e/run.js`, `poc/npm-config-matrix/run.js`, `poc/npm-config-fuzz/` and `poc/platform-probes/run.js` are its checks.

## Rule by rule

Each row is a rule of [Phase 1b](phase-1b-credential-hardening.md), the submission that carries it (the number in the [table above](#submissions); two where a rule is split), what tests it, and what the prior implementation had. No rule has a test yet: the column says so, so that a rule never looks covered by a test of another design. Titles in the last column are those of tests on the branches named in [Prior implementation](#prior-implementation); they are not looked up by [`poc/claims/check.js`](poc/claims/check.js), which does check that every row names a submission above and that every submission is named.

### The setting

| Rule | Submission | Test | Prior implementation |
|---|---|---|---|
| `strict-credentials` is a boolean, `false` by default in a minor and `true` from the next major; any layer may set it, and a project `.npmrc` cannot turn it off | 3, 4 | none yet | None: neither prototype has the setting |
| With it `false`, npm warns at the default level for what the rules would change and behaves as today | 3 | none yet | None |

### The project layer

| Rule | Submission | Test | Prior implementation |
|---|---|---|---|
| The project layer is the project `.npmrc`, `publishConfig`, and a user or global file whose path the command line or the environment chose and that lies inside a project (a `package.json` or a `.git` from the file's real directory up, stopping at home) | 3 | none yet | Phase 1a has the walk, for helpers ([its rows](phase-1a-implementation.md#which-requests-get-the-credential)); the hardened branches had a filesystem-identity version, `userconfig set in the project`, `globalconfig set in the project`. Neither treats the file as the project layer for credentials other than a helper's |
| That layer counts as the project's for every rule of 1b: the transport keys, `strict-credentials` itself, `${VAR}` expansion, the `http:` allowance, and which stored credentials may be sent; a default path is never moved into it | 3 | none yet | None |

### `${VAR}` expansion

| Rule | Submission | Test | Prior implementation |
|---|---|---|---|
| With `strict-credentials` on, npm does not expand `${VAR}` in any key or value of a file of the project layer; the text stays as written | 3 | none yet | None: npm expands in every layer, and Phase 1a compares keys after expansion for the helper's location rule |
| With it off, npm expands as today and warns at the default level, once per file, naming the keys strict mode would stop expanding | 3 | none yet | None |
| The user and global layers and the environment are expanded as before | 3 | none yet | None |

### Where a credential may go

| Rule | Submission | Test | Prior implementation |
|---|---|---|---|
| A credential goes only over `https:`, `http:` to a loopback address, or `http:` to a host and port the user allowed; otherwise the request goes without it, with a warning at the default level, once per registry, naming the registry key and the remedy | 2, 3 | none yet | For a helper's credential: npm-registry-fetch 0fcdbb7, `test/token-helper.js`: `a helper credential goes over https`, `a request over http: to the registry host goes out without it, and the helper is not run`, `http: to [::1] gets the credential, for a local registry`, `http: to a host that only looks like a loopback address gets nothing`; `phase-1-hardened` e2e: `no request carries a credential`, beside the control `control: a stored token goes over the same http: registry`. Phase 1a now refuses the same for a helper in npm/cli ([its rows](phase-1a-implementation.md#which-requests-get-the-credential)) |
| The rule covers a stored token, a helper and a provider alike, and a loopback request with a credential does not go through a proxy | 2 | none yet | None: the prototype held the helper's credential to it, and a stored token was the control that still went over `http:` |
| The allowance is the per-registry key `//host:port/:allow-http-credential=true`, read only from the user and global files, the environment and the command line, never from the project layer; it names one host and port, and does not cover a helper's credential | 2, 3 | none yet | None |
| `npm login` over `http:` still sends a password in the clear, and the allowance does not change that; 1b does not cover it | 3 | none yet | None: stated as a [limit](#limits) |

### Which settings a credentialed request may take from a project

| Rule | Submission | Test | Prior implementation |
|---|---|---|---|
| A credentialed request takes `ca`, `cafile` and `strict-ssl` always, and `proxy` and `https-proxy` for an `http:` request, only from the command line, the user and global files, the environment as the user's shell set it and the defaults; the project layer does not count | 2, 3 | none yet | npm/cli 7836c74 built `tokenHelperTransport` in `workspaces/config/lib/index.js`: `tokenHelperTransport holds the user`, `tokenHelperTransport also takes the environment and the global file`, `there is no tokenHelperTransport when no tokenHelper is configured`; npm-registry-fetch 0fcdbb7: `a request that carries a helper credential uses the trusted transport`, `the trusted transport replaces the request`; e2e: `sees no request at all` beside `control: a stored token goes through`. The prototype's set also held `noproxy` and `local-address`, which 1b drops because they reveal nothing. Phase 1a refuses `proxy`, `https-proxy`, `ca`, `cafile` and `strict-ssl` from a project for a helper whatever the scheme; 1b extends it to every credential, with the proxy keys narrowed to `http:`, and 1a keeps its stricter form for helpers |
| `noproxy` and `local-address` are taken from every layer, and a committed `proxy=` keeps working for `https:` registries | 2, 3 | none yet | None: the prototype took them from trusted layers only |
| A request without a credential keeps taking every setting from every layer | 2 | none yet | npm-registry-fetch 0fcdbb7: `a request without a helper credential uses its own transport` |
| Under `strict-credentials`, a credentialed request that ignores a key of the project layer logs a default-level message naming the key and the file, once per registry; with the setting off the same text is a warning of what would change | 3 | none yet | None: the prototype refused with `ETOKENHELPER` for the helper, and 1a's message names each key and the `.npmrc` ([its rows](phase-1a-implementation.md#which-requests-get-the-credential)) |
| A child npm ignores, for credentialed requests, the transport keys its parent took from a project, which a marker names; a value the user set in the shell is honoured; the marker is set only when a credential could be sent | 3 | none yet | Phase 1a does it for a helper with `npm_config_token_helper_project_transport` ([its rows](phase-1a-implementation.md#which-requests-get-the-credential)); the hardened branch passed the transport in the flat options only |

### Redirects

| Rule | Submission | Test | Prior implementation |
|---|---|---|---|
| make-fetch-happen and minipass-fetch compare `host`, not `hostname`, when a redirect decides whether to keep `Authorization`, so a hop to another port drops it | 1 | none yet | None: both libraries compare `hostname` (make-fetch-happen 16.0.1, minipass-fetch 6.0.0), and the prototype's own loop did too |
| npm-registry-fetch follows the redirects of a credentialed request itself, one hop at a time, and judges each hop alone: the credential goes with a hop of the same `host`, that is name and port, and a scheme that may carry it (`https:`, loopback `http:`, an allowed `http:`) | 2 | none yet | npm-registry-fetch 0fcdbb7, `lib/index.js` (manual redirects, at most 20 hops): `a redirect to https on the same host keeps the credential`, `a redirect to another host drops the credential`, `a redirect loop ends with EMAXREDIRECT`. It compared `hostname`, so a hop to another port kept the credential; 1b compares `host` |
| A hop to another host or port continues without the credential, and so does a hop from `https:` to `http:` on an address that may not carry one | 2 | none yet | `a redirect on the same host from https to http drops the credential`, `a redirect from https to http on a loopback address keeps the credential` |
| An eligible hop gets the credential even when an earlier hop, or the first request, went without it (an `http:` registry that redirects to `https:` on the same host). The earlier rule, that a dropped credential does not come back, is removed: it kept that hop from carrying what a first request there would | 2 | none yet | The prototype had the old rule: `after the credential is dropped it does not come back on a later hop`; that test is replaced |

### The HTTP cache

| Rule | Submission | Test | Prior implementation |
|---|---|---|---|
| `Authorization` is never written to make-fetch-happen's cache index, whatever a response's `Vary` says | 1 | none yet | None: the hardened branches list it as a limit, since it takes a change to make-fetch-happen |

### Error responses

| Rule | Submission | Test | Prior implementation |
|---|---|---|---|
| The error for a non-2xx answer loses the request headers, and every occurrence of the exact credential npm sent is replaced by `***` in its `message` and in the text of its `body`; a successful response is not touched | 2 | none yet | npm-registry-fetch 0fcdbb7, `redactError` in `lib/token-helper.js`, which did more (a bounded-depth JSON walk and three encodings): `a header that echoes the credential, and the message that quotes it, do not show it`, `a body that is not JSON, as bytes, does not show the credential either`, `a body that does not have the credential is the same object`. The tests of the JSON-escaped and percent-encoded forms (`an error body that echoes the credential raw, JSON-escaped or percent-encoded does not show it`) are not carried over |
| Only the credential npm sent is removed, as it is: nothing is recognised by its shape, no other encoding is searched for, and nothing is hidden from a registry meant to receive it | 2 | none yet | `an error of a request without a helper credential is not touched`; the prototype also masked credential-like text, which 1b does not |

### Project config cannot choose the user or global file

| Rule | Submission | Test | Prior implementation |
|---|---|---|---|
| A project `.npmrc` cannot set `userconfig` or `globalconfig`: with `strict-credentials` off npm warns and still applies the value, with it on and in the next major by default npm refuses it with an error naming the file and the line | 3, 4 | none yet | None: both prototypes find where a file came from and refuse the helper in it, and never refuse the setting. npm/cli 7836c74 tests the finding: `userconfig set in the project`, `globalconfig set in the project` |
| A project-set `prefix` is not refused and still applies to installs, but npm does not use it to locate the global config file | 3 | none yet | None: the prototype treated a project `prefix` as moving the default global file, and so as untrusted (`prefix set in the project moves the default global file`) |

### Release plan

| Rule | Submission | Test | Prior implementation |
|---|---|---|---|
| A minor ships the setting, off, with a default-level warning wherever it would change behaviour (`${VAR}` and the transport keys included) and the `http:` allowance, and the make-fetch-happen changes are proposed upstream; the next major turns it on | 1, 3, 4 | none yet | None |

## Limits

Each row is one of two things, and the kind is in the first column. A **limit** is outside what Phase 1b claims, for the reason given, with what would make the claim wider. **Deferred** work is something that can be done and is not, with the number of the task that follows it; the limits come first. A defect is not listed: it is fixed. The [Open decisions](phase-1b-credential-hardening.md#open-decisions-for-the-npm-maintainers) are the names `strict-credentials` and `allow-http-credential` and the release they first appear in.

| Kind | Not claimed | Why | Wider if |
|---|---|---|---|
| limit | That a user or global file chosen on the command line or in the environment is the project layer wherever it lies | Where the file is comes from the file alone, by [Phase 1a's location rule](phase-1a-token-helper.md#where-it-may-be-set): a `package.json` or a `.git` from its real directory up, stopping at home. A file outside any marked directory, or in a git-managed dotfiles directory below home, is the user's; the 1a limits list the cases ([phase-1a-implementation.md](phase-1a-implementation.md#limits)) | None that npm can take, as the Phase 1a limits say |
| limit | That the rules protect a command that runs repository code: a bare `npm install` runs the root project's lifecycle scripts and `.npm-extension.mjs`, which run as the user | Code running as the user can read the user's files and environment and start npm with any option; the rules are for what a repository's config and the network do before or without code | None that npm can take |
| limit | That a repository cannot make npm start the user's helper: its `registry=` or a lockfile `resolved` URL names a host the user configured a helper for | 1b limits where a credential goes, not whether a program starts, and the credential is the user's for that host | [Phase 2](phase-2-credential-provider.md)'s provider can gate write credentials |
| limit | That `npm login` over `http:` is protected: it sends a password in the clear to an `http:` registry, and `allow-http-credential` does not change that | A login is not a request that carries a stored credential, and the rules of 1b are about the credential npm sends, not the one it is asked for | A login is held to the same scheme rule, which is a change to a different command |
| limit | That an `http:` registry can be allowed for a helper's credential | A helper mints a fresh and often broad token, and [Phase 1a](phase-1a-token-helper.md) refuses `http:` to a non-loopback host before the helper runs; the allowance applies to the credentials 1a does not refuse | A provider or helper can say its credential is read-only |
| limit | That a repository cannot make npm start the user's helper: its `registry=` or a lockfile `resolved` URL names a host the user configured a helper for | 1b limits where a credential goes, not whether a program starts, and the credential is the user's for that host | [Phase 2](phase-2-credential-provider.md)'s provider can gate write credentials |
| limit | That the credential stays out of the HTTP cache index before submission 1 is released | The index is written by make-fetch-happen, which records every header a response names in `Vary`. registry.npmjs.org does not send `Vary: Authorization` on a packument, and no other registry was checked ([sources.md](sources.md#not-verified)) | make-fetch-happen releases the change, or other registries are checked |
| limit | That a credential a registry echoes in a form other than the one npm sent (JSON-escaped, percent-encoded, base64, split over lines, cut short) is removed from an error | The proposal replaces the exact value npm sent and drops the request headers. A registry that echoes the `Authorization` header is wrong, and the plain echo is what exact replacement removes; a hostile registry already received the credential and is out of scope. A search for other forms gives false positives and is the machinery the prototype dropped | A registry that is not hostile is found that echoes another form |
| limit | That a script which drops the marker and starts a child npm gets no project transport for a credentialed request | A repository's script runs as the user and can set the child's environment itself; the marker can only tell a child what the parent took from a project | None that npm can take: it would have to see what a script's environment lost |
| deferred | That the rules are shown against a real https registry end to end | The hardened end-to-end run had no TLS listener and showed the `http:` half; the unit tests showed the rest with a mocked make-fetch-happen, for the options it is given and not for what it does with them | The end-to-end run gains a TLS listener (task 540) |

## How it is checked

Nothing is checked in CI for 1b yet, since no code of it is on a current branch. The workflows on `main` run the Phase 1a prototype, the Phase 2 conformance material and the links between the documents, and none of the checks below.

What the hardened branches had, and what returns with 1b:

- **Unit tests.** `test/token-helper.js` of npm-registry-fetch on `token-helper-hardened` (1607 lines: the scheme check, the redirects, the trusted transport, the removal from errors) and the config tests of npm/cli on the same branch. Their subject was a helper's credential; the tests of 1b are written for every credential.
- **End to end.** `poc/npm-e2e/run.js` on `phase-1-hardened`, a real npm against a local registry, with the redirect hops, the error responses, the proxy and the cache, each refusal beside a control (65 checks in a local run on 2026-10-21, counted by hand).
- **Config matrix and spelling fuzz.** `poc/npm-config-matrix/run.js` (2048 combinations of who sets `userconfig`, `globalconfig` and `prefix`) and `poc/npm-config-fuzz/`, which belong to the machinery of identity that 1b replaces with a refusal.
- **Platform probes** for containment by device and inode, which 1b does not use.

[Phase 1a's How it is checked](phase-1a-implementation.md#how-it-is-checked) says what was retired with the split. The checks of 1b return with its code, under the same rule: a refusal is set beside a control that runs the same request where it is allowed.

## Audit history

The rounds that shaped 1b, from [Phase 1a's audit history](phase-1a-implementation.md#audit-history). 1b is revision 2 of 2026-10-23.

| Round | Method | What it did to 1b |
|---|---|---|
| Pre-split round 3 and the fuzz | review and fuzzing of the single prototype | An error that quoted a header printed the credential, and a credential a helper echoed as JSON, in a shell's quotes or percent-encoded was logged. These are the origin of the removal from error responses, in the forms a registry echoes it |
| Split | three critics, 2026-10-22 | The hardening of every credential's route had grown into the helper and held it to a stricter rule than the stored token it replaces; filesystem-identity containment and fourteen-encoding masking were machinery for rules that a narrower trust rule and exact masking made unnecessary. The route was split out as 1b, which applies one rule to every credential behind an opt-in setting |
| 2nd review | critics of the prototype, 2026-10-22 | A user or global file chosen by the command line or the environment could come from the repository. 1b refuses only a project's own choice, which has no spelling to get past, and leaves a chosen file to Phase 1a's location rule |
| 3rd review | five critics, 2026-10-23 | The documents said a helper behaves like `_authToken`. Phase 1a now refuses plain `http:` and a project's proxy or CA for a helper, and 1b's motivation names those two as done there and extends them to every credential |
| 4th review | two security councils, 2026-10-23 (same-user attacker, CI, claims audit; scenarios: developer machine, CI, registries, hostile repository) | `${VAR}` in a repository's files sent an environment secret to its host with no code running (credential keys, registry URL, `user-agent`, proxy userinfo): no longer expanded in the project layer. A user or global file placed in a project by the command line or environment (GitLab's `NPM_CONFIG_USERCONFIG=$CI_PROJECT_DIR/.npmrc`) is the project layer for every rule. The transport list is narrowed to what reveals a credential. Redirects are judged per hop, with the `hostname` fix proposed to the libraries first. A per-registry `http:` allowance replaces switching everything off. Error redaction is cut to exact replacement. The proposal says what it does not protect |
