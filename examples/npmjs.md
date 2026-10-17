# npmjs.com

A hypothetical `npm-credential-provider-npmjs` for the public registry, registry.npmjs.org. Nothing here exists: the provider, its keychain layout and its prompts are invented, and its behaviour follows the [Phase 2 protocol](../phase-2-credential-provider.md). What the registry does (token kinds, lifetimes, which endpoint accepts which token, which status it answers) is the vendor's documented behaviour, cited below, or the result of the [live test](../stage-tiers-test.md) of 2026-10-17. The example shows a provider that mints nothing and only keeps tokens the user created, because npmjs.com gives a provider no way to mint short-lived ones; it also shows a registry that answers most refusals with 401 or 404, and one where most public reads need no credential at all.

## Registry and credentials

**URL shapes.** There is one registry key, `https://registry.npmjs.org/`. Packuments, tarballs and every API (`/-/whoami`, `/-/v1/login`, `/-/npm/v1/tokens`, `/-/stage`, `/-/package/<pkg>/trust`, `/-/org/...`, `/-/team/...`) are paths on that host ([API](https://api-docs.npmjs.com/)), so one key covers them all. A provider must not match:

- `http://registry.npmjs.org/`: the RFC compares schemes, so a provider that lists the `https:` form serves no lockfile URL over `http:` ([Registry matching](../phase-2-credential-provider.md#registry-matching)).
- `https://www.npmjs.com/...`: the `loginUrl` of the web login. It is opened in a browser and is never a registry.
- Mirrors and proxies of npmjs.com (Artifactory, Nexus, Verdaccio uplinks): they are other registry keys. npm-profile 11.19 sends a web login through a mirror to the mirror, rewriting a `doneUrl` that names registry.npmjs.org to the configured origin (read in the source of npm 11.19.0, `npm-profile/lib/index.js`; not run for this page).

**Credential kinds.**

| Kind | Lifetime | What it can do | Source |
|---|---|---|---|
| Session token, from `npm login` (web login is the default) | Two hours, no refresh grant. It appears in no token list, so a provider records the issue time itself | The user's full permissions. The only kind the API accepts for the account surface (`GET /-/npm/v1/tokens`) and for the governance reads (collaborators, visibility, org and team listings). Publishing with it draws a one-time-password challenge | [changelog, 2025-12-09](https://github.blog/changelog/2025-12-09-npm-classic-tokens-revoked-session-based-auth-and-cli-token-management-now-available/), [API](https://api-docs.npmjs.com/) |
| Granular token, read-only | Default 30 days, at least one day, given in whole days; at most 1000 tokens per account | Reads the packages and scopes it selects (up to 50, or all packages). Live test: selected to the package, it also serves the three `/-/stage` reads | [about access tokens](https://docs.npmjs.com/about-access-tokens), [API](https://api-docs.npmjs.com/), [stage-tiers-test.md](../stage-tiers-test.md) |
| Granular token, read and write (publish and stage) | Default 7 days, at most 90 | Publishes, stages, moves dist-tags, deprecates and unpublishes on the selected packages. Without bypass-2FA, publishing draws a one-time-password challenge. A package set to "Require two-factor authentication and disallow tokens" refuses every granular-token publish | [about access tokens](https://docs.npmjs.com/about-access-tokens), [2FA settings](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification) |
| Granular token, read and write (stage only) | As the write token above | `npm stage publish`, which asks for no one-time password, dist-tag moves and deprecations. A direct publish gets 403 `E_STAGE_REQUIRED` even with bypass-2FA, and is not redirected to staging | [changelog, 2026-09-18](https://github.blog/changelog/2026-09-18-stage-only-npm-tokens-for-safer-automation), [API](https://api-docs.npmjs.com/) |
| Bypass-2FA flag on a write token | As the token | Publishes without a one-time password where the package allows it. Under the changelog of 2026-07-31 such a token cannot create or delete tokens, or change package access, maintainers, trusted publishers or membership, without an interactive 2FA challenge (the changelog gives no separate start date for enforcement). Its direct publish is due to go in January 2027 (a target) | [changelog, 2026-07-31](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/) |
| Trusted-publishing (OIDC) exchange token | About one hour, for one package | Held by npm, not by a provider. `npm stage publish` is always allowed; `npm publish` and dist-tags only if the trust configuration allows them | [trusted publishers](https://docs.npmjs.com/trusted-publishers) |
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

Because the chain is asked about every registry, this provider lists `registries` in its hello, so npm sends it nothing about a registry it does not serve. The cost of the global form is in [What this registry asks of the RFC](#what-this-registry-asks-of-the-rfc): with it, and only with it, a provider can let a public read go out anonymously, and the RFC does not say that it may.

## Hello

```json
{"v":[1],"capabilities":["login","logout","erase","retry-context"],"registries":["https://registry.npmjs.org/"]}
```

- `v`: only version 1.
- `login`, `logout`: the provider runs npm's web login itself and revokes a session token on logout.
- `erase`: without it npm sends no erase, and a rejected token is never reported to the provider.
- `retry-context`: the provider reads `retry` and `httpStatus`, to tell a 401 from a 403.
- No `auth-challenges`: npmjs.com sent no `WWW-Authenticate` on any `/-/stage` read in the live test, and npm handles the `otp` and `ipaddress` challenges itself ([erase table](../phase-2-credential-provider.md#erase-a-credential-was-rejected)), so the field would carry nothing the provider uses.
- `registries`: the `https:` form only. npm then answers `url-not-supported` for the `http:` form on its own, and sends the provider nothing about any other registry, whether the provider is in a global chain or a per-registry list.

## Install

Provider logic for `read`: the read-only granular token whose selection covers the request, and `granularity` taken from that selection: a package selection gives `package`, a scope selection `scope`, all packages `registry`. `operationIndependent` is `false`, so a publish never picks up the read token. There is no presence check, and it works in CI.

[install.jsonl](npmjs/install.jsonl): `@acme/widgets` is answered by a token selected to the `@acme` scope, so every other `@acme/*` package is a cache hit. An unscoped package has no scope, so the scope-level entry does not serve it, and the provider answers from a read-only token that selects all packages:

```json
{"v":1,"kind":"get","registry":"https://registry.npmjs.org/","scope":"@acme","package":"widgets","operation":"read","command":"install","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-read-token"},"cache":"session","operationIndependent":false,"granularity":"scope"}}
{"v":1,"kind":"get","registry":"https://registry.npmjs.org/","package":"left-pad","operation":"read","command":"install","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-read-all-token"},"cache":"session","operationIndependent":false,"granularity":"registry"}}
```

`cache` is `session` because a granular token lives at least one day ([about access tokens](https://docs.npmjs.com/about-access-tokens)); a session token would be `expires` (see [Login and logout](#login-and-logout)).

## Publish

A direct publish is interactive. The provider asks for presence on the controlling terminal, naming the package and version, and releases a publish-and-stage granular token, or a session token where the package disallows tokens. The registry then challenges for a one-time password, which npm handles itself ([erase table](../phase-2-credential-provider.md#erase-a-credential-was-rejected)). [publish.jsonl](npmjs/publish.jsonl):

```json
{"v":1,"kind":"get","registry":"https://registry.npmjs.org/","scope":"@acme","package":"widgets","version":"2.4.1","operation":"publish","command":"publish","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-publish-token"},"cache":"session","operationIndependent":false,"granularity":"package"}}
```

**Staged versions.** `npm stage approve` takes only a stage id. npm first asks for `stage-read`, with no scope or package, and the provider answers with a read-only token selecting all packages. The stage record honours a token's package selection with 404 outside it ([live test](../stage-tiers-test.md)), and the request names no package to select by. The provider keeps this token for `stage-read` and never hands it out for `read`, so an erase that names `stage-read` cannot evict the token that serves installs ([Staged versions](../phase-2-credential-provider.md#4-operations)). Then npm fetches the record and asks for `publish` with the record's package and version. [stage-approve.jsonl](npmjs/stage-approve.jsonl):

```json
{"v":1,"kind":"get","registry":"https://registry.npmjs.org/","operation":"stage-read","command":"stage","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-stage-read-token"},"cache":"session","operationIndependent":false,"granularity":"registry"}}
{"v":1,"kind":"get","registry":"https://registry.npmjs.org/","scope":"@acme","package":"widgets","version":"2.4.1","operation":"publish","command":"stage","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-publish-token"},"cache":"session","operationIndependent":false,"granularity":"package"}}
```

Approve and reject always need a one-time password ([npm-stage](https://docs.npmjs.com/cli/v12/commands/npm-stage/)). The other write operations the registry supports map as follows (research sketch, not tested): `stage` takes a stage-only token; `deprecate` and `dist-tag` take a stage-only token, as documented; `unpublish` takes a publish-and-stage token or a session token (whether a stage-only token can unpublish is not documented); `owner` and `stage-reject` take a session token or a non-bypass write token, interactively; `access` and `account` take a session token; `trust` takes a non-bypass granular token with write permission on the package, bound to it with `granularity` `package` ([API](https://api-docs.npmjs.com/), [npm-trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/)).

## Rejection

**401.** On the stage reads the API documents 401 as the refusal ([API](https://api-docs.npmjs.com/)); the research recalls the same for a bad token on a public package (unverified). npm sends the erase and then one retry ([erase table](../phase-2-credential-provider.md#erase-a-credential-was-rejected)); a 401 that names `otp` or `ipaddress` is handled by npm and reaches the provider as neither. The provider keeps stored tokens on erase, because what it stores is what it hands out, and reports the rejection on stderr naming `npm logout` and `npm login` ([erase](../phase-2-credential-provider.md#erase-a-credential-was-rejected)). It cannot mint a replacement, so the retry returns the same token. The registry rejects it again, npm erases once more with no further retry, and the install reports the failure. In [rejection.jsonl](npmjs/rejection.jsonl):

```json
{"v":1,"kind":"erase","registry":"https://registry.npmjs.org/","scope":"@acme","package":"widgets","operation":"read","granularity":"scope"}
{"Ok":{"kind":"erase"}}
{"v":1,"kind":"get","registry":"https://registry.npmjs.org/","scope":"@acme","package":"widgets","operation":"read","command":"install","interactive":false,"retry":true,"httpStatus":401}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-read-token"},"cache":"session","operationIndependent":false,"granularity":"scope"}}
```

A provider may instead answer the retry `{"Err":{"kind":"other","message":"The stored read token for @acme was rejected. Run npm logout and npm login."}}`, which fails the request at once ([erase](../phase-2-credential-provider.md#erase-a-credential-was-rejected)); that exchange is [rejection-dead-token.jsonl](npmjs/rejection-dead-token.jsonl), where the request fails and the session goes on. Before it says the login is dead, it may check the token with `GET /-/whoami`, as its own request. It starts no web login on the 401 alone.

**403.** On npmjs.com a 403 is rare: the API documents 401 or 404 for most insufficient permission, 403 `E_STAGE_REQUIRED` for a direct publish with a stage-only token, and 403 for a bypass-2FA token on governance endpoints ([API](https://api-docs.npmjs.com/)). Here a publish with a publish-and-stage token gets a 403, say from a package that disallows tokens (a 403 for that case is recalled by the research, not verified). npm sends no erase and one retry with `httpStatus` 403. The provider widens to a session token, under its write policy and with a new presence prompt. It does so only because the first token was not stage-only; the retry does not say which 403 it was. [rejection-403.jsonl](npmjs/rejection-403.jsonl):

```json
{"v":1,"kind":"get","registry":"https://registry.npmjs.org/","scope":"@acme","package":"widgets","version":"2.4.1","operation":"publish","command":"publish","interactive":true,"retry":true,"httpStatus":403}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-session-token"},"cache":"expires","expiresAt":1792245600,"operationIndependent":false,"granularity":"package"}}
```

## Login and logout

`npm login --registry https://registry.npmjs.org/` reaches the provider as `login` ([login.jsonl](npmjs/login.jsonl)). With no `token` field, the provider runs the web login itself: `POST /-/v1/login` on registry.npmjs.org returns `loginUrl` and `doneUrl`; it prints `loginUrl` on the controlling terminal (never reading "press ENTER" from stdin, as npm's own flow does) and polls `doneUrl` on registry.npmjs.org only, honouring `Retry-After`. The done response is `{token}` with no expiry (read in the source of npm 11.19.0, `npm-profile`; not run for this page), so the provider stores the token with the issue time it records. The user sees the page on www.npmjs.com, where 2FA happens.

```json
{"v":1,"kind":"login","registry":"https://registry.npmjs.org/","interactive":true}
{"Ok":{"kind":"login"}}
```

A later `get` answered from that token uses `cache` `expires` with `expiresAt` the issue time plus 7200, since the API gives none; the RFC's 60 seconds of margin then applies ([Caching](../phase-2-credential-provider.md#5-caching)). This is the `expiresAt` in the 403 transcript above. With a `token` field, the provider stores a pasted granular token, and has to ask on the terminal what it is for (see below).

`npm logout` is [logout.jsonl](npmjs/logout.jsonl). For a session token the provider calls `DELETE /-/user/token/<token>`, as npm's own logout does, best effort, and removes it locally. A granular token cannot be revoked without a one-time password, so the provider removes it locally and says on stderr to revoke it on the website. Either way it answers `Ok`:

```json
{"v":1,"kind":"logout","registry":"https://registry.npmjs.org/"}
{"Ok":{"kind":"logout"}}
```

## CI

In CI `interactive` is `false`, so the provider prompts for nothing and serves only what is already authorized: read-only tokens for `read` and `stage-read`, and a stage-only token for `stage`, which the user pre-authorized by creating it for that package. Direct publish in CI is trusted publishing: npm exchanges the identity token and asks no provider ([Trusted publishing](../phase-2-credential-provider.md#error-response)). `access`, `trust` and `account` answer `other` naming what was needed, as the RFC requires for a credential that needs presence ([Non-interactive and CI behavior](../phase-2-credential-provider.md#non-interactive-and-ci-behavior)). A transcript cannot hold that answer, for the reason above. [ci.jsonl](npmjs/ci.jsonl) is `npm stage publish`:

```json
{"v":1,"kind":"get","registry":"https://registry.npmjs.org/","scope":"@acme","package":"widgets","version":"2.4.1","operation":"stage","command":"stage","interactive":false}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-stage-only-token"},"cache":"session","operationIndependent":false,"granularity":"package"}}
```

An `npm ci` in the same job asks for `read` as in [install.jsonl](npmjs/install.jsonl), with `interactive` `false`. A provider should not build a publish path for CI on a bypass-2FA token: its direct publish is due to go in January 2027 ([changelog](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/)), and then a 403 has nothing wider to widen to.

## Where it is easy to go wrong

- **Minting a token per command.** The GitLab pattern does not carry over: creation needs the password and a one-time password, tokens last whole days, and an account holds at most 1000.
- **Too broad a `granularity`.** A token selected to `@acme`, answered with `granularity` `registry`, is reused by npm for `@other/pkg`. The registry answers out-of-selection requests with 404 (verified for the stage record and tarball, [live test](../stage-tiers-test.md)), and npm sends no erase and no retry on a 404, so the install reports "not found". Take `granularity` from the token's selection. An org selection is a different axis (teams and members) and grants no package access: `@acme` as an org is not `@acme` as a scope.
- **Answering `stage-read` and thinking it is narrow.** The `/-/stage` list is filtered by the account, not the token: a token selected only to Q listed P's staged version. The presence-free `stage-read` that works in CI therefore shows the account's whole staging queue, names and versions, to whatever holds the token.
- **Forgetting the session token's expiry.** The done response has none and session tokens appear in no list. With `cache` `session`, an install that starts at 1h59m carries a dead token afterwards, and every later request fails with 401.
- **Widening a publish on a 403.** The retry carries the status, not npm's error code. A 403 `E_STAGE_REQUIRED` means the user chose a stage-only token; upgrading it to direct publish behind one prompt defeats the choice. Widen only from a token that was not stage-only.
- **Releasing a bypass-2FA token for `stage-read`, or widening to one.** The RFC forbids both ([Operations](../phase-2-credential-provider.md#4-operations)).
- **Storing a pasted token as the wrong tier.** `login` delivers one `token` with no label, and the token list (session-only) does not show a token's package selection or whether it is stage-only. A write token stored as the `read` credential is sent with every install. Ask on the controlling terminal, or take tokens through the provider's own CLI mode.
- **Holding an IP-restricted token for `read`.** The registry answers a token used outside its CIDR allowlist with 401 and `ipaddress`; npm raises `EAUTHIP` and sends no erase and no retry. A provider asked before every public read, with such a token, breaks `npm install` of public packages from any other network.
- **Prompting twice without knowing.** A write draws the provider's presence prompt and then npm's one-time-password challenge. Whether the registry will challenge depends on the account's 2FA, the package's publishing-access setting and the token's bypass flag, none of which the provider sees. It cannot skip its own prompt on the registry's account.
- **Following a `doneUrl` anywhere.** npm-profile follows any `http(s)` `doneUrl`; a provider refuses one outside `https://registry.npmjs.org/`, attaches no credential to the poll, and never sends anything to `loginUrl`.
- **Reading from stdin on login.** npm's "press ENTER to open the browser" reads stdin, which belongs to the protocol.
- **Starting a login on a 401.** The URL may be one a lockfile chose. Check with `/-/whoami` first, and answer erase `Ok`.
- **Matching the wrong hosts.** `www.npmjs.com`, the `http:` form and alias hosts such as registry.yarnpkg.com are not registry.npmjs.org to npm, which gives them no credential (the alias hosts are recalled by the research, not verified).
- **Mapping `trust` to the session token that serves `access`.** The RFC says it does not serve `trust`; see below for how firm that is.

## What this registry asks of the RFC

- **No way to let a public read go out anonymously** ([Provider chaining](../phase-2-credential-provider.md#error-response), [Legacy fallback](../phase-2-credential-provider.md#legacy-fallback)). A chain provider for registry.npmjs.org is asked before every public packument and tarball. The RFC already accepts that a broken global provider fails anonymous reads from this host. The case here is narrower: the provider is healthy, but its only credential is a lapsed two-hour session token. Answering `Ok` with it sends a dead token (the research recalls that npmjs.com answers 401 to a bad token even on a public package; unverified), and the retry cannot succeed. `not-found` fails because no provider answers `Ok`, and under a per-registry list `url-not-supported` fails too. Only in a global chain does `url-not-supported` end in the implicit `npm:token`, which sends the request anonymously when nothing is stored. But the RFC says a provider decides it "from `registry` alone", npm remembers it for the command (so a later publish loses the provider), and it is unclear whether a provider may answer it for a registry its own hello lists. Either allow an explicit anonymous answer, or say that `url-not-supported` may reflect the provider's state for the registry (nothing usable stored) and not only its URL, and that npm's memory of it is then limited to reads. The second option weakens the guarantee that makes the memory sound. **Not adopted:** an anonymous fall-through would turn a visible provider failure into an anonymous request; legacy fallback fixes the outcome by design.
- **A 403 does not say why** ([erase](../phase-2-credential-provider.md#erase-a-credential-was-rejected)). The retry carries `httpStatus` and `authChallenges`, not the body or npm's error code. A publish 403 on npmjs.com is `E_STAGE_REQUIRED` for a stage-only token ([API](https://api-docs.npmjs.com/)) and may be a permission refusal otherwise. A provider knows which token it handed out, so it can refuse to widen from a stage-only one; it cannot tell the two causes apart when it handed out a token that is not stage-only, and then widens on a 403 that a package setting caused, which the RFC allows under the write policy. A sanitized error code in the retry context would let it tell them apart. This is guidance for providers first, and an RFC addition only if the code proves useful. **Settled:** the retry bullet now says the retry names the context, not the reason, and a provider with nothing else to release answers `other`, naming what it knows.
- **Trusted publishing masks the chain for more commands than a reader expects** ([Provider chaining](../phase-2-credential-provider.md#error-response)). The RFC says npm asks no provider while an exchanged token is in effect, and gives "one per package in a workspace publish" as the cadence. The commands that exchange are not listed there. In `lib/commands/dist-tag.js` (current `npm/cli`, fetched 2026-10-17) the `add`, `rm` and `list` subcommands each call the exchange, and `lib/utils/oidc.js` runs it whenever a CI identity token is available. The exchanged token manages or reads private dist-tags only with `manageDistTags`, which is off by default ([trusted publishers](https://docs.npmjs.com/trusted-publishers)), while a provider's stage-only token could. So a `dist-tag ls` in a job with an identity token may fail with a token that cannot read, and the chain, which could answer, is never asked. The RFC answers "no provider"; the open point is whether that should hold for a read. **Settled:** Phase 2 now says it gives the precedence and the cadence, not the set of commands that exchange, which is npm's own.
- **The `trust` credential rests on documentation that disagrees with itself** ([Operations](../phase-2-credential-provider.md#4-operations)). The RFC already says "As documented" the session token that serves `access` does not serve `trust`. The API lists granular tokens for `trust` with a one-time password "always required", even for the listing. Its authentication section defines session tokens as those created via `npm login`, but many endpoint headers say "npm access token (traditional user token created via `npm login`)" ([API](https://api-docs.npmjs.com/)). A provider author should not treat the line as tested. No RFC change is needed; a live test like the stage one would settle it. **Not adopted:** the RFC says "as documented", which is the right hedge; settling the disagreement is research, not RFC text.
- **`login` carries no purpose** ([`login`](../phase-2-credential-provider.md#login-authenticate-with-a-registry)). npmjs.com needs several tokens (read-only, stage-only, publish-and-stage, session), `login` delivers one `token`, and the provider cannot read a granular token's selection or tier from the session-only token list. A purpose hint field would be an addition for a later version; for now it is provider guidance. **Not adopted:** a purpose field would be a protocol addition for one registry; this page gives the provider-side remedy. Revisit if a second registry needs it.

Two further points need no RFC change. A package-bound stage-only token the user created is a credential that already exists, so a provider may serve `stage`, `deprecate` and `dist-tag` with it in CI without presence ([Non-interactive and CI behavior](../phase-2-credential-provider.md#non-interactive-and-ci-behavior)). And the account-wide `/-/stage` list is already recorded in the RFC's table of credential tiers.
