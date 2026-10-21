# JFrog Artifactory

A hypothetical `npm-credential-provider-jfrog` for the npm repositories of JFrog Artifactory, on JFrog's SaaS (`*.jfrog.io`) or self-hosted. Artifactory authorizes by user and group permissions on repositories, not by token tier, and one access token is valid on the whole instance. The example shows a provider with one identity: a plain user whose short-lived tokens carry all the user's rights. It demonstrates what the operation split can and cannot do then, a 403 that cannot be widened, a registry URL that is not where the token endpoints are, and a CI job that exchanges its CI identity token with JFrog's own OIDC endpoint. Hosts, repositories and tokens in the transcripts are made up, and the clock in them reads 1792230000.

## Registry and credentials

**URLs the provider must match.** All of these are variations of one shape:

| URL | Notes |
|---|---|
| `https://<server>.jfrog.io/artifactory/api/npm/<repo>/` | SaaS. `<repo>` is the key of a local, remote or virtual npm repository ([docs](https://docs.jfrog.com/artifactory/docs/npm-repositories)). |
| `https://<host>/artifactory/api/npm/<repo>/` | Self-hosted behind the JFrog router or a reverse proxy. Host, port and any context path in front of `/artifactory` vary. Unverified, from memory. |
| `http://<host>:8081/artifactory/api/npm/<repo>/` | The legacy direct port, often plain `http:` on internal networks. Unverified, from memory. |
| `@<scope>:registry=https://<host>/artifactory/api/npm/<repo>/` | The scope-to-repository binding. One host has many repositories, each its own registry URL ([docs](https://docs.jfrog.com/artifactory/docs/npm-repositories)). |

JFrog's own Yarn Modern example leaves out `/artifactory` ([docs](https://docs.jfrog.com/artifactory/docs/npm-repositories)). Every other example keeps it, and nothing shows that the shorter form works. Tarballs live under the same prefix, `…/api/npm/<repo>/<pkg>/-/<file>.tgz` (unverified); a lockfile written against another repository on the host names another repository path.

The endpoints a provider needs are not under the registry URL. They are at the platform root: `POST /access/api/v1/tokens` (create and refresh), `POST /access/api/v1/oidc/token` (OIDC exchange), and `POST /access/api/v2/authentication/jfrog_client_login/request` with `GET …/token/<uuid>` (CLI web login) ([create token](https://docs.jfrog.com/administration/reference/createToken), [OIDC exchange](https://docs.jfrog.com/administration/reference/oidctokenexchange), [login.go](https://github.com/jfrog/jfrog-client-go/blob/01bb7dcd43fc42436689fd23893b2a8595c00ac3/access/services/login.go)). The reference provider calls two more. `DELETE /access/api/v1/tokens/me`, on logout, is documented: it revokes the token that makes the call, "requires a valid token", and users can revoke only their own tokens ([revoke token by ID](https://docs.jfrog.com/administration/reference/revoketokenbyid), read on 2026-10-21). `GET /access/api/v1/users/me`, only to name the user in the message of a 403, is recalled and unverified.

**Credentials.**

| Kind | How it is obtained | Lifetime | Scope |
|---|---|---|---|
| Access token (JWT) | `POST /access/api/v1/tokens` with `grant_type=client_credentials`; `Authorization: Bearer` ([access tokens](https://docs.jfrog.com/administration/docs/access-tokens)); the create call is [create token](https://docs.jfrog.com/administration/reference/createToken) | `expires_in`, relative seconds. The documentation disagrees on the default: 3600 s on the [Access Tokens](https://docs.jfrog.com/administration/docs/access-tokens) page, 365 days on [Security Configuration](https://docs.jfrog.com/administration/docs/security-configuration). `0` (never expires) is admin-only. | `applied-permissions/user` is the user's full permissions. Groups, roles and admin scopes need an admin. A non-admin can create user-scope tokens only for themself, except that a project admin can also mint tokens for roles in their projects ([access tokens](https://docs.jfrog.com/administration/docs/access-tokens), [`jf atc`](https://docs.jfrog.com/integrations/docs/jf-access-token-create)). |
| Identity token | The user, in the UI, or through the same API; shown once, stored hashed ([identity tokens](https://docs.jfrog.com/user-management/docs/identity-tokens)) | Platform default and maximum; revoked when the user is deleted or disabled | The user's permissions |
| Refresh token | `refreshable=true` at creation; `grant_type=refresh_token` to use it ([access tokens](https://docs.jfrog.com/administration/docs/access-tokens)); the provider never sends it to the registry, which is its design and not something the page says | Refresh works for 24 hours after expiry by default (`token.refresh-expiry`), and only on the instance that issued it | A new token of the same privileges |
| CLI web-login token | What `jf login` gets: a browser session confirmed by a code, polled every 3 s for at most 5 minutes; Artifactory 7.64.0 or later ([login.go](https://github.com/jfrog/jfrog-client-go/blob/01bb7dcd43fc42436689fd23893b2a8595c00ac3/access/services/login.go), [weblogin.go](https://github.com/jfrog/jfrog-cli-core/blob/962c06a76108764450640c3d9c3cb0e010bd048b/artifactory/utils/weblogin.go)) | Not documented | User |
| npm login token | `npm login` against the repository URL; web login since 7.52 | 30 days by default ([JFrog KB](https://jfrog.com/help/r/artifactory-how-to-modify-the-expiration-date-of-the-token-generated-by-the-npm-login-command); the page is built in the browser by JavaScript and has no saved text, so this figure and the 7.52 are not checked against a copy) | User |
| OIDC-exchanged token | `POST /access/api/v1/oidc/token` with the CI's ID token and a provider name; the request needs no JFrog credential, since the [OIDC integration](https://docs.jfrog.com/administration/docs/openid-connect-integration) page's example sends a JSON body of `grant_type` (`urn:ietf:params:oauth:grant-type:token-exchange`), `subject_token_type`, `subject_token` and `provider_name` with no `Authorization` header (read on 2026-10-21); that no refresh token is returned is recalled: the saved [OIDC exchange](https://docs.jfrog.com/administration/reference/oidctokenexchange) page lists the request parameters only, and the example reads `access_token` from the answer | The duration configured in the identity mapping, which that page calls short-lived; that the answer carries it as `expires_in` is recalled | Set by the matching identity mapping, which matches the ID token's claims to a user, group or resource scope ([OIDC integration](https://docs.jfrog.com/administration/docs/openid-connect-integration) page) |
| Username and password | The user's own; internal users only. Repeated failures suspend the account, with 403, for up to 60 s ([security configuration](https://docs.jfrog.com/administration/docs/security-configuration)) | Until changed | The user's permissions |

A reference token is a 64-character stand-in for a JWT. JFrog documents it as usable with the `X-JFrog-Art-Api` header or as basic credentials, and says reference tokens are short (64 characters) ([identity tokens](https://docs.jfrog.com/user-management/docs/identity-tokens)); that a `Bearer` header works with one on the npm API is unverified. The provider does not use it. It also does not use the `/api/npm/auth` endpoint, which returns a pre-encoded `_auth` and, as a comment in JFrog's own CLI says, does not handle group tokens well ([npmcmdutils.go](https://github.com/jfrog/jfrog-cli-core/blob/ad12ac6f1316ad905847f79be5f58a813306c6e8/artifactory/commands/utils/npmcmdutils.go)).

No token carries a repository or an operation. What it can do is what its user can do: Read, Deploy, Delete and so on on the repositories that permission targets name. Narrowing happens through groups and permission targets, which an admin sets.

## Configuration

```ini
# ~/.npmrc
//acme.jfrog.io/artifactory/api/npm/:credentialProvider[]=npm-credential-provider-jfrog --url https://acme.jfrog.io
@acme:registry=https://acme.jfrog.io/artifactory/api/npm/npm-virtual/
```

- **One per-registry key at `/artifactory/api/npm/`** covers every repository on the host, because npm walks up the request path one segment at a time ([Registry matching](../phase-2-credential-provider.md#registry-matching)). The `registry` the provider receives is then the key, `https://acme.jfrog.io/artifactory/api/npm/`, for every repository, so with `granularity` `registry` npm asks once for all of them. A key per repository would make npm ask once per repository for the same token.
- **It is a per-registry key, not the global chain,** so the provider starts only for this host ([Session lifecycle](../phase-2-credential-provider.md#session-lifecycle)). If every Artifactory host of the user should be served, the global form works with the hello `registries` below. The provider then receives the chosen registry, one URL per repository, on one reading of the RFC (see [What this registry asks of the RFC](#what-this-registry-asks-of-the-rfc)).
- **`--url` names the platform root.** The token, OIDC and login endpoints are not under the registry URL. They move with reverse-proxy context paths, with the `:8081` direct port and with the `/api/npm/` variant that has no `/artifactory`. The provider takes the root from its own configuration, the `--url` argument in the user's `.npmrc` line or `url` in its settings file (the argument wins), and never derives it from `registry` or from an `authChallenges` realm ([erase](../phase-2-credential-provider.md#erase-a-credential-was-rejected)).
- **The reference provider's other settings.** Read from its settings file (`--config`): `oidcProvider`, the name of the OIDC provider the CI exchange asks for (see [CI](#ci)), and `oidcAudience`, the `audience` the provider asks GitHub Actions to put in the ID token (that GitHub's endpoint takes an `audience` query parameter is recalled). `endpoints` and `clock` redirect the calls to a fake server and stamp them with the test clock; they exist for the conformance run and are not settings.
- **No `http:` here by default.** A self-hosted `http://host:8081` install needs its own key and its own hello entry. The user adds them on purpose, since the same token would then travel in clear text.

## Hello

```json
{"v":[1],"capabilities":["login","logout","erase"],"registries":["https://acme.jfrog.io/artifactory/api/npm/"]}
```

- `v`: protocol version 1 only.
- `login`, `logout`: the provider runs the CLI web login and deletes its stored login.
- `erase`: it drops the token it minted when npm says Artifactory rejected it.
- It reads `httpStatus` on a retry to tell a 401 from a 403, and announces nothing for it, since npm sends the retry fields to every provider. It reads no `authChallenges`: Artifactory's challenge is `Basic realm="Artifactory Realm"` even when a Bearer token was sent (unverified, from memory), so nothing in it would change what the provider does. In particular it is no reason to send Basic.
- `registries`: the npm API prefix. It covers all npm repositories at a segment boundary and nothing else, so npm sends the provider nothing about other hosts. It is an `https:` entry; it does not cover the `http:` form.

## Install

[install.jsonl](jfrog-artifactory/install.jsonl)

```json
{"v":1,"kind":"get","registry":"https://acme.jfrog.io/artifactory/api/npm/","scope":"@acme","package":"widgets","operation":"read","command":"install","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-user-token"},"cache":"expires","expiresAt":1792233600,"operationIndependent":true,"granularity":"registry"}}
```

The provider holds a long-lived login in the OS keychain: a refresh token or an identity token. It trades it, once per session, for a short token with `POST /access/api/v1/tokens`, always with an explicit `expires_in` of 3600 and `refreshable=false`. It never leaves `expires_in` out, because the platform default may be a year ([access tokens](https://docs.jfrog.com/administration/docs/access-tokens), [security configuration](https://docs.jfrog.com/administration/docs/security-configuration)).

- `scope` and `package` are ignored: a token is not bound to either.
- `expiresAt` is the clock when the request went out plus `expires_in` (not the clock when the answer came back, which would overstate the lifetime by the time the call took), since the API returns seconds, not a timestamp ([authutils.go](https://github.com/jfrog/jfrog-client-go/blob/0f2168d025589514c92d4c71ed5ad051d58274e4/auth/authutils.go)). A token with no `expires_in` gets `cache: "session"`, never `"expires"`.
- `operationIndependent` is `true` and `granularity` is `registry`: the same token is what the provider would hand out for any operation, and for any repository on the instance. It reuses the one minted token for every `get` of the session.
- The token is a JWT. A reference token would be opaque and carry no `exp`.

**A refresh that rotates the refresh token.** [install-rotated-refresh.jsonl](jfrog-artifactory/install-rotated-refresh.jsonl). Whether Artifactory's refresh grant hands out a new refresh token is unverified; the provider takes one if the answer carries one, and stores it before it answers, replacing the old one and keeping the stored access token. In the transcript the short token lapses between two `get`s of one session, so the second mint is a refresh again, and the platform accepts only the refresh token the first one returned. The second `get`:

```json
{"v":1,"kind":"get","registry":"https://acme.jfrog.io/artifactory/api/npm/","scope":"@acme","package":"gadgets","operation":"read","command":"install","interactive":false}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-user-token-2"},"cache":"expires","expiresAt":1792237300,"operationIndependent":true,"granularity":"registry"}}
```

## Publish

[publish.jsonl](jfrog-artifactory/publish.jsonl)

```json
{"v":1,"kind":"get","registry":"https://acme.jfrog.io/artifactory/api/npm/","scope":"@acme","package":"widgets","version":"1.4.0","operation":"publish","command":"publish","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-user-token"},"cache":"expires","expiresAt":1792233600,"operationIndependent":true,"granularity":"registry"}}
```

Artifactory serves publish, `dist-tag` ([dist-tag.jsonl](jfrog-artifactory/dist-tag.jsonl), a command and so a session of its own), `deprecate` and `unpublish` from the same user-scope token. A publish needs Deploy on the target repository (through a virtual repository, on its Default Deployment Repository); an unpublish also needs Delete. All of this is from memory and not verified against the current documentation. The transcript also shows a `dist-tag` request, answered with the same token. The reference provider serves all four on that footing. What it risks is not what a wrong guess costs on [GitHub](github-packages.md#publish): the token is the one every `read` already gets, so an endpoint that answers 404 or 405 costs a failed request and releases nothing more.

The provider answers the operations Artifactory has no npm endpoint for with `operation-not-supported` ([Request kinds](../phase-2-credential-provider.md#3-request-kinds)): `stage`, `stage-read`, `stage-reject`, `owner`, `access`, `trust` and `account` (unverified, from memory). The answer is [stage-unsupported.jsonl](jfrog-artifactory/stage-unsupported.jsonl):

```json
{"v":1,"kind":"get","registry":"https://acme.jfrog.io/artifactory/api/npm/","scope":"@acme","package":"widgets","version":"1.5.0","operation":"stage","command":"stage","interactive":true}
{"Err":{"kind":"operation-not-supported","message":"Artifactory has no staged publishing for npm"}}
```

The user's token is the one every `read` already gets, so serving these would release nothing more than a read does. They are refused because there is nothing to send it to: Artifactory has no npm endpoint for them (unverified, from memory), the request could only fail, and a failure from a missing endpoint looks like a permission problem to the user. `dist-tag`, `deprecate` and `unpublish` have npm endpoints and are served on the page's unverified word.

The operation split protects nothing in this setup. A plain user's `read` token can publish, so `operationIndependent: false` with a presence prompt for publish would only look safer. The split works only where an admin provisions a read-only group or service identity, or an OIDC identity mapping that grants only a group (group-scoped tokens are documented on the [access tokens](https://docs.jfrog.com/administration/docs/access-tokens) page, which also warns to audit Auto Join groups where OIDC identity mappings are used; a mapping can grant a `groups` scope, as the [OIDC integration](https://docs.jfrog.com/administration/docs/openid-connect-integration) page shows).

Then `read` gets that identity, and `publish`, `dist-tag`, `deprecate` and `unpublish` get the user's own token after a presence check, with `operationIndependent: false`. The main lever for a plain user is the short expiry.

This is a deliberate departure from the RFC's default, a presence prompt for every write credential when `interactive` is `true` ([Threat model](../phase-2-credential-provider.md#threat-model)): a prompt before `publish` would gate a credential that a script obtains with no prompt by asking for `read`, so it would protect nothing and only look as if it did. Gating `read` as well would break every install. The limit stays until the registry offers a narrower identity: a read-only group or service identity, or an OIDC identity mapping, as above, and then the split above applies with the presence prompt on the writes.

A publish to a virtual repository that has no Default Deployment Repository fails, and a dist-tag set on a virtual repository can resolve by member order on a later read. Neither is an authorization problem, and both look like one to the user.

## Rejection

[rejection.jsonl](jfrog-artifactory/rejection.jsonl)

```json
{"v":1,"kind":"erase","registry":"https://acme.jfrog.io/artifactory/api/npm/","scope":"@acme","package":"widgets","operation":"read","granularity":"registry","authChallenges":["Basic realm=\"Artifactory Realm\""]}
{"Ok":{"kind":"erase"}}
{"v":1,"kind":"get","registry":"https://acme.jfrog.io/artifactory/api/npm/","scope":"@acme","package":"widgets","operation":"read","command":"install","interactive":false,"retry":true,"httpStatus":401,"authChallenges":["Basic realm=\"Artifactory Realm\""]}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-user-token-2"},"cache":"expires","expiresAt":1792233600,"operationIndependent":true,"granularity":"registry"}}
```

**401.** By default an unauthenticated request for a protected resource gets 401 ([security configuration](https://docs.jfrog.com/administration/docs/security-configuration)). An expired or invalid token gets 401 too, not an anonymous fallback, with the Basic challenge above (unverified, from memory). The challenge names neither `otp` nor `ipaddress`, so npm erases and retries once.

- **Erase** drops the minted token and the provider's in-process copy. It keeps the login. Tokens under the revocable threshold (6 hours by default) cannot be revoked on the server, so the erase is local ([access tokens](https://docs.jfrog.com/administration/docs/access-tokens)).
- **The retry** mints a fresh token with the stored login. A 401 does not prove the login is dead: the URL may be one a lockfile chose. If the mint itself is refused with 401, the login is dead, and the provider answers `other`, naming `npm login` ([install-login-refused.jsonl](jfrog-artifactory/install-login-refused.jsonl)). It starts no browser flow, in this request or any other that is not `login` ([erase](../phase-2-credential-provider.md#erase-a-credential-was-rejected)).
- If the rejected credential is the stored identity token itself, handed out as it is, erase keeps it and the rejection is reported, naming `npm logout` and `npm login`, and no later `get` of the session hands it out again either, even though the refused mint would otherwise fall back to it ([rejection-dead-identity-token.jsonl](jfrog-artifactory/rejection-dead-identity-token.jsonl)):

```json
{"v":1,"kind":"erase","registry":"https://acme.jfrog.io/artifactory/api/npm/","scope":"@acme","package":"widgets","operation":"read","granularity":"registry","authChallenges":["Basic realm=\"Artifactory Realm\""]}
{"Ok":{"kind":"erase"}}
{"v":1,"kind":"get","registry":"https://acme.jfrog.io/artifactory/api/npm/","scope":"@acme","package":"widgets","operation":"read","command":"install","interactive":false,"retry":true,"httpStatus":401,"authChallenges":["Basic realm=\"Artifactory Realm\""]}
{"Err":{"kind":"other","message":"Artifactory rejected the stored identity token. Run npm logout and npm login for https://acme.jfrog.io/artifactory/api/npm/."}}
```

The transcript's first request answers with the identity token as it is, `cache: "session"` and no expiry, since the provider knows none. The provider does that only when the mint is refused with 403, a user who may not create tokens (an assumption of the example, run by [the provider](providers/jfrog-artifactory/provider.js)); otherwise it trades the identity token for a short one.

An identity token goes dead when the user is deleted or disabled, or when the token is revoked in the UI ([identity tokens](https://docs.jfrog.com/user-management/docs/identity-tokens), read again on 2026-10-20). The status Artifactory then returns is not documented on that page, nor on the [security configuration](https://docs.jfrog.com/administration/docs/security-configuration) page, which gives 401 only for a request with no authentication: the 401 here is the page's recalled one.

What the provider does with the dead token:

- Erase must not delete the identity token: it is what `login` stored, and `logout` removes it.
- No login flow starts on a request that is not a `login`; the person has to sign in again.
- The answer is `other`, not `not-found`: the provider holds a dead login, and `not-found` would let a listed `npm:token` answer in its place.

The same answer follows when the mint with a stored refresh token or identity token is itself refused with 401, as described above; only the message differs.

**403.** Without permission an authenticated user gets 403 ([security configuration](https://docs.jfrog.com/administration/docs/security-configuration)). npm sends no erase and retries once with `httpStatus: 403`. A provider with one identity has nothing wider to move to, and answering with the same token wastes the retry. It answers `other`, and npm shows the message and fails the request. The user's name comes from `GET /access/api/v1/users/me` with the token it handed out, a minted one or the identity token as it is ([publish-403-identity-token.jsonl](jfrog-artifactory/publish-403-identity-token.jsonl)) (recalled, unverified); when that call fails the message says "The user". It is [publish-403.jsonl](jfrog-artifactory/publish-403.jsonl):

```json
{"v":1,"kind":"get","registry":"https://acme.jfrog.io/artifactory/api/npm/","scope":"@acme","package":"widgets","version":"1.4.0","operation":"publish","command":"publish","interactive":true,"retry":true,"httpStatus":403}
{"Err":{"kind":"other","message":"User alice has no Deploy permission on the repository that receives this publish. The provider holds no other identity."}}
```

Two other 403s look the same. A temporarily suspended account answers 403 to every request, up to 60 s, so a retry loop with bad Basic credentials extends the lockout. And with "Hide Existence of Unauthorized Resources" set, the 403 becomes 404 ([security configuration](https://docs.jfrog.com/administration/docs/security-configuration)): npm retries nothing, and a publish without permission shows as "not found". Where a lockfile points at another repository of the host and the user has only a read-only identity for the first, a read 403 never moves to the user's write-capable token ([erase](../phase-2-credential-provider.md#erase-a-credential-was-rejected)).

## Login and logout

[login.jsonl](jfrog-artifactory/login.jsonl), [login-token.jsonl](jfrog-artifactory/login-token.jsonl), [logout.jsonl](jfrog-artifactory/logout.jsonl)

```json
{"v":1,"kind":"login","registry":"https://acme.jfrog.io/artifactory/api/npm/","interactive":true}
{"Ok":{"kind":"login"}}
```

The `login` request has no username or password, so Artifactory's legacy `npm login` cannot be delegated as it is. The provider offers two flows instead:

1. **Web login, on Artifactory 7.64.0 or later.** It posts a fresh session id to `/access/api/v2/authentication/jfrog_client_login/request` under `--url`, opens `/ui/login?jfClientSession=<id>` in the browser and writes the last four characters of the id on the controlling terminal as a code to compare. It polls `…/token/<id>` every 3 s: 400 means pending and 200 means done ([login.go](https://github.com/jfrog/jfrog-client-go/blob/01bb7dcd43fc42436689fd23893b2a8595c00ac3/access/services/login.go), [weblogin.go](https://github.com/jfrog/jfrog-cli-core/blob/962c06a76108764450640c3d9c3cb0e010bd048b/artifactory/utils/weblogin.go)). It stores the result in the OS keychain. It polls for 4.5 minutes, not the 5 of the CLI: npm kills a `login` at 5 minutes ([Timeouts](../phase-2-credential-provider.md#session-lifecycle)), and a provider that waits as long as the CLI is killed before it can answer.
2. **A pasted identity token.** With a `token` field ([login-token.jsonl](jfrog-artifactory/login-token.jsonl)) the provider stores it as the login. This also serves instances older than 7.64 and users for whom web login is not an option.

Username and password are no substitute: SSO and SAML users have no usable password, multi-factor authentication blocks Basic for token creation, and creating a token with Basic needs an admin setting (7.63.2 or later, from a comment in [accesstoken.go](https://github.com/jfrog/jfrog-client-go/blob/756731f0df6308ef5f2a688ad109b0d88ead7f41/access/services/accesstoken.go)). A provider that wants them prompts on the controlling terminal itself. npm's own web login works from 7.52 but writes a token into `.npmrc`, which a provider must not do.

```json
{"v":1,"kind":"logout","registry":"https://acme.jfrog.io/artifactory/api/npm/"}
{"Ok":{"kind":"logout"}}
```

**When the web login is not completed.** [login-not-completed.jsonl](jfrog-artifactory/login-not-completed.jsonl). The poll answers 400 until the person has confirmed in the browser, and the CLI's own limit is 5 minutes ([login.go](https://github.com/jfrog/jfrog-client-go/blob/01bb7dcd43fc42436689fd23893b2a8595c00ac3/access/services/login.go), [weblogin.go](https://github.com/jfrog/jfrog-cli-core/blob/962c06a76108764450640c3d9c3cb0e010bd048b/artifactory/utils/weblogin.go)). The pages read document no way to refuse the request on the JFrog side and no error for it, so a login that is not completed is a login that times out, and the provider's limit of 4.5 minutes comes before npm's 5. The provider stores nothing and answers `other`:

```json
{"v":1,"kind":"login","registry":"https://acme.jfrog.io/artifactory/api/npm/","interactive":true}
{"Err":{"kind":"other","message":"Stopped waiting for the web login after 4 minutes 30 seconds. Run npm login again."}}
```

With no controlling terminal the provider cannot show the login page either, so it does not wait for it: it stops at once, without polling, and answers `other` naming `npm login` to run from a terminal. Nothing is stored, and the session it started at Artifactory lapses unused ([login-no-terminal.jsonl](jfrog-artifactory/login-no-terminal.jsonl)).

An instance older than 7.64.0 answers the request for a session with an error rather than a login page (unverified, from memory); the provider then answers `other` as well, telling the person to paste an identity token ([login-unsupported.jsonl](jfrog-artifactory/login-unsupported.jsonl); the paste itself is [login-token.jsonl](jfrog-artifactory/login-token.jsonl)).

`logout` ([logout.jsonl](jfrog-artifactory/logout.jsonl)) deletes the keychain entries first and then tries to revoke the stored long-lived token on the server, so that an Artifactory that is slow or down cannot keep the login (the RFC: a logout always removes the local credentials), and answers `Ok` even if the revocation failed, with a warning on stderr ([logout-not-revocable.jsonl](jfrog-artifactory/logout-not-revocable.jsonl)). Revocation works only on the instance that issued the token, and only for tokens above the revocable threshold.

The call is `DELETE /access/api/v1/tokens/me` with the stored identity token, or the access token of a web login, as the bearer: Revoke Token by ID, where `me` stands for the token making the call. Users can revoke only their own tokens, which is the plain user this example is about ([revoke token by ID](https://docs.jfrog.com/administration/reference/revoketokenbyid), read on 2026-10-21). The by-value call, `DELETE /access/api/v1/tokens/revoke` with the token in a body field, is not used: its page says it requires admin privileges, so a plain user's logout would get 403 ([revoke token by value](https://docs.jfrog.com/administration/reference/revoketokenbyvalue)).

The refresh token of a web login ([logout-web-login.jsonl](jfrog-artifactory/logout-web-login.jsonl)) is not revoked. The pages read say nothing of presenting a refresh token as a bearer, so `me` cannot name it, and nothing of whether revoking the access token ends its refresh either, so the provider writes a warning on stderr that it stays valid until its refresh period ends (24 hours after expiry by default, [access tokens](https://docs.jfrog.com/administration/docs/access-tokens)). The tokens it hands to npm last an hour, below the revocable threshold, so they cannot be revoked and live until their `expiresAt`.

## CI

[ci.jsonl](jfrog-artifactory/ci.jsonl), [ci-not-found.jsonl](jfrog-artifactory/ci-not-found.jsonl), [ci-publish.jsonl](jfrog-artifactory/ci-publish.jsonl)

```json
{"v":1,"kind":"get","registry":"https://acme.jfrog.io/artifactory/api/npm/","scope":"@acme","package":"widgets","operation":"read","command":"ci","interactive":false}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-oidc-token"},"cache":"expires","expiresAt":1792231800,"operationIndependent":true,"granularity":"registry"}}
```

With `interactive: false` the provider opens no browser and starts no login ([Non-interactive and CI behavior](../phase-2-credential-provider.md#non-interactive-and-ci-behavior)).

If an OIDC provider name is in its configuration and the CI's ID-token variables are in its environment (GitHub Actions sets `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`), it exchanges the ID token at `/access/api/v1/oidc/token` under `--url` and returns the result.

- The provider takes the two variables as the job's own: it asks the URL one for the ID token with the other as the bearer, as the job's own tools do, so a process that can set them has the job's ID-token capability already.
- The scope is whatever the identity mapping in Artifactory grants, which an admin can limit to a read-only group (a mapping can grant a group scope, `applied-permissions/groups:<group>`, and a resource scope such as `artifact:<repo>/**:r`: [OIDC integration](https://docs.jfrog.com/administration/docs/openid-connect-integration), read on 2026-10-21; see [Publish](#publish)).
- The exchange returns no refresh token. If it is rejected, the next `get` exchanges again.

With neither an OIDC setup nor a stored token the provider answers `not-found`, as in [ci-not-found.jsonl](jfrog-artifactory/ci-not-found.jsonl), and npm fails or moves on along the chain, but nothing is opened.

A publish in CI is the same exchange for a different job ([ci-publish.jsonl](jfrog-artifactory/ci-publish.jsonl), its own session). `interactive` is `false`, so no presence is asked; what the token may do is again the identity mapping's, so the publish job's OIDC provider name must map to an identity with Deploy on the target repository, and the install job's to a read-only one:

```json
{"v":1,"kind":"get","registry":"https://acme.jfrog.io/artifactory/api/npm/","scope":"@acme","package":"widgets","version":"1.4.1","operation":"publish","command":"publish","interactive":false}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-oidc-publish-token"},"cache":"expires","expiresAt":1792231800,"operationIndependent":true,"granularity":"registry"}}
```

The saved [OIDC exchange](https://docs.jfrog.com/administration/reference/oidctokenexchange) page (read again on 2026-10-20) lists the request parameters, among them `identity_mapping_name`, and nothing about the response or the scope: that the token's scope comes from an identity mapping is documented on the [OIDC integration](https://docs.jfrog.com/administration/docs/openid-connect-integration) page (read on 2026-10-21), which also shows that a mapping can grant a group or a resource scope; that a mapping can grant Deploy, and so that a mapped token publishes, is **not verified** beyond the permissions model above.

The answer is `operationIndependent: true` as in the install: the provider has one exchange per job and the mapping, not the provider, is where a publish identity differs from a read one. A provider with no OIDC setup and nothing stored answers `not-found` here, as for a read.

This is JFrog's exchange, not npm's trusted publishing. The npm exchange goes to npm's own endpoint, which Artifactory does not implement (unverified), so it fails and leaves the chain in charge ([Trusted publishing](../phase-2-credential-provider.md#error-response)). The token may belong to a transient user, who cannot run `npm login`.

## Where it is easy to go wrong

- **Treating the read token as read-only.** On Artifactory a plain user's token carries their Deploy and Delete rights. Prompting for publish while handing the same token out for `read` protects nothing.
- **Omitting `expires_in`.** The default is 3600 s in one JFrog page and a year in another. Always send it, and convert the relative value to an absolute `expiresAt`.
- **Answering a 403 with the same token.** It uses the one retry and changes nothing. Answer `other` with what was missing.
- **Retrying bad Basic credentials after 403.** A suspended account answers 403 and each attempt extends it.
- **Minting a token per repository.** The token is valid on the whole instance. Keep one minted token for the session and give it to every `get`, or an install across several repositories mints and, above three hours, stores one token each.
- **Deriving `--url` from `registry`.** The platform root is not the registry minus a suffix: it differs behind a context path, on `:8081`, and in the Yarn Modern form. Take it from configuration.
- **Reading the challenge as an instruction.** The 401 challenge is Basic for Bearer requests. It does not say to send Basic.
- **Relaying `/api/npm/auth` output.** It is a pre-encoded `_auth`, and it mishandles group tokens. If Basic is needed, decode it into `{"type":"basic","username":…,"password":…}`.
- **Polling as long as the CLI.** The CLI's 5-minute web-login poll equals npm's `login` timeout, so the provider is killed before its own timeout fires. Stop at 4.5 minutes.
- **Expecting `logout` or `erase` to revoke what npm holds.** Tokens below the revocable threshold cannot be revoked, and those under the persistency threshold (3 hours by default) are not stored at all.
- **Rotating the refresh token without care.** If a refresh rotates the refresh token (unverified), two npm commands at once, each with a provider process, race, and the loser presents a used token. Update the keychain atomically and read it again after a failure before calling the login dead.
  - The reference provider does the first half only: it stores a rotated refresh token whole or not at all ([rotation](#install), [install-rotated-refresh.jsonl](jfrog-artifactory/install-rotated-refresh.jsonl)), but a 401 on a refresh is final for it, with no second read.
  - That is a limit of the example. The loser of the race would need the winner's write to land in the store between its two reads, which a run cannot stage with one provider process against a fake that has no hand on the store, so the branch would have no transcript. A rotation is itself unverified.
- **Sending a request to endpoints that do not exist.** Answer `stage`, `owner`, `access`, `trust` and `account` with `operation-not-supported`: on a one-identity registry the token is the `read` one, so nothing extra leaks, but the request can only fail, and as a 404 or 405 it reads as a permission problem.
- **Matching the wrong scheme.** An `https:` hello entry does not cover `http://host:8081`. A provider that serves both, with one token, exposes it on the wire.
- **Starting a login from a 401.** The URL may be one a lockfile chose. Confirm with a mint first.

## What this registry asks of the RFC

- **Which URL a request carries ([Registry matching](../phase-2-credential-provider.md#registry-matching), "What is sent").** "The key's or the chosen registry's" does not say what a request matched only by a hello `registries` entry carries, as in the global chain: the hello entry (`…/api/npm/`), or the chosen registry (`…/api/npm/npm-virtual/`). A provider's own cache, and whether `url-not-supported` is remembered per repository or per host, depend on it. This page reads it as the chosen registry. The text should say that `registry` is always the key or the chosen registry, never the hello entry. **In the RFC:** it is the chosen registry's URL; a hello entry is never what is sent.
- **Erase when one token serves several cache entries ([erase](../phase-2-credential-provider.md#erase-a-credential-was-rejected)).** npm removes "every cache entry that served the credential". With a global chain, the same token string may sit in entries for several repositories. The text does not say whether "served" is by credential value or by answer, so one 401 may leave a dead token cached for the other repositories, and cost a second erase and retry. It should say by value. **In the RFC:** erase evicts by value, whatever answer, granularity or registry URL the credential was cached under.
- **No answer that sends a request anonymously ([Error response](../phase-2-credential-provider.md#error-response), [Legacy fallback](../phase-2-credential-provider.md#legacy-fallback)).** Many Artifactory repositories allow anonymous reads. A per-registry provider with nothing stored can answer only `not-found` or `url-not-supported`, and both fail the request. In a global chain `url-not-supported` goes out anonymously, but it is remembered per registry for the command, so a publish to the same registry after it also goes out anonymously. The RFC could add an explicit "no credential" answer, or say what a `not-found` under a per-registry list does. **Not in the RFC:** an anonymous fall-through would turn a visible provider failure into an anonymous request that private registries refuse with a misleading error; legacy fallback fixes the outcome by design.
- **Providers reading their own environment ([Security model](../phase-2-credential-provider.md#6-security-model), "Input").** "Nothing in a request is an environment variable or a file path" can be read as forbidding the CI ID-token variables the OIDC exchange needs. The Phase 1 environment filter passes them. The text should say that it constrains what npm passes in, not what a provider reads from its own environment. **In the RFC:** the Input bullet says the environment the provider starts with is separate from the request, and CI needs it.
- **Capabilities for the retry and challenge fields ([Version negotiation](../phase-2-credential-provider.md#version-negotiation)).** An earlier draft listed two capabilities for them without saying what announcing them promised. **In the RFC:** npm sends those fields to every provider, so a provider announces nothing to receive them, and the two capabilities are gone.
- **The operation split on a one-identity registry ([Operations](../phase-2-credential-provider.md#4-operations), [Threat model](../phase-2-credential-provider.md#threat-model)).** The last threat row relies on "short-lived, narrow read credentials". A plain Artifactory user cannot mint one, so only expiry is left. The Phase 1 `jf atc --expiry=3600` row should say that a token then carries all the user's rights, and that omitting `--expiry` gives the platform default. **In the RFC:** the threat row says read credentials are narrow where the registry allows it, and Phase 1 notes that `jf atc` does not narrow to reading.
- **A 403 with nothing to widen to ([erase](../phase-2-credential-provider.md#erase-a-credential-was-rejected)).** The rule fits, but it spends the one retry on nothing. A provider that knows it has one identity can answer from `retry: true` and `httpStatus: 403` only. A hint in hello would let npm skip it; this is a possible optimization, not a defect. **Not in the RFC:** covered by the 403 rule and the retry bullet, which says such a provider answers `other`; a hello hint to save one local exchange on an error path is not worth a field.
