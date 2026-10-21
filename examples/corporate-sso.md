# Corporate SSO gateway

A company runs a private npm registry behind an SSO gateway. Developers sign in to the company identity provider (IdP) with an OIDC device-code login, and the gateway accepts only short-lived tokens that a provider mints for each request scope. This page describes a hypothetical `corp-npm-credential-provider` for it.

The gateway, the IdP, their endpoints and every number below (token lifetimes, windows, role names) are invented for the example: they are one company's policy, not facts about a product. Only the device flow is taken from a standard, [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628).

The page shows:

- a global provider chain whose hello lists the company's registries;
- prompts on the controlling terminal;
- a publish credential gated on user presence;
- a refusal (`other`, not `not-found`) where presence would be needed but `interactive` is `false`;
- CI with a non-interactive service identity.

Every exchange below is a transcript in [corporate-sso/](corporate-sso/) that the repository's model accepts (`python -m unittest tests.test_examples`). The `other` answers are transcripts too: the model fails that request and goes on ([What this registry asks of the RFC](#what-this-registry-asks-of-the-rfc)).

## Registry and credentials

**URL shapes the provider must match.** The gateway has one host per region. Both serve the registry at the root:

- `https://npm.corp.example.com/`
- `https://npm-eu.corp.example.com/`

The gateway also proxies the public registry for unscoped packages, so the default `registry` points at the first host. Any other host, `registry.npmjs.org` included, is not the provider's business, and the `http:` form of a company host is not either ([Registry matching](../phase-2-credential-provider.md#registry-matching)). The hello keeps npm from asking, and a provider still answers `url-not-supported` itself, from `registry` alone, in `get`, `erase`, `login` and `logout` (no transcript shows it, because npm never sends such a request: the conformance harness does, to every provider and every kind).

**Credential kinds** (all hypothetical, except where a standard is cited):

| Credential | Who holds it | Lifetime | Source |
|---|---|---|---|
| IdP refresh token, from the device-code login | The provider, in the OS keychain | 10 hours of absolute session, ended early by revocation | Device flow: [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628), sections 3.1 to 3.5. Revocation: [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009) |
| Registry read token | npm, in memory | 15 minutes, minted per scope | Gateway policy. A request to the gateway's token endpoint carries the IdP access token and names the scope; this has the shape of a [token exchange](https://www.rfc-editor.org/rfc/rfc8693) but is not claimed to be one |
| Registry publish token | npm, in memory | 5 minutes, minted per package and version | Gateway policy; needs an IdP session whose last interactive sign-in is at most 5 minutes old (step-up) |
| CI service identity | A file in the runner image, readable only by the runner account | The IdP issues access tokens for it on request | Client credentials grant, [RFC 6749, section 4.4](https://www.rfc-editor.org/rfc/rfc6749#section-4.4) |

**Scopes.** A read token covers one npm scope, or the unscoped packages. A publish token covers one package at one version: the gateway mints it for the `version` in the request.

npm's cache key for `granularity` `package` holds the registry, the scope, the package and the operation, not the version. A second publish of the same package at another version in one npm process would therefore find the first token. No npm command does that (a publish names one version of each package, once), and were it to, the gateway's refusal would come back as a 401 and a retry that mints a token for that version.

**What the gateway answers.**

- A missing or expired token: 401 and `WWW-Authenticate: Bearer ..., error="invalid_token"`.
- A token whose claims do not entitle the caller to the package: 403 (`error="insufficient_scope"`).

The gateway never asks for an npm one-time password; the IdP step-up replaces it.

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

**The reference provider's settings.** [The reference provider](providers/corporate-sso/provider.js) reads a JSON file named by a `--config <file>` argument that the lines above leave out; it fails to start without one. The file holds the settings shown here as arguments: `idp` is the `--idp` origin, and `serviceIdentity` names the CI identity file ([CI](#ci)). The rest is for the run: where its store is, which address answers for each host, the clock, the person's scripted answers ([providers/README.md](providers/README.md)).

The chain ends with the implicit `npm:token`, which a company host never reaches. The `https:` hosts are served by the provider. The `http:` form of a company host is not: the hello lists the host, so the request fails, naming the provider and the forms it lists, whether or not a token is stored ([Legacy fallback](../phase-2-credential-provider.md#legacy-fallback)). The implicit entry serves only a registry the hello does not list, and since this is the only provider and lists its hosts, npm uses a stored token for such a registry without a warning.

## Hello

```json
{"v":[1],"capabilities":["login","logout","erase","retry-context"],"registries":["https://npm.corp.example.com/","https://npm-eu.corp.example.com/"]}
```

- `v`: protocol version 1.
- `capabilities`: `login` and `logout` because the provider runs the device flow and revokes the session; `erase` so npm tells it when the gateway rejected a token (it drops its cached access token, not the refresh token); `retry-context` because it reads `httpStatus` on a retry to tell a 401 from a 403. They are advisory.
- `registries`: both company hosts, with the `https:` scheme and the trailing slash. npm does the matching, so the provider is asked for these two and no others, and an `http:` URL on the same host gets no credential from it.

## Install

[install.jsonl](corporate-sso/install.jsonl). `npm install` in a developer's terminal (`interactive` is `true`) with the IdP session alive. The provider refreshes the IdP access token silently, then asks the gateway for a read token for the request's scope. Nothing is shown to the user. When the gateway refuses the cached IdP access token with 401, as after a revocation at the IdP, the provider renews it once with the refresh token and asks again, without a login; npm sees only the `Ok` ([install-revoked-access.jsonl](corporate-sso/install-revoked-access.jsonl)).

```json
{"v":1,"kind":"get","registry":"https://npm.corp.example.com/","scope":"@corp","package":"ui-kit","operation":"read","command":"install","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-read-token-corp"},"cache":"expires","expiresAt":1792197000,"operationIndependent":false,"granularity":"scope"}}
```

- Every other `@corp/*` package is a cache hit. `@corp-data/models`, the unscoped `left-pad` and `@corp-eu/maps` on the other host each get a `get` of their own, because the gateway mints per scope and the cache key holds the registry and the scope. An answer with `granularity: "scope"` for a request without a scope serves the unscoped packages ([Caching](../phase-2-credential-provider.md#5-caching)).
- `cache` is `expires` with a Unix time in seconds, 15 minutes ahead. npm stops using the entry 60 seconds early. The last pair in the file is a `get` for another `@corp` package well after that time: the install outlived the token, and the provider mints a new one.
- `operationIndependent` is `false`, the default, written out: the token reads and nothing else. npm binds an answer for an operation other than `read` to its operation anyway, but not a `read` answer, so `true` here would let a later `publish` lookup find the read token ([What this registry asks of the RFC](#what-this-registry-asks-of-the-rfc)).
- If the IdP session is gone, an interactive `get` starts a device flow on the terminal, exactly as `login` does ([Login and logout](#login-and-logout)). The 5-minute budget of an interactive `get` applies.
- If the session is gone and `interactive` is `false`, the provider held a session once and cannot renew it without the user ([session-expired.jsonl](corporate-sso/session-expired.jsonl)). It answers `other`, not `not-found`, so a stored token behind it in the chain does not stand in for the company's login ([Non-interactive and CI behavior](../phase-2-credential-provider.md#non-interactive-and-ci-behavior)):

```json
{"Err":{"kind":"other","message":"The corporate SSO session has expired. Run 'npm login --registry https://npm.corp.example.com/' in a terminal."}}
```

A machine where nobody ever logged in and no service identity exists has nothing stored, and the provider answers `not-found` there, in a terminal as well. It starts a device flow for `login`, and for an interactive `get` only where it held a session, so a global provider does not open a login page on every install of a machine that never signed in. No provider answers `Ok` then, so the install fails, naming the provider, unless the chain lists `npm:token` after it ([Legacy fallback](../phase-2-credential-provider.md#legacy-fallback)).

## Publish

[publish.jsonl](corporate-sso/publish.jsonl). The gateway supports `npm publish` and the writes that follow the same policy (`dist-tag`, `deprecate`, `unpublish`); it has no staging, no tokens, no teams and no trust endpoints, so a provider answers `stage` and the operations of those surfaces `operation-not-supported` ([unsupported-trust.jsonl](corporate-sso/unsupported-trust.jsonl) shows an `npm trust` refused with the bare `Err` and no credential, the provider logged in and the request interactive; `stage`, `access`, `owner` and `account` get the same answer). A workspace publish of two packages from a terminal:

```json
{"v":1,"kind":"get","registry":"https://npm.corp.example.com/","scope":"@corp","package":"ui-kit","version":"2.4.1","operation":"publish","command":"publish","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-publish-token-ui-kit"},"cache":"expires","expiresAt":1792196400,"operationIndependent":false,"granularity":"package"}}
```

The provider's policy for `publish`:

1. The IdP session must have been interactively confirmed in the last 5 minutes. If it has not, the provider starts a device flow on the controlling terminal and waits.
2. It then asks on the controlling terminal: `Publish @corp/ui-kit@2.4.1 to npm.corp.example.com? [y/N]`. The prompt names the package and the version, which only a `publish` request carries. Three cases end in `other`:
   - A prompt left unanswered for 4 minutes 30 seconds, the provider's own deadline inside npm's 5-minute interactive budget ([publish-unanswered.jsonl](corporate-sso/publish-unanswered.jsonl)).
   - A sign-in that spent the budget. The device flow of step 1 and this prompt are one request and share that deadline, so a sign-in approved on the last poll leaves no time to ask, and the answer is the same `other`, with no prompt ([publish-signin-spent-budget.jsonl](corporate-sso/publish-signin-spent-budget.jsonl)).
   - A step-up with no controlling terminal to show it on. The provider does not poll to the deadline: it answers `other` naming `npm login` at once, keeps the session as it was and mints nothing ([publish-step-up-no-terminal.jsonl](corporate-sso/publish-step-up-no-terminal.jsonl)).
3. It mints a token for that package and version, valid for 5 minutes, and answers with `granularity: "package"`.

The second request, for `@corp/ui-icons@3.0.0`, finds a fresh confirmation, so it shows only the `[y/N]` prompt. npm caches publish answers per operation and package, so each package in a workspace publish asks again; the provider asks the user once per package and the device flow once per five minutes. With `interactive: false` and no service identity, a publish gets ([publish-no-terminal.jsonl](corporate-sso/publish-no-terminal.jsonl)):

```json
{"Err":{"kind":"other","message":"Publishing @corp/ui-kit@2.4.1 needs a device-code confirmation, and no terminal is available. Run npm publish from a terminal, or from the release runner."}}
```

**The other writes.** `dist-tag`, `deprecate` and `unpublish` follow the same policy, one command and so one transcript each: [dist-tag.jsonl](corporate-sso/dist-tag.jsonl) (npm sends no version), [deprecate.jsonl](corporate-sso/deprecate.jsonl) and [unpublish.jsonl](corporate-sso/unpublish.jsonl) (both name one). The IdP step-up is current in these, so there is no device flow; the provider asks `[y/N]` naming the package and the version where there is one, then answers with a 5-minute token bound to the package: `granularity: "package"`, `operationIndependent: false`. Each operation gets its own token, so the `dist-tag` token is not what a later `unpublish` finds. In CI the same operations need the `npm-publisher` role, and without a terminal or a service identity they are `other`, as for `publish`.

`npm publish --dry-run` sends `read`, so it asks for none of this ([Operations](../phase-2-credential-provider.md#4-operations)).

## Rejection

[rejection.jsonl](corporate-sso/rejection.jsonl) has two rejections.

**A 401, `invalid_token`.** The gateway revoked the token (an administrator disabled the user, or the key rotated). npm drops the cached entry and sends `erase` with the context of the `get` and its granularity, then one retry:

```json
{"v":1,"kind":"erase","registry":"https://npm.corp.example.com/","scope":"@corp","package":"ui-kit","operation":"read","granularity":"scope","authChallenges":["Bearer realm=\"https://npm.corp.example.com/\", error=\"invalid_token\""]}
{"Ok":{"kind":"erase"}}
{"v":1,"kind":"get","registry":"https://npm.corp.example.com/","scope":"@corp","package":"ui-kit","operation":"read","command":"install","interactive":true,"retry":true,"httpStatus":401,"authChallenges":["Bearer realm=\"https://npm.corp.example.com/\", error=\"invalid_token\""]}
```

npm has already dropped the gateway token from its cache, and the provider keeps none; erase drops the IdP access token the provider cached for that session. It does not touch the refresh token in the keychain, which `login` stored. The retry mints a new token from the same session. If the IdP answers the refresh with `invalid_grant`, the provider's own check has confirmed that its login is dead; only then, and only if `interactive` is `true`, does it start a device flow. With `interactive` false it answers `other`. A 401 alone never starts a login.

The gateway's 401 on an access token that looked alive is a rejection of its own, and it can come after the person has already confirmed a publish. The provider renews the access token once with the refresh token and asks again. If the IdP answers that renewal with `invalid_grant`, the answer is `other` with the expired-session message and no device flow is started, even where `interactive` is `true`: a sign-in shown after a prompt the person has just answered would be a second wait that the request's one 4 minutes 30 seconds does not cover, and it began from a 401 ([publish-gateway-revoked-session.jsonl](corporate-sso/publish-gateway-revoked-session.jsonl)).

**A session that is gone ([rejection-session-gone.jsonl](corporate-sso/rejection-session-gone.jsonl)).** The same 401 and erase, but the IdP ended the session between the two requests (the user was disabled), and `interactive` is `false`. The retry has nothing to replace the token with: the erase dropped the cached access token, and the refresh gets `invalid_grant`. The provider answers `other` with the expired-session message, not the token just refused and not `not-found`.

The refresh token stays in the keychain, since only `logout` removes it, and the next `npm login` replaces it.

With `interactive` `true` the same check would start a device flow instead, if the code can be shown on a terminal. With no terminal the answer is `other` before any poll, and the stored session is untouched ([install-session-expired-no-terminal.jsonl](corporate-sso/install-session-expired-no-terminal.jsonl)).

**A 403, `insufficient_scope`.** The token for `@corp-secure` was minted before the user joined the group that entitles them to it. npm sends no erase, only the retry with `httpStatus: 403`:

```json
{"v":1,"kind":"get","registry":"https://npm.corp.example.com/","scope":"@corp-secure","package":"vault-client","operation":"read","command":"install","interactive":true,"retry":true,"httpStatus":403,"authChallenges":["Bearer realm=\"https://npm.corp.example.com/\", error=\"insufficient_scope\""]}
```

The provider fetches the user's current groups from the IdP and mints another read token. It would release that token for a plain `read` anyway; it does not widen to a publish token because the gateway said 403, which a hostile lockfile URL on the host could provoke. If the groups have not changed, it answers `other` naming the package, and the 403 stands ([rejection-403-unchanged.jsonl](corporate-sso/rejection-403-unchanged.jsonl)). The retry goes out once; a second 403 is reported.

## Login and logout

[login.jsonl](corporate-sso/login.jsonl). `npm login --registry https://npm.corp.example.com/` sends `login` to the provider that serves the registry:

```json
{"v":1,"kind":"login","registry":"https://npm.corp.example.com/","interactive":true}
```

The provider starts the device flow ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628), sections 3.1 to 3.5) and writes the prompt to the controlling terminal (`/dev/tty`, or `CONOUT$` on Windows), never to stdout or stderr:

```
Open https://idp.corp.example.com/device and enter the code WDJB-MJHT
Waiting for approval (4:30 left) ...
```

The URI and the code come from the IdP and are shown with any control character or bidirectional override replaced by `?`.

It polls at the interval the IdP gave, slows down on `slow_down`, and stops at `access_denied`, `expired_token` or its own deadline of 4 minutes 30 seconds, which is inside npm's 5-minute `login` budget.

On approval it keeps the refresh token in the OS keychain, writes nothing into any `.npmrc`, and answers `{"Ok":{"kind":"login"}}`.

Each of these is `other`, with the reason:

- A cancelled or expired flow.
- A flow nobody approved before the deadline ([login-unapproved.jsonl](corporate-sso/login-unapproved.jsonl)).
- A flow the IdP approves with less than a session: no refresh token, no access token, or an expiry that is not a positive number, which stores nothing ([login-incomplete-session.jsonl](corporate-sso/login-incomplete-session.jsonl)).
- A request with a `token`, which `npm login` sends when the person pastes one. The gateway takes tokens it mints from an IdP session, and a pasted token is not one, so the provider says so instead of starting a device flow that ignores it ([login-token-refused.jsonl](corporate-sso/login-token-refused.jsonl)).
- A request that says `interactive` but has no controlling terminal to write the prompt to (a run under a service, a detached shell). That is not a person who can approve anything: the provider finds out when it tries to show the code, answers `other` naming `npm login` and a terminal before the first poll, stores nothing, and leaves the unused device code to lapse at the IdP ([login-no-terminal.jsonl](corporate-sso/login-no-terminal.jsonl)).

[logout.jsonl](corporate-sso/logout.jsonl):

```json
{"v":1,"kind":"logout","registry":"https://npm.corp.example.com/"}
{"Ok":{"kind":"logout"}}
```

`logout` deletes the keychain entry first, so that an IdP that does not answer cannot keep it, then revokes the refresh token at the IdP ([RFC 7009](https://www.rfc-editor.org/rfc/rfc7009)) as a best effort within the time npm gives a `logout`, and answers `Ok` even if the IdP could not be reached, warning on stderr. With no session stored there is nothing to remove, and it answers `not-found`, so a later entry of the chain may remove its own ([logout-nothing-stored.jsonl](corporate-sso/logout-nothing-stored.jsonl)). One IdP session serves both company hosts, so the provider's logout for either host removes the session for both.

## CI

[ci.jsonl](corporate-sso/ci.jsonl). The runner image holds a service identity file readable only by the runner account, and the provider is in the image's global npmrc. `interactive` is `false`. An `npm ci` and an `npm publish` are two commands, so two sessions: the publish is [ci-publish.jsonl](corporate-sso/ci-publish.jsonl).

- Reads: the provider does a client credentials grant ([RFC 6749, section 4.4](https://www.rfc-editor.org/rfc/rfc6749#section-4.4)) for the service identity, then asks the gateway for a read token. Same answer shape as the install.
- Writes: only a service identity with the `npm-publisher` role, which the release runner image has and the test runners do not, gets a publish token. It has no presence and needs none; the role and the runner image are the gate, and the token is bound to the package and version for 5 minutes.

```json
{"v":1,"kind":"get","registry":"https://npm.corp.example.com/","scope":"@corp","package":"ui-kit","version":"2.4.1","operation":"publish","command":"publish","interactive":false}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-ci-publish-token"},"cache":"expires","expiresAt":1792196400,"operationIndependent":false,"granularity":"package"}}
```

On a runner whose identity lacks the role, the same request gets `other` naming the missing role, not `not-found`: the provider holds an identity and its policy withholds the credential ([ci-no-publisher-role.jsonl](corporate-sso/ci-no-publisher-role.jsonl)). The provider never takes the identity from the environment or from a project file, since npm strips `npm_config_*` and the project controls the rest; the file's path comes from its configuration, and its permissions are the image's. The environment says one thing only, that this is a CI run (`CI` is set), so a developer machine whose configuration names the file does not use it.

## Where it is easy to go wrong

- **Polling the token endpoint faster than the IdP allows.** The default interval is 5 seconds, and `slow_down` adds 5 more, for the rest of the flow. A loop that ignores `slow_down` gets the client blocked ([RFC 8628, section 3.5](https://www.rfc-editor.org/rfc/rfc8628#section-3.5)).
- **Outliving npm's budget.** A device code can stay valid for longer than the 5 minutes npm gives an interactive `get` or a `login`. A provider that keeps polling until `expires_in` is killed by npm; a provider killed twice in one command is not started again, and the install fails with no message of the provider's own. Stop first and answer `other`.
- **Printing the prompt to stdout or stderr.** Stdout is protocol only, so the line corrupts the stream. Stderr is logged at `verbose` and masked, and a `user_code` could be masked or dropped. The prompt goes to the controlling terminal, and the provider never reads stdin.
- **Answering `not-found` when presence is needed.** An expired session with `interactive: false` is `other`. With `not-found`, a listed `npm:token` can serve a stored long-lived token for a company host in place of the login the company wanted.
- **Starting a device flow from a bare 401, or when `interactive` is `false`.** The 401 may come from a lockfile URL on the host. Check the session at the IdP first, and never open a flow when `interactive` is `false`, which is npm's statement that no prompt can be shown, and never poll one that could not be shown on a controlling terminal: nobody can finish it.
- **Deleting the refresh token on `erase`.** Erase drops what the provider handed npm. The refresh token is what `login` stored, and only `logout` removes it. Otherwise one revoked read token logs the developer out of the day.
- **A `granularity` that does not match the token.** The provider answers `granularity: "scope"` for a token valid for one scope, and npm reuses it for every package of that scope. A `registry` answer for a scope-only token is reused for other scopes, which then fail with a 403 on every request.
- **`expiresAt` in milliseconds.** JavaScript's `Date.now()` is in milliseconds, and the field is Unix seconds. A value a thousand times too large is a token npm never expires: the cached entry survives its 15 minutes and every request after that is a 401. The provider checks the gateway's value too and answers `other` for one that is not in seconds ([install-expiry-milliseconds.jsonl](corporate-sso/install-expiry-milliseconds.jsonl)).
- **Treating an unknown `operation` as `read`.** `stage`, `stage-read`, `trust` and the rest are not in the gateway. The answer is `operation-not-supported`, never a read token.
- **Using `command` as the permission class.** `command` is informational. `publish --dry-run` sends `read`, and a `publish` can follow a `get` that npm sent for another command. The credential follows `operation`.
- **Sending to the `realm` in `authChallenges`.** The challenge describes the rejection. The provider's token endpoint comes from its own configuration and never from a URL in a header.
- **Listing the `http:` host, or leaving `registries` out.** An `http:` entry makes the provider serve a plaintext URL; no entry makes npm ask it about every registry of every install, `registry.npmjs.org` included, with the scope and package of the first request to each.
- **Keeping the CI identity somewhere a project can reach.** In `.npmrc`, in a project file or in an `npm_config_*` variable, the project controls it, and npm does not even pass the variables on.
- **Logging out of one host and leaving the other.** In this policy the IdP session is shared, and the provider owns its storage, so a `logout` for either host removes it for both. One that removed the entry only for the named host would leave a refresh token that still serves the other host.

## What this registry asks of the RFC

Nothing breaks the text. Three points are ambiguous or strained, and one concerns the repository's tests rather than the RFC:

1. **`operationIndependent` defaulted to `true`** ([Success response](../phase-2-credential-provider.md#success-response-provider--client)). A token that reads only is not independent of the operation, and a provider that left the field out said it is.
   - For `read` that is not harmless: npm binds only the answers for other operations to their operation, and a `read` answer kept as operation-independent at registry level is the entry a later `publish` lookup finds first ([Caching](../phase-2-credential-provider.md#5-caching); the repository's model returned it for a `publish` lookup).
   - A provider that omitted the field on a read-only token would have seen its token sent with a publish.
   - The default described almost no real provider.

   **In the RFC:** the field defaults to `false`, so a `read` answer that leaves it out never serves a later write's lookup; a provider whose one token serves every operation says `true`.
2. **"A check of its own against the registry"** ([`erase`](../phase-2-credential-provider.md#erase-a-credential-was-rejected)). Before a provider starts a login after a 401, the RFC asks for a check against the registry. Here the login lives at the IdP, which answers a refresh with `invalid_grant`; the gateway is not asked at all. The rule's purpose, that a lockfile URL cannot start a login, is met by a check against whoever holds the login, and the text could say so. **In the RFC:** the text says a check against the registry or the service that holds the login.

The points below look like gaps and are answered by the RFC as it stands:

- **One login serving several registry hosts.** Providers own their storage ([Security model](../phase-2-credential-provider.md#6-security-model)), and `logout` removes "its local credentials" for the registry it names. Whether that also ends a session shared with another host is the provider's design, and npm expects nothing of a later `get`.
- **"Holds a credential" and an expired session.** The rule answers `other` where the provider meant to withhold a credential, so that a stored token does not stand in for it. A session that only a person can renew is such a case, and `other` is the safe answer; `not-found` is for a provider with nothing stored.
- **A device flow inside an interactive `get` with nothing stored.** The Non-interactive and CI behavior section says an interactive request *may* use browser flows. Its sentence about `not-found` for a provider with nothing stored sits in the paragraph for `interactive` false. Whether a provider opens a flow on its own is its choice; this page chooses not to, as above.
- **Timeouts shorter than a device code.** The budgets are fixed so that a client can stay simple ([NuGet](../phase-2-credential-provider.md#nuget)). A provider that waits on a person keeps its own deadline inside the budget, as this page's 4 minutes 30 seconds does; that is provider guidance, above.
