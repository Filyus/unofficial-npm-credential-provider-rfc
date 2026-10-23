# npmjs.com

A hypothetical `npm-credential-provider-npmjs` for the public registry, registry.npmjs.org. Nothing here exists: the provider, its keychain layout and its prompts are invented, and its behaviour follows the [Phase 2 protocol](../phase-2-credential-provider.md). What the registry does (token kinds, lifetimes, which endpoint accepts which token, which status it answers) is the vendor's documented behaviour, cited below, or the result of the [live test](../phase-2-implementation.md#the-npmjscom-stage-token-test) of 2026-10-17. The example shows a provider that mints nothing and only keeps tokens the user created, because npmjs.com gives a provider no way to mint short-lived ones; it also shows a registry that answers most refusals with 401 or 404, and one where most public reads need no credential at all.

## Registry and credentials

**URL shapes.** There is one registry key, `https://registry.npmjs.org/`. Packuments, tarballs and every API (`/-/npm/v1/tokens`, `/-/stage`, `/-/package/<pkg>/trust`, `/-/org/...`, `/-/team/...`, as [API](https://api-docs.npmjs.com/) lists them, and the `/-/whoami`, `/-/v1/login` and `DELETE /-/user/token/<token>` calls that npm's own `whoami`, web login and logout make, which that page does not list: read in the source of npm 11.19.0, not run for this page) are paths on that host, so one key covers them all. A provider must not match:

- `http://registry.npmjs.org/`: the RFC compares schemes, so a provider that lists the `https:` form serves no lockfile URL over `http:` ([Registry matching](../phase-2-credential-provider.md#registry-matching)).
- `https://www.npmjs.com/...`: the `loginUrl` of the web login. It is opened in a browser and is never a registry.
- Mirrors and proxies of npmjs.com (Artifactory, Nexus, Verdaccio uplinks): they are other registry keys. npm-profile 11.19 sends a web login through a mirror to the mirror, rewriting a `doneUrl` that names registry.npmjs.org to the configured origin (read in the source of npm 11.19.0, `npm-profile/lib/index.js`; not run for this page).

**Credential kinds.**

| Kind | Lifetime | What it can do | Source |
|---|---|---|---|
| Session token, from `npm login` (web login is the default) | Two hours, no refresh grant. It appears in no token list, so a provider records the issue time itself | The user's full permissions. The only kind the API accepts for the account surface (`GET /-/npm/v1/tokens`) and for the governance reads (collaborators, visibility, org and team listings). Publishing with it draws a one-time-password challenge | [changelog, 2025-12-09](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/), [API](https://api-docs.npmjs.com/) |
| Granular token, read-only | Default 30 days, at least one day, set in days or as a date; at most 1000 tokens per account | Reads the packages and scopes it selects (up to 50, or all packages). Live test: selected to the package, it also serves the three `/-/stage` reads | [about access tokens](https://docs.npmjs.com/about-access-tokens), [API](https://api-docs.npmjs.com/), [the live token test](../phase-2-implementation.md#the-npmjscom-stage-token-test) |
| Granular token, read and write (publish and stage) | Default 7 days, at most 90 (the API's `expires` field) | Publishes, stages, moves dist-tags, deprecates and unpublishes on the selected packages. Without bypass-2FA, publishing draws a one-time-password challenge. A package set to "Require two-factor authentication and disallow tokens" refuses every granular-token publish | [API](https://api-docs.npmjs.com/), [about access tokens](https://docs.npmjs.com/about-access-tokens), [2FA settings](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification) |
| Granular token, read and write (stage only) | As the write token above | `npm stage publish`, which asks for no one-time password, dist-tag moves and deprecations. A direct publish gets 403 `E_STAGE_REQUIRED` even with bypass-2FA, and is not redirected to staging | [changelog, 2026-09-18](https://github.blog/changelog/2026-09-18-stage-only-npm-tokens-for-safer-automation), [API](https://api-docs.npmjs.com/) |
| Bypass-2FA flag on a write token | As the token | Publishes without a one-time password where the package allows it. Under the changelog of 2026-07-31 such a token cannot create or delete tokens, or change package access, maintainers, trusted publishers or membership, without an interactive 2FA challenge (the changelog gives no separate start date for enforcement). Its direct publish is due to go in January 2027 (a target) | [changelog, 2026-07-31](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/) |
| Trusted-publishing (OIDC) exchange token | Typically one hour, package-scoped (the API's words) | Held by npm, not by a provider. `npm stage publish` is always allowed; `npm publish` and dist-tags only if the trust configuration allows them | [API](https://api-docs.npmjs.com/), [trusted publishers](https://docs.npmjs.com/trusted-publishers) |
| Classic tokens | Revoked on 2025-12-09, cannot be recreated | None | [changelog, 2025-12-09](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/) |

**What a provider cannot do.** Creating a granular token takes the account password in the request and a one-time password when 2FA is on (read in the source of npm 11.19.0, `lib/commands/token.js`; not run for this page), and a bypass-2FA token cannot create one at all. So the provider cannot mint a token per command, as the GitLab example does. It stores tokens the user created, or a session token from its own web login.

## Configuration

For a user whose only registry is npmjs.com, the per-registry form:

```ini
# ~/.npmrc
//registry.npmjs.org/:credentialProvider[]=npm-credential-provider-npmjs
```

Or, pinned to an install that does not update in place ([Security model](../phase-2-credential-provider.md#6-security-model)):

```ini
//registry.npmjs.org/:credentialProvider[]=/opt/npm-credential-provider-npmjs/1.0.3/bin/provider
```

Why per-registry:

- The provider starts only for a command that reaches registry.npmjs.org, and for no other registry.
- A leftover `_authToken` stored for this key is ignored, with a warning on every command, instead of quietly replacing the provider ([Legacy fallback](../phase-2-credential-provider.md#legacy-fallback)).
- The key is the host and a root path, so it covers packuments, tarballs, the `/-/` APIs and any `@scope:registry=` that points at this host.

The global chain works as well, and is what a user of several providers writes:

```ini
credentialProvider[]=npm-credential-provider-npmjs
credentialProvider[]=npm-credential-provider-gitlab
```

Because the chain is asked about every registry, this provider lists `registries` in its hello, so npm sends it nothing about a registry it does not serve. The cost of the global form is in [What this registry asks of the RFC](#what-this-registry-asks-of-the-rfc): the RFC gives a provider no way to let a public read go out anonymously.

**The reference provider's settings.** [The reference provider](providers/npmjs/provider.js) reads a JSON file named by a `--config <file>` argument that the lines above leave out; it fails to start without one. This page's provider takes no other setting; the file's keys are for the run: where its store is, which address answers for the host, the clock, the person's scripted answers, and the knobs `pollMs`, `loginSeconds` and `pollLimit` of the web-login poll ([providers/README.md](providers/README.md)).

## Hello

```json
{"v":[1],"capabilities":["login","logout"],"registries":["https://registry.npmjs.org/"]}
```

- `v`: only version 1.
- `login`, `logout`: the provider runs npm's web login itself and revokes a session token on logout.
- `erase` is no capability: npm sends it on every rejection, so a rejected token is always reported to the provider.
- The provider reads `retry` and `httpStatus`, to tell a 401 from a 403, and announces nothing for them: npm sends them to every provider.
- It reads no `authChallenges`: npmjs.com sent no `WWW-Authenticate` on any `/-/stage` read in the live test, and npm handles the `otp` and `ipaddress` challenges itself ([erase table](../phase-2-credential-provider.md#erase-a-credential-was-rejected)), so the field would carry nothing the provider uses.
- `registries`: the `https:` form only. npm then answers `url-not-supported` for the `http:` form on its own, and sends the provider nothing about any other registry, whether the provider is in a global chain or a per-registry list. A provider still answers it itself, from `registry` alone, in `get`, `erase`, `login` and `logout` (no transcript shows it, because npm never sends such a request: the conformance harness does, to every provider and every kind).

## Install

Provider logic for `read`: the read-only granular token whose selection covers the request, and `granularity` taken from that selection: a package selection gives `package`, a scope selection `scope`, all packages `registry`. `operationIndependent` is `false`, so a publish never picks up the read token. There is no presence check, and it works in CI. A package no read-only token selects gets `not-found` ([install-nothing-stored.jsonl](npmjs/install-nothing-stored.jsonl)), so a credential behind the provider in the chain can serve it; the provider does not hand out a broader tier instead.

[install.jsonl](npmjs/install.jsonl): `@acme/widgets` is answered by a token selected to the `@acme` scope, so every other `@acme/*` package is a cache hit. An unscoped package has no scope, so the scope-level entry does not serve it, and the provider answers from a read-only token that selects all packages:

```json
{"v":1,"kind":"get","registry":"https://registry.npmjs.org/","scope":"@acme","package":"widgets","operation":"read","command":"install","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-read-token"},"cache":"session","operationIndependent":false,"granularity":"scope"}}
{"v":1,"kind":"get","registry":"https://registry.npmjs.org/","package":"left-pad","operation":"read","command":"install","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-read-all-token"},"cache":"session","operationIndependent":false,"granularity":"registry"}}
```

`cache` is `session` because a granular token lives at least one day ([about access tokens](https://docs.npmjs.com/about-access-tokens)); a session token would be `expires` (see [Login and logout](#login-and-logout)).

## Publish

A direct publish is interactive. The provider asks for presence on the controlling terminal, naming the package and version (a prompt nobody answers within its own 4 minutes 30 seconds is `other`: [publish-unanswered.jsonl](npmjs/publish-unanswered.jsonl)), and releases a publish-and-stage granular token. Where the package disallows tokens, the registry answers 403 and the retry widens to the session token ([Rejection](#rejection)); the first answer is never the session token. The registry then challenges for a one-time password, which npm handles itself ([erase table](../phase-2-credential-provider.md#erase-a-credential-was-rejected)). [publish.jsonl](npmjs/publish.jsonl):

```json
{"v":1,"kind":"get","registry":"https://registry.npmjs.org/","scope":"@acme","package":"widgets","version":"2.4.1","operation":"publish","command":"publish","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-publish-token"},"cache":"session","operationIndependent":false,"granularity":"package"}}
```

**Staged versions.** `npm stage approve` takes only a stage id. npm first asks for `stage-read`, with no scope or package, and the provider answers with a read-only token selecting all packages. The stage record honours a token's package selection with 404 outside it ([live test](../phase-2-implementation.md#the-npmjscom-stage-token-test)), and the request names no package to select by.

The provider keeps this token for `stage-read` and never hands it out for `read`, so an erase that names `stage-read` cannot evict the token that serves installs ([Staged versions](../phase-2-credential-provider.md#4-operations)).

It gets there through `npm login` with a pasted token: a person who says the token is read-only is asked once more whether it selects all packages and is kept for staged-version lookups only, and says yes ([login-token-stage-read.jsonl](npmjs/login-token-stage-read.jsonl), which then asks for `stage-read`; [install-stage-read-token-only.jsonl](npmjs/install-stage-read-token-only.jsonl) shows a `read` that this entry does not serve, `not-found`).

Then npm fetches the record and asks for `publish` with the record's package and version. [stage-approve.jsonl](npmjs/stage-approve.jsonl):

```json
{"v":1,"kind":"get","registry":"https://registry.npmjs.org/","operation":"stage-read","command":"stage","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-stage-read-token"},"cache":"session","operationIndependent":false,"granularity":"registry"}}
{"v":1,"kind":"get","registry":"https://registry.npmjs.org/","scope":"@acme","package":"widgets","version":"2.4.1","operation":"publish","command":"stage","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-publish-token"},"cache":"session","operationIndependent":false,"granularity":"package"}}
```

Approve and reject always need a one-time password ([npm-stage](https://docs.npmjs.com/cli/v12/commands/npm-stage/)).

The other write operations the registry supports map as follows (research sketch, not tested):

- `stage` takes a stage-only token.
- `deprecate` and `dist-tag` take a stage-only token, as documented.
- `unpublish` takes a publish-and-stage token or a session token (whether a stage-only token can unpublish is not documented).
- `owner` and `stage-reject` take a session token or a non-bypass write token, interactively (the reference provider serves them from the session token only: it cannot read a pasted write token's bypass flag, and the API rejects bypass-2FA tokens for maintainer edits).
- `access` and `account` take a session token.
- `trust` takes a non-bypass granular token with write permission on the package, bound to it with `granularity` `package` ([API](https://api-docs.npmjs.com/), [npm-trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/); [trust.jsonl](npmjs/trust.jsonl)).

The session token that serves `access` is not offered for `trust`: the API lists the traditional `npmAccessToken` and granular tokens, and not the session token, as the credentials of its trust endpoints, while the page of `npm trust` says only that bypass-2FA tokens and basic auth are unsupported (the API's own sections disagree, as the last point below says).

A provider holding only that token answers `not-found` ([trust-session-only.jsonl](npmjs/trust-session-only.jsonl)); both exchanges follow the research sketch, not a live test.

## Rejection

**401.** On the stage reads the API documents 401 as the refusal ([API](https://api-docs.npmjs.com/)); a bad token on a public package is not refused. Probed on 2026-10-21 with `curl -sS -i -H "Authorization: Bearer invalid-test-token"` (a made-up value, no credential): `GET https://registry.npmjs.org/lodash` gave 200 with the same body (SHA-256 `293201c6…`) as the same request without the header; `GET /is-odd?probe=<random>` (`CF-Cache-Status: MISS`), `GET /@types%2fnode` and `GET /@types/node/-/node-20.0.0.tgz` gave 200 too, with no `WWW-Authenticate`; `GET /-/whoami` with that token gave 401, `Content-Type: application/json`, body `{}`, no `WWW-Authenticate` (without a token: 401, body `{"error":"Unauthorized"}`). The token was one the registry does not know, not a lapsed session token, and the probe says nothing about a private package.

npm sends the erase and then one retry ([erase table](../phase-2-credential-provider.md#erase-a-credential-was-rejected)); a 401 that names `otp` or `ipaddress` is handled by npm and reaches the provider as neither.

The provider:

- keeps stored tokens on erase, because what it stores is what it hands out, and reports the rejection on stderr naming `npm logout` and `npm login` ([erase](../phase-2-credential-provider.md#erase-a-credential-was-rejected));
- cannot mint a replacement and holds no other credential it would release for the request, so the retry is answered `other` and the install fails naming the provider, with no second erase;
- asks the registry about the stored token with `GET /-/whoami`, as its own request, to say which kind of `other`.

In [rejection.jsonl](npmjs/rejection.jsonl) the token is alive, so the 401 came from the URL or the registry, not from the token, and the answer says so and that no token is handed out again:

```json
{"v":1,"kind":"erase","registry":"https://registry.npmjs.org/","scope":"@acme","package":"widgets","operation":"read","granularity":"scope"}
{"Ok":{"kind":"erase"}}
{"v":1,"kind":"get","registry":"https://registry.npmjs.org/","scope":"@acme","package":"widgets","operation":"read","command":"install","interactive":false,"retry":true,"httpStatus":401}
{"Err":{"kind":"other","message":"npm says the stored read token for @acme is still valid, so the 401 did not come from the token but from the registry or the URL. No other credential is released for this request, and no token is handed out again."}}
```

When `whoami` rejects the token, the login is dead and the answer names the cure, `{"Err":{"kind":"other","message":"The stored read token for @acme was rejected. Run npm logout and npm login."}}` ([rejection-dead-token.jsonl](npmjs/rejection-dead-token.jsonl)). Either way the request fails at once and the session goes on ([erase](../phase-2-credential-provider.md#erase-a-credential-was-rejected)). It starts no web login on the 401 alone.

Two more cases are `other` too:

- When `whoami` itself does not answer 200 or 401 (a 503, a 403, no answer), the provider has learned nothing about the token and says so, `{"Err":{"kind":"other","message":"The registry would not say whether the stored read token for @acme is valid, so nothing was concluded; try again."}}`, rather than the "still valid" text, which would blame the URL for what may be an outage ([rejection-whoami-unavailable.jsonl](npmjs/rejection-whoami-unavailable.jsonl)).
- A retry with no token left in the store for the request, the store emptied by a logout since the first `get`, names `npm login`, never `not-found`: a retry is answered `Ok` or fails the request, naming the provider ([rejection-nothing-stored.jsonl](npmjs/rejection-nothing-stored.jsonl)).

**403.** On npmjs.com a 403 is rare: the API documents 401 or 404 for most insufficient permission, 403 `E_STAGE_REQUIRED` for a direct publish with a stage-only token, and 403 for a bypass-2FA token on governance endpoints ([API](https://api-docs.npmjs.com/)). Here a publish with a publish-and-stage token gets a 403, say from a package that disallows tokens (a 403 for that case is recalled by the research, not verified). npm sends no erase and one retry with `httpStatus` 403. The provider widens to a session token, under its write policy and with a new presence prompt. It does so only because the first token was not stage-only; the retry does not say which 403 it was. [rejection-403.jsonl](npmjs/rejection-403.jsonl):

```json
{"v":1,"kind":"get","registry":"https://registry.npmjs.org/","scope":"@acme","package":"widgets","version":"2.4.1","operation":"publish","command":"publish","interactive":true,"retry":true,"httpStatus":403}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-session-token"},"cache":"expires","expiresAt":1792245600,"operationIndependent":false,"granularity":"package"}}
```

It widens only a `publish` and an `unpublish` (the session token serves both), and only from a token that was neither stage-only nor the session token.

The session token is not a tier the first answer for a `publish` comes from: it is the second tier of an operation that spans two, which the RFC lets a provider move up to on a 403 "under the same policy and its presence checks" ([Operations](../phase-2-credential-provider.md#4-operations)), here the write policy and a new prompt. The registry is always `registry.npmjs.org`, so a 403 a lockfile URL could provoke costs a prompt and sends the session token nowhere else.

A 403 is answered `other` in two cases:

- on `read` ([install-403.jsonl](npmjs/install-403.jsonl)), since the RFC never moves a read to a credential that can write;
- after a stage-only token ([stage-403.jsonl](npmjs/stage-403.jsonl)), which is `E_STAGE_REQUIRED` or a refusal no other token here would change.

## Login and logout

`npm login --registry https://registry.npmjs.org/` reaches the provider as `login` ([login.jsonl](npmjs/login.jsonl)). With no `token` field, the provider runs the web login itself:

- `POST /-/v1/login` on registry.npmjs.org returns `loginUrl` and `doneUrl`.
- It prints `loginUrl` on the controlling terminal, with any control character or bidirectional override in it replaced by `?` (never reading "press ENTER" from stdin, as npm's own flow does).
- It polls `doneUrl` on registry.npmjs.org only, honouring `Retry-After`: a `Retry-After` longer than what is left of the provider's own 4 minutes 30 seconds (inside npm's five minutes for a login) ends it with `other` naming the wait, not a poll that fires at once ([login-retry-after-too-long.jsonl](npmjs/login-retry-after-too-long.jsonl)).
- The done response is `{token}` with no expiry (read in the source of npm 11.19.0, `npm-profile`; not run for this page), so the provider stores the token with the issue time it records.

The user sees the page on www.npmjs.com, where 2FA happens.

Two cases end in `other`:

- A `doneUrl` outside `https://registry.npmjs.org/` is not followed: the answer is `other`, and nothing is polled ([login-done-url-elsewhere.jsonl](npmjs/login-done-url-elsewhere.jsonl)).
- When the provider cannot print `loginUrl` because there is no controlling terminal, it stops before the first poll with `other` naming `npm login` and a terminal, and stores nothing: a login nobody can finish is not waited for ([login-no-terminal.jsonl](npmjs/login-no-terminal.jsonl)).

```json
{"v":1,"kind":"login","registry":"https://registry.npmjs.org/","interactive":true}
{"Ok":{"kind":"login"}}
```

A later `get` answered from that token uses `cache` `expires` with `expiresAt` the issue time plus 7200, since the API gives none; the RFC's 60 seconds of margin then applies ([Caching](../phase-2-credential-provider.md#5-caching)). This is the `expiresAt` in the 403 transcript above.

A session token past its two hours is no longer handed out; the provider answers `other` with `The stored session token has expired. Run npm login.`, not `not-found`, since it still holds the lapsed login and starts no web login on a `get` ([session-expired.jsonl](npmjs/session-expired.jsonl)).

**A pasted token.** With a `token` field, the provider stores a pasted granular token, and has to ask on the terminal what it is for (see below). It asks, in this order:

- what the token is for: read-only, stage-only or publish-and-stage;
- what it selects, typed as a list of scopes and packages or left empty for all packages, since a token's selection cannot be read either ([login-token.jsonl](npmjs/login-token.jsonl), where the person says it is stage-only and selects `@acme`).

The selection is what the token is stored with, and so what `granularity` follows. A token that selects `@acme` and `@acme-tools/lint-rules` is answered with:

- `scope` for `@acme/widgets`;
- `package` for the other;
- `not-found` for `@other/thing`, where it would otherwise be reused for every scope and answered with the registry's 404 ([login-token-scope.jsonl](npmjs/login-token-scope.jsonl)).

A line that names something else than a scope or a package stores nothing ([login-token-selection-invalid.jsonl](npmjs/login-token-selection-invalid.jsonl)).

Only a read-only token that selects all packages is then asked whether it is for the staged-version lookup only, since that lookup names no package and a token that selects some cannot serve it ([login-token-stage-read.jsonl](npmjs/login-token-stage-read.jsonl)).

A person who gives no answer within the provider's 4 minutes 30 seconds, one deadline for all the questions, leaves it unstored ([login-token-unanswered.jsonl](npmjs/login-token-unanswered.jsonl)); without an interactive terminal it stores nothing.

`npm logout` is [logout.jsonl](npmjs/logout.jsonl). The provider removes every stored token locally first, then, for a session token, calls `DELETE /-/user/token/<token>`, as npm's own logout does, best effort and cut at its own budget inside the 30 seconds npm gives a `logout`: a registry that does not answer cannot keep the tokens in the store. A granular token cannot be revoked without a one-time password, so the provider removes it locally and says on stderr to revoke it on the website. Either way it answers `Ok`; with no token stored at all there is nothing to remove, and it answers `not-found` ([logout-nothing-stored.jsonl](npmjs/logout-nothing-stored.jsonl)):

```json
{"v":1,"kind":"logout","registry":"https://registry.npmjs.org/"}
{"Ok":{"kind":"logout"}}
```

## CI

In CI `interactive` is `false`, so the provider prompts for nothing and serves only what is already authorized:

- read-only tokens for `read` and `stage-read`;
- a stage-only token for `stage`, `deprecate` and `dist-tag`, which the user pre-authorized by creating it for that package, but only where the provider's own configuration says so (`ciStageOnly`, never an environment variable).

The reason for the setting: `interactive: false` is also a dependency's lifecycle script, which a provider must not hand a write token to on that alone ([ci-stage-only-not-enabled.jsonl](npmjs/ci-stage-only-not-enabled.jsonl): the same request without the setting is answered `other`, naming it).

Direct publish in CI is trusted publishing: npm exchanges the identity token and asks no provider ([Trusted publishing](../phase-2-credential-provider.md#error-response)). `access`, `trust` and `account` answer `other` naming what was needed, as the RFC requires for a credential that needs presence ([Non-interactive and CI behavior](../phase-2-credential-provider.md#non-interactive-and-ci-behavior)): [ci-access.jsonl](npmjs/ci-access.jsonl). [ci.jsonl](npmjs/ci.jsonl) is `npm stage publish`:

```json
{"v":1,"kind":"get","registry":"https://registry.npmjs.org/","scope":"@acme","package":"widgets","version":"2.4.1","operation":"stage","command":"stage","interactive":false}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-stage-only-token"},"cache":"session","operationIndependent":false,"granularity":"package"}}
```

An `npm ci` in the same job asks for `read` as in [install.jsonl](npmjs/install.jsonl), with `interactive` `false`. A provider should not build a publish path for CI on a bypass-2FA token: its direct publish is due to go in January 2027 ([changelog](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/)), and then a 403 has nothing wider to widen to.

## Where it is easy to go wrong

- **Minting a token per command.** The GitLab pattern does not carry over: creation needs the password and a one-time password, tokens last whole days, and an account holds at most 1000.
- **Too broad a `granularity`.** A token selected to `@acme`, answered with `granularity` `registry`, is reused by npm for `@other/pkg`. The registry answers out-of-selection requests with 404 (verified for the stage record and tarball, [live test](../phase-2-implementation.md#the-npmjscom-stage-token-test)), and npm sends no erase and no retry on a 404, so the install reports "not found". Take `granularity` from the token's selection, and for a token the person pasted, ask for the selection. An org selection is a different axis (teams and members) and grants no package access: `@acme` as an org is not `@acme` as a scope.
- **Answering `stage-read` and thinking it is narrow.** The `/-/stage` list is filtered by the account, not the token: a token selected only to Q listed P's staged version. The presence-free `stage-read` that works in CI therefore shows the account's whole staging queue, names and versions, to whatever holds the token.
- **Forgetting the session token's expiry.** The done response has none and session tokens appear in no list. With `cache` `session`, an install that starts at 1h59m carries a dead token afterwards, and every later request fails with 401.
- **Widening a publish on a 403.** The retry carries the status, not npm's error code. A 403 `E_STAGE_REQUIRED` means the user chose a stage-only token; upgrading it to direct publish behind one prompt defeats the choice. Widen only from a token that was not stage-only.
- **Releasing a bypass-2FA token for `stage-read`, or widening to one.** The RFC forbids both ([Operations](../phase-2-credential-provider.md#4-operations)).
- **Storing a pasted token as the wrong tier.** `login` delivers one `token` with no label, and the token list (session-only) does not show a token's package selection or whether it is stage-only. A write token stored as the `read` credential is sent with every install. Ask on the controlling terminal, for the tier and for the selection, or take tokens through the provider's own CLI mode.
- **Holding an IP-restricted token for `read`.** The registry answers a token used outside its CIDR allowlist with 401 and `ipaddress`; npm raises `EAUTHIP` and sends no erase and no retry. A provider asked before every public read, with such a token, breaks `npm install` of public packages from any other network.
- **Prompting twice without knowing.** A write draws the provider's presence prompt and then npm's one-time-password challenge. Whether the registry will challenge depends on the account's 2FA, the package's publishing-access setting and the token's bypass flag, none of which the provider sees. It cannot skip its own prompt on the registry's account.
- **Following a `doneUrl` anywhere.** npm-profile follows any `http(s)` `doneUrl`; a provider refuses one outside `https://registry.npmjs.org/`, attaches no credential to the poll, and never sends anything to `loginUrl`.
- **Reading from stdin on login.** npm's "press ENTER to open the browser" reads stdin, which belongs to the protocol.
- **Starting a login on a 401.** The URL may be one a lockfile chose. Check with `/-/whoami` first, and answer erase `Ok`.
- **Matching the wrong hosts.** `www.npmjs.com`, the `http:` form and alias hosts such as registry.yarnpkg.com are not registry.npmjs.org to npm, which gives them no credential. `registry.yarnpkg.com` answered `curl -sS -i https://registry.yarnpkg.com/lodash` on 2026-10-21 with 200 and the same `ETag`, `Last-Modified`, `Content-Length` and body (SHA-256 `293201c6…`) as `https://registry.npmjs.org/lodash`, whose tarball URLs name `registry.npmjs.org`; whether the alias accepts a token was not probed.
- **Mapping `trust` to the session token that serves `access`.** The RFC says it does not serve `trust`; see below for how firm that is.

## What this registry asks of the RFC

- **No way to let a public read go out anonymously** ([Provider chaining](../phase-2-credential-provider.md#error-response), [Legacy fallback](../phase-2-credential-provider.md#legacy-fallback)).
  - A chain provider for registry.npmjs.org is asked before every public packument and tarball. The RFC already accepts that a broken global provider fails anonymous reads from this host. The case here is narrower: the provider is healthy, but its only credential is a lapsed two-hour session token.
  - Answering `Ok` with it sends a dead token (a token the registry does not know got 200 on public reads when probed on 2026-10-21, see [401](#rejection), so a public read may still succeed with it), and for a private package the retry cannot succeed. `not-found` fails because no provider answers `Ok`, and under a per-registry list `url-not-supported` fails too.
  - `url-not-supported` does not help either. The RFC has a provider decide it "from `registry` alone", and npm remembers it for the command (so a later publish loses the provider). On a host the hello lists, registry.npmjs.org here, the request then fails: the implicit `npm:token`, which would send it anonymously when nothing is stored, is not reached ([Legacy fallback](../phase-2-credential-provider.md#legacy-fallback)). It would be reached only if the hello listed no `registries`, and then the provider would be asked about every registry.
  - Two options: allow an explicit anonymous answer, or say that `url-not-supported` may reflect the provider's state for the registry (nothing usable stored) and not only its URL, and that npm's memory of it is then limited to reads. The second option weakens the guarantee that makes the memory sound.
  - **In the RFC, as a limit:** [Legacy fallback](../phase-2-credential-provider.md#legacy-fallback) states it with its reason (an anonymous answer would let a broken provider turn authenticated requests anonymous, so a private package looks missing instead of failing loudly) and the condition that would widen it. Meanwhile this provider answers `other`, with a message telling the user to log in ([session-expired.jsonl](npmjs/session-expired.jsonl)).
- **A 403 does not say why** ([erase](../phase-2-credential-provider.md#erase-a-credential-was-rejected)).
  - The retry carries `httpStatus` and `authChallenges`, not the body or npm's error code. A publish 403 on npmjs.com is `E_STAGE_REQUIRED` for a stage-only token ([API](https://api-docs.npmjs.com/)) and may be a permission refusal otherwise.
  - A provider knows which token it handed out, so it can refuse to widen from a stage-only one; it cannot tell the two causes apart when it handed out a token that is not stage-only, and then widens on a 403 that a package setting caused, which the RFC allows under the write policy.
  - A sanitized error code in the retry context would let it tell them apart. This is guidance for providers first, and an RFC addition only if the code proves useful.
  - **In the RFC:** the retry bullet says the retry names the context, not the reason, and a provider with nothing else to release answers `other`, naming what it knows.
- **Trusted publishing masks the chain for more commands than a reader expects** ([Provider chaining](../phase-2-credential-provider.md#error-response)).
  - The RFC says npm asks no provider while an exchanged token is in effect, and gives "one per package in a workspace publish" as the cadence. The commands that exchange are not listed there.
  - In `lib/commands/dist-tag.js` (current `npm/cli`, fetched 2026-10-17) the `add`, `rm` and `list` subcommands each call the exchange, and `lib/utils/oidc.js` runs it whenever a CI identity token is available.
  - The exchanged token manages or reads private dist-tags only with `manageDistTags`, which is off by default ([trusted publishers](https://docs.npmjs.com/trusted-publishers)), while a provider's stage-only token could. So a `dist-tag ls` in a job with an identity token may fail with a token that cannot read, and the chain, which could answer, is never asked.
  - The RFC answers "no provider"; the open point is whether that should hold for a read.
  - **In the RFC:** Phase 2 says it gives the precedence and the cadence, not the set of commands that exchange, which is npm's own.
- **The `trust` credential rests on documentation that disagrees with itself** ([Operations](../phase-2-credential-provider.md#4-operations)). The RFC already says "As documented" the session token that serves `access` does not serve `trust`. The API lists granular tokens for `trust` with a one-time password "always required", even for the listing. Its authentication section defines session tokens as those created via `npm login`, but many endpoint headers say "npm access token (traditional user token created via `npm login`)" ([API](https://api-docs.npmjs.com/)). A provider author should not treat the line as tested. No RFC change is needed; a live test like the stage one would settle it. **Not in the RFC:** the RFC says "as documented", which is the right hedge; settling the disagreement is research, not RFC text.
- **`login` carries no purpose** ([`login`](../phase-2-credential-provider.md#login-authenticate-with-a-registry)). npmjs.com needs several tokens (read-only, stage-only, publish-and-stage, session), `login` delivers one `token`, and the provider cannot read a granular token's selection or tier from the session-only token list. **Not in the RFC:** a purpose field would be a protocol addition for one registry; this page gives the provider-side remedy. Revisit if a second registry needs it.

Two further points need no RFC change. A package-bound stage-only token the user created is a credential that already exists, so a provider may serve `stage`, `deprecate` and `dist-tag` with it in CI without presence, where its configuration says the machine is a pipeline (`ciStageOnly` in the reference provider) ([Non-interactive and CI behavior](../phase-2-credential-provider.md#non-interactive-and-ci-behavior)). And the account-wide `/-/stage` list is already recorded in the RFC's table of credential tiers.
