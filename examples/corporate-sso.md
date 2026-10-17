# Corporate SSO gateway

A company runs a private npm registry behind an SSO gateway. Developers sign in to the company identity provider (IdP) with an OIDC device-code login, and the gateway accepts only short-lived tokens that a provider mints for each request scope. This page describes a hypothetical `corp-npm-credential-provider` for it. The gateway, the IdP, their endpoints and every number below (token lifetimes, windows, role names) are invented for the example: they are one company's policy, not facts about a product. Only the device flow is taken from a standard, [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628). The page shows a global provider chain whose hello lists the company's registries, prompts on the controlling terminal, a publish credential gated on user presence, a refusal (`other`, not `not-found`) where presence would be needed but `interactive` is `false`, and CI with a non-interactive service identity.

Every exchange below is a transcript in [corporate-sso/](corporate-sso/) that the repository's model accepts (`python -m unittest tests.test_examples`). The `other` answers are transcripts too: the model fails that request and goes on ([What this registry asks of the RFC](#what-this-registry-asks-of-the-rfc)).

## Registry and credentials

**URL shapes the provider must match.** The gateway has one host per region. Both serve the registry at the root:

- `https://npm.corp.example.com/`
- `https://npm-eu.corp.example.com/`

The gateway also proxies the public registry for unscoped packages, so the default `registry` points at the first host. Any other host, `registry.npmjs.org` included, is not the provider's business, and the `http:` form of a company host is not either ([Registry matching](../phase-2-credential-provider.md#registry-matching)).

**Credential kinds** (all hypothetical, except where a standard is cited):

| Credential | Who holds it | Lifetime | Source |
|---|---|---|---|
| IdP refresh token, from the device-code login | The provider, in the OS keychain | 10 hours of absolute session, ended early by revocation | Device flow: [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628), sections 3.1 to 3.5. Revocation: [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009) |
| Registry read token | npm, in memory | 15 minutes, minted per scope | Gateway policy. A request to the gateway's token endpoint carries the IdP access token and names the scope; this has the shape of a [token exchange](https://www.rfc-editor.org/rfc/rfc8693) but is not claimed to be one |
| Registry publish token | npm, in memory | 5 minutes, minted per package and version | Gateway policy; needs an IdP session whose last interactive sign-in is at most 5 minutes old (step-up) |
| CI service identity | A file in the runner image, readable only by the runner account | The IdP issues access tokens for it on request | Client credentials grant, [RFC 6749, section 4.4](https://www.rfc-editor.org/rfc/rfc6749#section-4.4) |

**Scopes.** A read token covers one npm scope, or the unscoped packages. A publish token covers one package at one version. The gateway answers a missing or expired token with 401 and `WWW-Authenticate: Bearer ..., error="invalid_token"`, and a token whose claims do not entitle the caller to the package with 403 (`error="insufficient_scope"`). It never asks for an npm one-time password; the IdP step-up replaces it.

**Device flow in short**, from RFC 8628: the provider posts its client id to the IdP's device authorization endpoint and gets a `device_code`, a `user_code`, a `verification_uri`, an `expires_in` and an `interval` (section 3.2). It shows the URI and the user code to the user, who opens them on any device (section 3.3). It then polls the token endpoint with the `urn:ietf:params:oauth:grant-type:device_code` grant at the given interval, 5 seconds if none was given, and handles `authorization_pending` (poll again), `slow_down` (add 5 seconds to the interval), `access_denied` and `expired_token` (stop) (sections 3.4 and 3.5).

## Configuration

```ini
# global npmrc, laid down by IT; the user's own ~/.npmrc works the same
credentialProvider[]=/opt/corp-npm/bin/corp-npm-credential-provider --idp https://idp.corp.example.com
registry=https://npm.corp.example.com/
@corp:registry=https://npm.corp.example.com/
@corp-data:registry=https://npm.corp.example.com/
@corp-secure:registry=https://npm.corp.example.com/
@corp-eu:registry=https://npm-eu.corp.example.com/
```

The provider is a global chain, not a per-registry list, for three reasons:

- A project `.npmrc` may add a scope that points at one of the company hosts, or move a scope to the other region. A per-registry key per host would have to be kept in step with that; the hello list is the company's own statement of which hosts are its own.
- The hello lists the registries ([Hello](#hello)), so npm sends this provider nothing about any other registry: not the host, the scope or the package. A global provider without that list would learn every package of every install.
- The path is absolute and the file is IT's, so [resolution](../phase-2-credential-provider.md#1-configuration) needs no `PATH` and no project directory.

The chain ends with the implicit `npm:token`. A user with a stored token for a company host does not hit it for the `https:` hosts, since the provider serves them. It does for the `http:` form of a host, which npm treats as answered `url-not-supported`, and npm then warns that it used the stored credential ([Legacy fallback](../phase-2-credential-provider.md#legacy-fallback)). Where that must fail instead, add a per-registry list for the host, which takes it out of the global chain:

```ini
//npm.corp.example.com/:credentialProvider[]=/opt/corp-npm/bin/corp-npm-credential-provider --idp https://idp.corp.example.com
//npm-eu.corp.example.com/:credentialProvider[]=/opt/corp-npm/bin/corp-npm-credential-provider --idp https://idp.corp.example.com
```

## Hello

```json
{"v":[1],"capabilities":["login","logout","erase","retry-context"],"registries":["https://npm.corp.example.com/","https://npm-eu.corp.example.com/"]}
```

- `v`: protocol version 1.
- `capabilities`: `login` and `logout` because the provider runs the device flow and revokes the session; `erase` so npm tells it when the gateway rejected a token (it drops its cached access token, not the refresh token); `retry-context` because it reads `httpStatus` on a retry to tell a 401 from a 403. They are advisory.
- `registries`: both company hosts, with the `https:` scheme and the trailing slash. npm does the matching, so the provider is asked for these two and no others, and an `http:` URL on the same host gets no credential from it.

## Install

[install.jsonl](corporate-sso/install.jsonl). `npm install` in a developer's terminal (`interactive` is `true`) with the IdP session alive. The provider refreshes the IdP access token silently, then asks the gateway for a read token for the request's scope. Nothing is shown to the user.

```json
{"v":1,"kind":"get","registry":"https://npm.corp.example.com/","scope":"@corp","package":"ui-kit","operation":"read","command":"install","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-read-token-corp"},"cache":"expires","expiresAt":1792197000,"operationIndependent":false,"granularity":"scope"}}
```

- Every other `@corp/*` package is a cache hit. `@corp-data/models`, the unscoped `left-pad` and `@corp-eu/maps` on the other host each get a `get` of their own, because the gateway mints per scope and the cache key holds the registry and the scope. An answer with `granularity: "scope"` for a request without a scope serves the unscoped packages ([Caching](../phase-2-credential-provider.md#5-caching)).
- `cache` is `expires` with a Unix time in seconds, 15 minutes ahead. npm stops using the entry 60 seconds early. The last pair in the file is a `get` for another `@corp` package well after that time: the install outlived the token, and the provider mints a new one.
- `operationIndependent` is `false`: the token reads and nothing else. npm binds an answer for an operation other than `read` to its operation anyway, but not a `read` answer, so `true` here would let a later `publish` lookup find the read token ([What this registry asks of the RFC](#what-this-registry-asks-of-the-rfc)).
- If the IdP session is gone, an interactive `get` starts a device flow on the terminal, exactly as `login` does ([Login and logout](#login-and-logout)). The 5-minute budget of an interactive `get` applies.
- If the session is gone and `interactive` is `false`, the provider held a session once and cannot renew it without the user ([session-expired.jsonl](corporate-sso/session-expired.jsonl)). It answers `other`, not `not-found`, so a stored token behind it in the chain does not stand in for the company's login ([Non-interactive and CI behavior](../phase-2-credential-provider.md#non-interactive-and-ci-behavior)):

```json
{"Err":{"kind":"other","message":"The corporate SSO session has expired. Run 'npm login --registry https://npm.corp.example.com/' in a terminal."}}
```

A machine where nobody ever logged in and no service identity exists has nothing stored, and the provider answers `not-found` there, in a terminal as well. It starts a device flow for `login`, and for an interactive `get` only where it held a session, so a global provider does not open a login page on every install of a machine that never signed in. No provider answers `Ok` then, so the install fails, naming the provider, unless the chain lists `npm:token` or `credential-provider-legacy-fallback` is set ([Legacy fallback](../phase-2-credential-provider.md#legacy-fallback)).

## Publish

[publish.jsonl](corporate-sso/publish.jsonl). The gateway supports `npm publish` and the writes that follow the same policy (`dist-tag`, `deprecate`, `unpublish`); it has no staging, no tokens, no teams and no trust endpoints, so a provider answers those operations `operation-not-supported`. A workspace publish of two packages from a terminal:

```json
{"v":1,"kind":"get","registry":"https://npm.corp.example.com/","scope":"@corp","package":"ui-kit","version":"2.4.1","operation":"publish","command":"publish","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-publish-token-ui-kit"},"cache":"expires","expiresAt":1792196400,"operationIndependent":false,"granularity":"package"}}
```

The provider's policy for `publish`:

1. The IdP session must have been interactively confirmed in the last 5 minutes. If it has not, the provider starts a device flow on the controlling terminal and waits.
2. It then asks on the controlling terminal: `Publish @corp/ui-kit@2.4.1 to npm.corp.example.com? [y/N]`. The prompt names the package and the version, which only a `publish` request carries.
3. It mints a token for that package and version, valid for 5 minutes, and answers with `granularity: "package"`.

The second request, for `@corp/ui-icons@3.0.0`, finds a fresh confirmation, so it shows only the `[y/N]` prompt. npm caches publish answers per operation and package, so each package in a workspace publish asks again; the provider asks the user once per package and the device flow once per five minutes. With `interactive: false` and no service identity, a publish gets ([publish-no-terminal.jsonl](corporate-sso/publish-no-terminal.jsonl)):

```json
{"Err":{"kind":"other","message":"Publishing @corp/ui-kit@2.4.1 needs a device-code confirmation, and no terminal is available. Run npm publish from a terminal, or from the release runner."}}
```

`npm publish --dry-run` sends `read`, so it asks for none of this ([Operations](../phase-2-credential-provider.md#4-operations)).

## Rejection

[rejection.jsonl](corporate-sso/rejection.jsonl) has two rejections.

**A 401, `invalid_token`.** The gateway revoked the token (an administrator disabled the user, or the key rotated). npm drops the cached entry and sends `erase` with the context of the `get` and its granularity, then one retry:

```json
{"v":1,"kind":"erase","registry":"https://npm.corp.example.com/","scope":"@corp","package":"ui-kit","operation":"read","granularity":"scope","authChallenges":["Bearer realm=\"https://npm.corp.example.com/\", error=\"invalid_token\""]}
{"Ok":{"kind":"erase"}}
{"v":1,"kind":"get","registry":"https://npm.corp.example.com/","scope":"@corp","package":"ui-kit","operation":"read","command":"install","interactive":true,"retry":true,"httpStatus":401,"authChallenges":["Bearer realm=\"https://npm.corp.example.com/\", error=\"invalid_token\""]}
```

Erase drops the gateway token and any copy the provider kept. It does not touch the refresh token in the keychain, which `login` stored. The retry mints a new token from the same session. If the IdP answers the refresh with `invalid_grant`, the provider's own check has confirmed that its login is dead; only then, and only if `interactive` is `true`, does it start a device flow. With `interactive` false it answers `other`. A 401 alone never starts a login.

**A 403, `insufficient_scope`.** The token for `@corp-secure` was minted before the user joined the group that entitles them to it. npm sends no erase, only the retry with `httpStatus: 403`:

```json
{"v":1,"kind":"get","registry":"https://npm.corp.example.com/","scope":"@corp-secure","package":"vault-client","operation":"read","command":"install","interactive":true,"retry":true,"httpStatus":403,"authChallenges":["Bearer realm=\"https://npm.corp.example.com/\", error=\"insufficient_scope\""]}
```

The provider fetches the user's current groups from the IdP and mints another read token. It would release that token for a plain `read` anyway; it does not widen to a publish token because the gateway said 403, which a hostile lockfile URL on the host could provoke. If the groups have not changed, it answers `other` naming the package, and the 403 stands. The retry goes out once; a second 403 is reported.

## Login and logout

[login.jsonl](corporate-sso/login.jsonl). `npm login --registry https://npm.corp.example.com/` sends `login` to the provider that serves the registry:

```json
{"v":1,"kind":"login","registry":"https://npm.corp.example.com/","interactive":true}
```

The provider starts the device flow ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628), sections 3.1 to 3.5) and writes the prompt to the controlling terminal (`/dev/tty`, or `CONOUT$` on Windows), never to stdout or stderr:

```
Open https://idp.corp.example.com/device and enter the code WDJB-MJHT
Waiting for approval (4:55 left) ...
```

It polls at the interval the IdP gave, slows down on `slow_down`, and stops at `access_denied`, `expired_token` or its own deadline of 4 minutes 30 seconds, which is inside npm's 5-minute `login` budget. On approval it keeps the refresh token in the OS keychain, writes nothing into any `.npmrc`, and answers `{"Ok":{"kind":"login"}}`. A cancelled or expired flow is `other` with the reason.

[logout.jsonl](corporate-sso/logout.jsonl):

```json
{"v":1,"kind":"logout","registry":"https://npm.corp.example.com/"}
{"Ok":{"kind":"logout"}}
```

`logout` revokes the refresh token at the IdP ([RFC 7009](https://www.rfc-editor.org/rfc/rfc7009)) as a best effort, always deletes the keychain entry, and answers `Ok` even if the IdP could not be reached, warning on stderr. One IdP session serves both company hosts, so the provider's logout for either host removes the session for both.

## CI

[ci.jsonl](corporate-sso/ci.jsonl). The runner image holds a service identity file readable only by the runner account, and the provider is in the image's global npmrc. `interactive` is `false`.

- Reads: the provider does a client credentials grant ([RFC 6749, section 4.4](https://www.rfc-editor.org/rfc/rfc6749#section-4.4)) for the service identity, then asks the gateway for a read token. Same answer shape as the install.
- Writes: only a service identity with the `npm-publisher` role, which the release runner image has and the test runners do not, gets a publish token. It has no presence and needs none; the role and the runner image are the gate, and the token is bound to the package and version for 5 minutes.

```json
{"v":1,"kind":"get","registry":"https://npm.corp.example.com/","scope":"@corp","package":"ui-kit","version":"2.4.1","operation":"publish","command":"publish","interactive":false}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-ci-publish-token"},"cache":"expires","expiresAt":1792196400,"operationIndependent":false,"granularity":"package"}}
```

On a runner whose identity lacks the role, the same request gets `other` naming the missing role, not `not-found`: the provider holds an identity and its policy withholds the credential. The provider never takes the identity from the environment or from a project file, since npm strips `npm_config_*` and the project controls the rest; the file's path and permissions are the image's.

## Where it is easy to go wrong

- **Polling the token endpoint faster than the IdP allows.** The default interval is 5 seconds, and `slow_down` adds 5 more, for the rest of the flow. A loop that ignores `slow_down` gets the client blocked ([RFC 8628, section 3.5](https://www.rfc-editor.org/rfc/rfc8628#section-3.5)).
- **Outliving npm's budget.** A device code can stay valid for longer than the 5 minutes npm gives an interactive `get` or a `login`. A provider that keeps polling until `expires_in` is killed by npm; a provider killed twice in one command is not started again, and the install fails with no message of the provider's own. Stop first and answer `other`.
- **Printing the prompt to stdout or stderr.** Stdout is protocol only, so the line corrupts the stream. Stderr is logged at `verbose` and masked, and a `user_code` could be masked or dropped. The prompt goes to the controlling terminal, and the provider never reads stdin.
- **Answering `not-found` when presence is needed.** An expired session with `interactive: false` is `other`. With `not-found`, a listed `npm:token` or the legacy fallback can serve a stored long-lived token for a company host in place of the login the company wanted.
- **Starting a device flow from a bare 401, or when `interactive` is `false`.** The 401 may come from a lockfile URL on the host. Check the session at the IdP first, and never open a flow without a terminal.
- **Deleting the refresh token on `erase`.** Erase drops what the provider handed npm. The refresh token is what `login` stored, and only `logout` removes it. Otherwise one revoked read token logs the developer out of the day.
- **A `granularity` that does not match the token.** The provider answers `granularity: "scope"` for a token valid for one scope, and npm reuses it for every package of that scope. A `registry` answer for a scope-only token is reused for other scopes, which then fail with a 403 on every request.
- **`expiresAt` in milliseconds.** JavaScript's `Date.now()` is in milliseconds, and the field is Unix seconds. A value a thousand times too large is a token npm never expires: the cached entry survives its 15 minutes and every request after that is a 401.
- **Treating an unknown `operation` as `read`.** `stage`, `stage-read`, `trust` and the rest are not in the gateway. The answer is `operation-not-supported`, never a read token.
- **Using `command` as the permission class.** `command` is informational. `publish --dry-run` sends `read`, and a `publish` can follow a `get` that npm sent for another command. The credential follows `operation`.
- **Sending to the `realm` in `authChallenges`.** The challenge describes the rejection. The provider's token endpoint comes from its own configuration and never from a URL in a header.
- **Listing the `http:` host, or leaving `registries` out.** An `http:` entry makes the provider serve a plaintext URL; no entry makes npm ask it about every registry of every install, `registry.npmjs.org` included, with the scope and package of the first request to each.
- **Keeping the CI identity somewhere a project can reach.** In `.npmrc`, in a project file or in an `npm_config_*` variable, the project controls it, and npm does not even pass the variables on.
- **Logging out of one host and leaving the other.** In this policy the IdP session is shared, and the provider owns its storage, so a `logout` for either host removes it for both. One that removed the entry only for the named host would leave a refresh token that still serves the other host.

## What this registry asks of the RFC

Nothing breaks the text. Three points are ambiguous or strained, and one concerns the repository's tests rather than the RFC:

1. **`operationIndependent` defaults to `true`** ([Success response](../phase-2-credential-provider.md#success-response-provider--client)). A token that reads only is not independent of the operation, and a provider that leaves the field out says it is. For `read` that is not harmless: npm binds only the answers for other operations to their operation, and a `read` answer kept as operation-independent at registry level is the entry a later `publish` lookup finds first ([Caching](../phase-2-credential-provider.md#5-caching); the repository's model returns it for a `publish` lookup). A provider that omits the field on a read-only token would see its token sent with a publish. The default describes almost no real provider.
2. **"A check of its own against the registry"** ([`erase`](../phase-2-credential-provider.md#erase-a-credential-was-rejected)). Before a provider starts a login after a 401, the RFC asks for a check against the registry. Here the login lives at the IdP, which answers a refresh with `invalid_grant`; the gateway is not asked at all. The rule's purpose, that a lockfile URL cannot start a login, is met by a check against whoever holds the login, and the text could say so.
3. **The model cannot replay `other`** (the repository's `tests/protocol_model.py`, not the RFC text). `validate_transcript` raises on any `other` answer, as it ends the session, so the central answer of this registry (`other` for presence needed but `interactive` false) cannot be a checked transcript. The examples show it inline. A transcript that ends at an `other`, as a session does, would let the model check the rest. **Settled:** the model now fails that request and goes on, so these exchanges are checked transcripts.

The points below look like gaps and are answered by the RFC as it stands:

- **One login serving several registry hosts.** Providers own their storage ([Security model](../phase-2-credential-provider.md#6-security-model)), and `logout` removes "its local credentials" for the registry it names. Whether that also ends a session shared with another host is the provider's design, and npm expects nothing of a later `get`.
- **"Holds a credential" and an expired session.** The rule answers `other` where the provider meant to withhold a credential, so that a stored token does not stand in for it. A session that only a person can renew is such a case, and `other` is the safe answer; `not-found` is for a provider with nothing stored.
- **A device flow inside an interactive `get` with nothing stored.** The Non-interactive and CI behavior section says an interactive request *may* use browser flows. Its sentence about `not-found` for a provider with nothing stored sits in the paragraph for `interactive` false. Whether a provider opens a flow on its own is its choice; this page chooses not to, as above.
- **Timeouts shorter than a device code.** The budgets are fixed so that a client can stay simple ([NuGet](../phase-2-credential-provider.md#nuget)). A provider that waits on a person keeps its own deadline inside the budget, as this page's 4 minutes 30 seconds does; that is provider guidance, above.
