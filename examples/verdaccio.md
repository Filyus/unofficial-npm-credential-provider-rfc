# Verdaccio

A hypothetical `npm-credential-provider-verdaccio` for [Verdaccio](https://verdaccio.org/), the self-hosted npm registry. Verdaccio has no vendor hostname, no short-lived tokens and only two token tiers, so the provider cannot work like the [GitLab](gitlab.md) one: it mints its tokens once, at login, and decides on each request which of the two to release. This example shows a provider for a registry whose tokens are long-lived, how user presence gates the write tier, and where a rejection says little. Verdaccio facts come from its source on `master` (the 9.x line, where staging and 2FA live) and its docs, linked below; the provider itself, its name and its behaviour are not real. The hostname `npm.example.test` and every token in the transcripts are fake.

Transcripts: [install](verdaccio/install.jsonl), [publish](verdaccio/publish.jsonl), [stage-approve](verdaccio/stage-approve.jsonl), [rejection](verdaccio/rejection.jsonl), [escalation](verdaccio/escalation.jsonl), [login](verdaccio/login.jsonl), [logout](verdaccio/logout.jsonl), [ci](verdaccio/ci.jsonl). The repository's tests check every one against the protocol model.

## Registry and credentials

**URL shapes.** The provider must match whatever the operator deployed ([reverse proxy](https://verdaccio.org/docs/reverse-proxy)):

- `http://localhost:4873/`, the default. Plain `http:` is common in development and on intranets, and a hello entry with `https:` does not cover it ([Registry matching](../phase-2-credential-provider.md#registry-matching)).
- `https://<host>/` behind a proxy, with a host the deployment chose. The provider cannot derive it, so it takes the registry from its configuration.
- `https://<host>/<url_prefix>/`, for a sub-path install such as `https://npm.example.test/verdaccio/`. `url_prefix` ends in a slash, and the key and the hello entry are that prefix. The examples use this form.
- Tarballs are under the same base (`<base>/@scope/<name>/-/<name>-<ver>.tgz`). The base comes from `VERDACCIO_PUBLIC_URL` if set, otherwise from the request's `Host` and `X-Forwarded-Proto` ([reverse proxy](https://verdaccio.org/docs/reverse-proxy)).
- The API sits under the base: `/-/whoami`, `/-/user/org.couchdb.user:<name>`, `/-/npm/v1/tokens`, `/-/stage/...`, `/-/v1/login` ([api-urls.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/middleware/src/middlewares/api-urls.ts)).

**Credentials.** Everything is a bearer token. `Authorization: Basic` is refused on `master` ([utils.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/auth/src/utils.ts), [auth.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/auth/src/auth.ts)). An auth plugin that brings its own middleware (the OAuth and OpenID plugins) may change that, so a provider is written for one deployment's auth stack.

| Kind | How obtained | Lifetime | What it can do |
|---|---|---|---|
| Login token, AES (the default: `security.api.legacy: true`, no `security.api.jwt`) | `PUT /-/user/org.couchdb.user:<name>` with name and password (`npm login`); an OTP when 2FA is enrolled | None. Valid until the user's password or the server secret changes. It is the user's password, reversibly encrypted | Everything the user's groups allow in the `packages` rules. No read-only form, no per-token revocation ([utils.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/auth/src/utils.ts), [security.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/config/src/security.ts), [user.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/api/src/user.ts)) |
| Login token, JWT (when `security.api.jwt.sign` is set) | The same route, or the web login | `security.api.jwt.sign.expiresIn`, which has no default for the API; without it the token never expires. `exp` is readable by decoding the token | The groups frozen into the token when it was minted. Not revocable: `DELETE /-/user/token/*` does nothing ([auth.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/auth/src/auth.ts), [jwt-token.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/signature/src/jwt-token.ts), [user.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/api/src/user.ts)) |
| Generated token, full (`npm token create`) | `POST /-/npm/v1/tokens` with `readonly: false`, the password in the body, and an OTP under 2FA | As the mode's login token. A requested `expires` is ignored | The user's full package permissions, optionally limited to source addresses (`cidr_whitelist`). Revocable by key. A revoked or unknown key, or an address outside the list, gets 403 ([token.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/api/src/v1/token.ts), [token-auth.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/middleware/src/middlewares/token-auth.ts)) |
| Generated token, read-only | The same request with `readonly: true` | As the full generated token | Any method but `DELETE`, `PATCH`, `POST` and `PUT`, which get 403. All `GET`s under `/-/stage` pass. The `npm audit` POST is, by the registration order in [server.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/server/express/src/server.ts), inferred to reach the audit plugin before the read-only check |

There are no package-scoped, scope-scoped or stage-only tokens. What a user may do is decided by group membership in the `packages` rules (`access`, `publish`, `unpublish`, `stage`, first match wins; [packages](https://verdaccio.org/docs/packages), [auth-utils.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/core/core/src/auth-utils.ts)), so a stage-only credential is a separate account that is only in `stage` groups. Verdaccio fetches from its uplinks with a token from its own configuration ([uplinks](https://verdaccio.org/docs/uplinks)); the client's token is used only for Verdaccio's own rules.

Staging, 2FA and web login are flags that are off by default; staging and 2FA are experimental ([staged publishing](https://verdaccio.org/docs/staged-publishing), [two-factor authentication](https://verdaccio.org/docs/two-factor-authentication), [web login](https://verdaccio.org/docs/web-login)). The provider cannot learn them from the registry without probing, so the operator states them in its arguments.

**How the provider maps [operations](../phase-2-credential-provider.md#4-operations)** (sources: [token-auth.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/middleware/src/middlewares/token-auth.ts), [stage.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/api/src/stage.ts), [publish.ts and dist-tags.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/api/src/publish.ts), [token.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/api/src/v1/token.ts)):

| Operation | Credential released | Why |
|---|---|---|
| `read`, `stage-read` | the read-only generated token | Packuments, tarballs and every `/-/stage` read are `GET`s. What a caller sees under `/-/stage` belongs to the user, not the token, so the read-only token sees what the full one sees |
| `stage`, `publish`, `stage-reject`, `deprecate`, `dist-tag`, `unpublish`, `owner` | the full generated token, after user presence, by default only when `interactive` is `true` (an operator may provision the token for CI) | All are writes, so the read-only token gets 403. Which user may do which is the registry's rules, not the token's. `stage-reject` is a `DELETE`: the account that staged a version may reject it, a publisher may too, and both need a write token |
| `account` | the read-only token first, the full token when a write is refused | Token list and profile get accept the read-only token; token create, token revoke and profile set need the full one ([Operations](../phase-2-credential-provider.md#4-operations)) |
| `access`, `trust` | `operation-not-supported` | Verdaccio has no access, team, org or trust endpoints, so such requests fall through to the package routes or 404 ([api/index.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/api/src/index.ts)). See [What this registry asks of the RFC](#what-this-registry-asks-of-the-rfc) |

`owner add` and `owner rm` are gated by the `unpublish` rule, not `publish`, and `deprecate` by `publish`; both mappings rest on the request npm sends, which was recalled and not verified.

## Configuration

```ini
# ~/.npmrc
@acme:registry=https://npm.example.test/verdaccio/
//npm.example.test/verdaccio/:credentialProvider[]=npm-credential-provider-verdaccio --registry https://npm.example.test/verdaccio/

# a second line for a development instance, which is served over http:
//localhost:4873/:credentialProvider[]=npm-credential-provider-verdaccio --registry http://localhost:4873/
```

The provider is configured per registry, never in the global chain. A self-hosted registry has no hostname the provider can recognize, so it learns its registry from `--registry`, and a per-registry key keeps it from starting for a registry it does not serve ([Configuration](../phase-2-credential-provider.md#1-configuration)). A provider that someone does put in the global chain must list exactly the bases it was given, `http:` and `https:` as served, and answer `url-not-supported` for the rest. The key carries no scheme, so the `http:` and `https:` forms of one host share a line; the `--registry` argument, which becomes the hello entry, does carry it, and a host served over both needs two arguments.

## Hello

```json
{"v":[1],"capabilities":["login","logout","erase","retry-context"],"registries":["https://npm.example.test/verdaccio/"]}
```

- `v`: the protocol version.
- `login`, `logout`: the provider logs in with a password and removes its tokens at logout.
- `erase`: it keeps in-memory copies and wants to be told when one is rejected.
- `retry-context`: it reads `retry` and `httpStatus`, which it needs to tell a read-only refusal from a revoked token.
- `auth-challenges` is left out. Every Verdaccio 401 that is not an OTP demand carries a bare `WWW-Authenticate: Bearer`, with no realm or error code ([final.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/middleware/src/middlewares/final.ts)), so the challenges tell it nothing. npm may still send them; the field is advisory ([Version negotiation](../phase-2-credential-provider.md#version-negotiation)).
- `registries`: the configured base, with its scheme. npm then sends the provider nothing about another registry, and a request for the `http:` form of this one is answered `url-not-supported` by npm itself.

## Install

[install.jsonl](verdaccio/install.jsonl): `npm install @acme/widget`, run from a terminal.

```json
{"v":1,"kind":"get","registry":"https://npm.example.test/verdaccio/","scope":"@acme","package":"widget","operation":"read","command":"install","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-read-token"},"cache":"session","granularity":"registry","operationIndependent":false}}
```

The provider releases the read-only token it minted at login. Both Verdaccio tiers are per user and registry-wide, so `granularity` is `registry` and every other package of the install is a cache hit. `operationIndependent` is `false`: with `true`, npm would hold the read-only token as an entry that serves every operation, and a `publish` lookup that finds no entry of its own would send it ([Caching](../phase-2-credential-provider.md#5-caching)). `cache` is `session` because the token is an opaque AES token that never expires. In JWT mode the provider decodes `exp` without verifying it, clamps it, and answers `"cache":"expires"` with `expiresAt`, as in [rejection.jsonl](verdaccio/rejection.jsonl). It never derives `expiresAt` from an `expires` it asked for at mint time, since Verdaccio ignores that field ([token.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/api/src/v1/token.ts)). No prompt appears: a read-only token needs no presence.

## Publish

[publish.jsonl](verdaccio/publish.jsonl): `npm publish` of `@acme/widget@2.4.1`.

```json
{"v":1,"kind":"get","registry":"https://npm.example.test/verdaccio/","scope":"@acme","package":"widget","version":"2.4.1","operation":"publish","command":"publish","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-full-token"},"cache":"session","granularity":"package","operationIndependent":false}}
```

The provider shows a presence prompt on the controlling terminal that names the package, the version and the registry, and releases the full generated token. The answer is bound to the package and the operation, as npm would bind it anyway ([Caching](../phase-2-credential-provider.md#5-caching)); the packument fetch that precedes the upload carries the same operation and is served from that entry. Under the `auth-and-writes` 2FA mode the registry then answers 401 with `WWW-Authenticate: otp`; npm treats that as its one-time-password prompt, sends no erase and asks the provider nothing ([require-otp.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/api/src/require-otp.ts), [erase](../phase-2-credential-provider.md#erase-a-credential-was-rejected)).

Staging is the other write path. [stage-approve.jsonl](verdaccio/stage-approve.jsonl) shows `npm stage approve <id>`: the lookup of the record asks for `stage-read` with no package and gets the read-only token, with no prompt, since every `/-/stage` read is a `GET` that token passes. npm then asks for `publish` with the scope, package and version from the record. `npm stage publish` asks for `stage`, which needs a full token of a user in a `stage` group and no OTP ([stage.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/api/src/stage.ts)). Approve and reject need an OTP under `auth-and-writes`.

## Rejection

[rejection.jsonl](verdaccio/rejection.jsonl): a 401 on a read made with a JWT, then the retry.

```json
{"v":1,"kind":"erase","registry":"https://npm.example.test/verdaccio/","scope":"@acme","package":"widget","operation":"read","granularity":"registry","authChallenges":["Bearer"]}
{"Ok":{"kind":"erase"}}
{"v":1,"kind":"get","registry":"https://npm.example.test/verdaccio/","scope":"@acme","package":"widget","operation":"read","command":"install","interactive":true,"retry":true,"httpStatus":401,"authChallenges":["Bearer"]}
```

A 401 is the less common rejection here. An expired or badly signed JWT does not give 401: Verdaccio treats it as an anonymous user and the request goes on, so a read of a package with the default `access: $all` succeeds with no signal and npm never erases ([utils.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/auth/src/utils.ts)). The 401 comes on a protected package, a write or a stage call, or from a token the registry does not yet accept (`jwt not active` from a node whose clock lags, since the token is signed with `notBefore` 1 ms; [jwt-token.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/signature/src/jwt-token.ts)). The transcript shows the second kind.

On the erase the provider drops its in-memory copy and keeps the tokens in its keychain, since they are what it hands out and only `logout` removes them. Its check for a dead login is a `GET /-/whoami` with the token against the configured base (never a realm or a lockfile URL), and it runs while answering the retry `get`, not the erase, which has a 10-second budget meant for local cleanup ([timeouts](../phase-2-credential-provider.md#session-lifecycle)):

- 200: the token is alive and the 401 was specific to the request or the node. The provider answers the retry with the same token, as in the transcript. If the registry rejects it again, npm erases it and reports the rejection, with no second retry.
- 401: the token is expired or invalid. The provider starts no login on the strength of that alone ([erase](../phase-2-credential-provider.md#erase-a-credential-was-rejected)) and answers the retry with an error that names the cure ([rejection-dead-token.jsonl](verdaccio/rejection-dead-token.jsonl)):

```json
{"Err":{"kind":"other","message":"The Verdaccio token for https://npm.example.test/verdaccio/ was rejected. Run npm logout, then npm login."}}
```

The same happens for a 403 on `/-/whoami`: the key is revoked or the address is outside the token's `cidr_whitelist`.

**A 403** is the usual refusal. [escalation.jsonl](verdaccio/escalation.jsonl) shows `npm token create`, which asks for `account`:

```json
{"v":1,"kind":"get","registry":"https://npm.example.test/verdaccio/","operation":"account","command":"token","interactive":true,"retry":true,"httpStatus":403}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-full-token"},"cache":"session","granularity":"registry","operationIndependent":false}}
```

The provider started with the read-only token, which lists tokens and reads the profile. The create is a `POST`, so the read-only token gets 403, and npm sends no erase and one retry. Before escalating, the provider calls `GET /-/whoami` with the token it gave: 200 means the refusal was a read-only refusal, and after a presence prompt it releases the full token. A 403 on `whoami` means revocation or an address mismatch, and it answers `other` instead.

## Login and logout

[login.jsonl](verdaccio/login.jsonl):

```json
{"v":1,"kind":"login","registry":"https://npm.example.test/verdaccio/","interactive":true}
{"Ok":{"kind":"login"}}
```

The password path, all on the controlling terminal:

1. Prompt for the username and password, and for an OTP if the server answers 401 with `WWW-Authenticate: otp`.
2. `PUT /-/user/org.couchdb.user:<name>` for a login token, which only authenticates the next calls.
3. `POST /-/npm/v1/tokens` twice, once with `readonly: true` and once with `readonly: false`, each with the password in the body and `npm-otp` when 2FA is on, and with a `cidr_whitelist` if the operator asked for one ([token.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/api/src/v1/token.ts)).
4. Store both tokens and their keys in the OS keychain, discard the password and the login token, answer `Ok`.

This is the only moment the provider can mint, because minting needs the password and Verdaccio ignores a requested expiry, `packages` and `scopes` ([token.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/api/src/v1/token.ts)). Two other inputs do not give two tiers:

- A `token` field, the static-token flow: the provider stores it as the full token. Its tier and its key cannot be learned without a write probe, because the token list shows masked tokens.
- A web login (`POST /-/v1/login`, then a poll of the done URL, with the `webLogin` flag set; [web login](https://verdaccio.org/docs/web-login)) yields a login token with no password behind it. That token cannot be read-only, cannot be limited by address and cannot be revoked, so a provider that logs in this way has one full-power credential and must hand it out for `read` too.

[logout.jsonl](verdaccio/logout.jsonl):

```json
{"v":1,"kind":"logout","registry":"https://npm.example.test/verdaccio/"}
{"Ok":{"kind":"logout"}}
```

The provider revokes both generated tokens with `DELETE /-/npm/v1/tokens/token/<key>`, authenticated by the full token and needing no OTP, wipes the keychain entries and answers `Ok` even if a revocation failed, with a warning on stderr. The login token cannot be revoked, since `DELETE /-/user/token/*` does nothing ([user.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/api/src/user.ts)), and the provider says so on stderr rather than claiming it.

## CI

[ci.jsonl](verdaccio/ci.jsonl) is `npm ci` and [ci-stage.jsonl](verdaccio/ci-stage.jsonl) is `npm stage publish`: two commands, so two sessions, with `interactive: false`.

```json
{"v":1,"kind":"get","registry":"https://npm.example.test/verdaccio/","scope":"@acme","package":"widget","operation":"read","command":"ci","interactive":false}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-ci-read-token"},"cache":"session","granularity":"registry","operationIndependent":false}}
```

And the staging, in its own session:

```json
{"v":1,"kind":"get","registry":"https://npm.example.test/verdaccio/","scope":"@acme","package":"widget","version":"2.4.1","operation":"stage","command":"stage","interactive":false}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-ci-stage-token"},"cache":"session","granularity":"package","operationIndependent":false}}
```

No one is present, so by default the provider holds or is given only the read-only token and releases it for installs. A write is answered `other`, naming what was needed ([Non-interactive and CI behavior](../phase-2-credential-provider.md#non-interactive-and-ci-behavior), [ci-publish-refused.jsonl](verdaccio/ci-publish-refused.jsonl)):

```json
{"Err":{"kind":"other","message":"publish to https://npm.example.test/verdaccio/ needs a full Verdaccio token and a user to approve it; none is available in CI"}}
```

The operator can provision more on purpose, and the transcript shows the best case: a separate Verdaccio account that is only in the `stage` groups of the `packages` rules, whose full token the CI machine image gives the provider. `npm stage publish` needs no OTP, so staging works in CI, and a human then approves the version. Publishing directly from CI is not possible for a user under `auth-and-writes` 2FA: Verdaccio has no bypass-2FA tokens and ignores `bypass_2fa` ([two-factor authentication](https://verdaccio.org/docs/two-factor-authentication)).

## Where it is easy to go wrong

- **Treating tokens as short-lived JWTs.** By default `security.api.legacy` is `true` and no JWT is configured, so every token is the user's password, encrypted, and never expires. A provider that computes `expiresAt` from a JWT it assumes is there produces nonsense; it answers `session` for an opaque token and `expires` only from a decoded `exp` ([utils.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/auth/src/utils.ts), [security.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/config/src/security.ts)). Even JWTs have no API default for `expiresIn`.
- **Asking for a short-lived token.** Minting needs the password, so the provider cannot refresh from a stored token as the GitLab one does, and a requested `expires` is accepted and ignored: a 1-hour request returns a token that lives for the server's `expiresIn` or forever. Read `exp` back; never trust the request.
- **Relying on a 401 to learn that a token expired.** An expired JWT, or one with a bad signature after the secret was rotated, becomes an anonymous request, not a 401. Report `expiresAt` from `exp` so that npm asks again before the server silently downgrades, because erase and retry will not signal expiry ([utils.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/auth/src/utils.ts)).
- **Reading a 403 as "need a bigger token".** The same status means: the user is not in the rule, the token is read-only, the key is revoked or unknown, or the address is outside `cidr_whitelist` ([token-auth.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/middleware/src/middlewares/token-auth.ts)). The retry carries no body, so the provider cannot tell which. A provider that escalates on every 403 hands a full token to a read whose real problem was a CI runner's address. Probe `GET /-/whoami` first: 200 means an ACL or read-only refusal, 403 means revoked or address. The RFC already forbids widening `read` on a 403, and that applies here with force.
- **CIDR tokens and `server.trustProxy`.** The address Verdaccio checks is `req.ip`, which is the real client only if `trustProxy` is set. Behind a proxy without it, a CIDR-bound token always passes or always fails; with it set too broadly, a client can spoof its address. CI runners with changing addresses turn a CIDR-bound read-only token into intermittent 403s ([token-auth.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/middleware/src/middlewares/token-auth.ts)).
- **Returning `basic`.** Since the htpasswd store is a username and password, `{"type":"basic",...}` is tempting. The bundled middleware accepts only `Bearer` and answers 401 to every request, which npm erases and retries ([utils.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/auth/src/utils.ts)).
- **Mapping `stage-reject` to `publish` or to the read-only token.** Reject is a `DELETE`, so it needs a full token, and the account that staged a version may reject it without being a publisher ([stage.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/api/src/stage.ts)). A publish policy that refuses a stage-only user is the wrong policy for it.
- **Widening `stage-read` on a 404.** `GET /-/stage/<id>` answers 404 for a record that does not exist, one the caller may not see, and any id when `flags.stage` is off. Visibility is the user's, so a full token sees no more than the read-only one; widening never helps and the RFC forbids it ([Staged versions](../phase-2-credential-provider.md#4-operations)).
- **Dropping the read token on a `stage-read` erase.** The same read-only token serves `read` and `stage-read`. An erase that names `stage-read` ends that binding, and the provider's own state must keep the token it still serves for `read`.
- **Thinking `owner` is below `publish`.** `owner add` is gated by `unpublish`. Ownership is cosmetic and the rules decide.
- **A web-login provider that answers `read` with its one token.** It is full-power and cannot be revoked, which is the standing write secret the RFC sets out to remove. Document it, or do not offer web login.
- **Expecting logout to revoke a login token.** Only the generated tokens the provider minted are revocable; JWT groups are also frozen at mint time, so removing a user from htpasswd leaves outstanding tokens working until `exp` ([auth.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/auth/src/auth.ts)).
- **Tarball URLs on another origin.** Packument `dist` URLs come from `VERDACCIO_PUBLIC_URL` or from `Host` and `X-Forwarded-Proto`. A proxy that drops the header yields `http://` or `host:4873` tarball URLs, which an `https:` hello entry does not cover: under a per-registry list the request fails, and in the global chain it goes out anonymously ([Registry matching](../phase-2-credential-provider.md#registry-matching)). The fix is `VERDACCIO_PUBLIC_URL` on the server.
- **Covering npmjs.com "because Verdaccio proxies it".** Verdaccio uses its own uplink token, so a private npmjs package behind it is readable by whoever Verdaccio's `access` rule admits. A provider for Verdaccio does not belong in the chain for registry.npmjs.org.
- **Skewed clocks across nodes.** Because of `notBefore`, a freshly minted JWT can get 401 `jwt not active` from a lagging node. The provider's retry returns the same token, which is by then valid, so this case is the one where answering the retry with the same token is right.

## What this registry asks of the RFC

- **A 403 does not say why** ([erase](../phase-2-credential-provider.md#erase-a-credential-was-rejected)). Verdaccio answers 403 for an ACL refusal, a read-only token on a write, a revoked key and an address outside the token's list ([token-auth.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/middleware/src/middlewares/token-auth.ts); the file names the error, and 403 is read from the helper's name). The RFC's table treats a 403 as "accepted but lacks permission", with no erase, and warns against widening `read`; it says nothing about a credential that died as a 403. The retry request carries only the status, so the provider needs a probe of its own. The retry could carry the registry's error text (as `authChallenges` carries the challenge), or the RFC could say that a provider may probe and answer `other` when the probe shows the credential dead. **Settled:** the retry names the context, not the reason; a provider that needs the reason checks against the `registry` the request names, and one with nothing else to release answers `other`.
- **The web-login source's same-origin rule** ([Future possibilities](../phase-2-credential-provider.md#a-built-in-web-login-source)). It polls the done URL "only on the origin it posted to". Verdaccio builds the login and done URLs from the request's protocol and hostname and the server's local listening port ([login.ts](https://github.com/verdaccio/verdaccio/blob/master/packages/api/src/v1/login.ts)), so behind a TLS proxy the done URL is `https://host:4873/...`, another origin, and the rule would refuse every proxied Verdaccio. Failing closed is the safe side; relaxing the rule to the same host would accept a port the registry chose. The RFC could name this as a known cost. A web login on Verdaccio also yields only a full-power, irrevocable token, so the future source's presence rule for non-`read` operations does not help for `read`. **Not adopted:** Future possibilities is non-normative and fails closed on purpose; the cost for this registry is recorded here.

Four points that look like gaps are answered by the RFC as it stands:

- **`operation-not-supported` for an endpoint the registry lacks.** The error table defines it as "Provider does not support this request kind or operation", and the Operations section says that Verdaccio, GitHub Packages and GitLab implement none of the access and trust endpoints. A provider for Verdaccio therefore answers it before any presence prompt, and releases no write credential for a request that cannot succeed.
- **What the retry `get` answers when the login is dead.** The RFC says that any answer but `Ok` fails the request, naming the provider. Answering `other` with the cure, as this page does, and answering `Ok` with the same token (a second doomed request, then an erase) are both allowed. The provider's `whoami` probe runs in the retry `get`, whose budget is 30 seconds, not in the erase, which is local cleanup.
- **Expiry and short-lived tokens.** The RFC's motivation names what a provider can still change on any registry: no standing secret in `.npmrc` or the environment ([Scope](../phase-2-credential-provider.md#scope)). Short lifetime comes from the registry. Verdaccio mints only with the password, has no default expiry and ignores a requested one, and turns an expired JWT into an anonymous request, so only `expiresAt` from a decoded `exp` helps. That is provider guidance, above.
- **`authChallenges` without the capability.** Capabilities are advisory and a provider ignores a field it does not use, so whether the client sends it makes no difference. The page assumes it is sent and ignored.
