# GitHub Packages

A hypothetical `npm-credential-provider-github` for the GitHub Packages npm registry. GitHub Packages issues no short-lived tokens of its own and no token narrower than an owner: what a provider hands out is a personal access token, a `gh` token or, in Actions, the job's `GITHUB_TOKEN`. The provider here keeps two accounts (a work and a personal one) in the OS keychain, maps each package owner to one of them, and keeps a read token and a write token apart. It shows how the protocol serves a registry where the only gains are not leaving a token in `~/.npmrc`, telling tokens apart by owner and operation, and gating the write token on user presence; `erase` cannot replace a token here, it can only report that one was refused.

The provider and its behaviour are hypothetical and follow the [Phase 2 protocol](../phase-2-credential-provider.md). The facts about GitHub are from the sources linked below; where a fact is recalled or unverified, the text says so. The GitHub examples use the real host `npm.pkg.github.com` and made-up tokens.

## Registry and credentials

**URL shapes the provider must match.**

| Registry | Registry URL | Source |
|---|---|---|
| github.com | `https://npm.pkg.github.com/`. One host for every owner; the owner is the package scope (`@OWNER/name`, lowercase), not part of the URL. | [npm registry docs](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry) |
| GitHub Enterprise Server, subdomain isolation on | `https://npm.HOSTNAME/` | [GHES 3.14 docs](https://docs.github.com/en/enterprise-server@3.14/packages/working-with-a-github-packages-registry/working-with-the-npm-registry) |
| GitHub Enterprise Server, subdomain isolation off | `https://HOSTNAME/_registry/npm/`. The same host as the GHES web UI and API. | [GHES 3.14 docs](https://docs.github.com/en/enterprise-server@3.14/packages/working-with-a-github-packages-registry/working-with-the-npm-registry) |
| GHE.com (data residency) | `https://npm.SUBDOMAIN.ghe.com/`. By analogy with the documented `containers.SUBDOMAIN.ghe.com`; the npm form itself is not documented. | [data residency overview](https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/feature-overview-for-github-enterprise-cloud-with-data-residency) |

An older per-owner form, `https://npm.pkg.github.com/OWNER/`, is not in the current docs. An anonymous request to it was refused with a 403, so whether it works is unknown. If a user configures it, a hello entry for `https://npm.pkg.github.com/` still covers it by path prefix, but npm then sends `registry` as that longer URL and caches under it.

**Credentials.**

| Credential | Lifetime | What it can do | Source |
|---|---|---|---|
| Personal access token (classic), `ghp_…`, made in the web UI | Chosen at creation: a preset, a date or none; an organization or enterprise policy can cap it. | `read:packages` installs, `write:packages` publishes, `delete:packages` deletes (and needs `read:packages`). User-wide, not tied to an owner. An organization's resources need the token authorized for SAML SSO, and an organization can block classic tokens, which gives a 403. | [package permissions](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages), [personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens), [OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps) |
| Fine-grained personal access token, `github_pat_…` | 1 to 366 days or none | Not supported for Packages. The token docs list it as a limitation; [roadmap issue 558](https://github.com/github/roadmap/issues/558) is open without a date. | [personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) |
| `GITHUB_TOKEN` in Actions | Ends with the job: at most 6 hours on GitHub-hosted runners, up to 24 hours on self-hosted ones. | Limited to the workflow's repository, by the job's `permissions: packages: read` or `write` (the `permissions` key is recalled: none of the saved copies of these pages names it). It publishes packages associated with that repository and installs a private package only if the package grants the repository access. Other owners' packages need a classic token. It reaches an npm process only if the workflow exports it. | [GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token), [package permissions](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages) |
| `gh` OAuth token, `gho_…`, from `gh auth token` | Until revoked | Always carries `repo`, `read:org` and `gist`, which cannot be removed; `repo` is full read and write on every repository the user can reach. Package scopes are added with `gh auth refresh -s read:packages`. The docs say Packages takes only classic tokens; that `gho_` tokens work against `npm.pkg.github.com` is widely relied on (Phase 1 relies on it) but not documented. | [gh auth login](https://cli.github.com/manual/gh_auth_login), [gh auth refresh](https://cli.github.com/manual/gh_auth_refresh), [gh auth token](https://cli.github.com/manual/gh_auth_token) |
| The provider's own OAuth App token, `gho_…`, from the device flow | Long-lived by default; an app can opt in to 8-hour tokens with a refresh token valid 6 months unused. | Whatever scopes were requested, for example `read:packages` alone. **Unverified:** whether `npm.pkg.github.com` accepts the expiring form. | [authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) |

The provider in this example uses classic tokens, which GitHub documents for Packages: per account, one with `read:packages` only and one with `write:packages`.

Two behaviours matter to a provider. First, Packages needs a token even for public packages. Second, with `registry=https://npm.pkg.github.com/` as the default registry, GitHub documents that scoped and unscoped packages from npmjs.org can then be used ([npm registry docs](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)), so the provider is asked about the whole dependency tree; that the one token serves them is the probe's finding that `/lodash` without a token gives a 404, not a documented statement.

## Configuration

```ini
# ~/.npmrc, the user's own file
//npm.pkg.github.com/:credentialProvider[]=npm-credential-provider-github
```

```ini
# the project's .npmrc: registries may be set here, a provider may not
@acme:registry=https://npm.pkg.github.com/
@octocat:registry=https://npm.pkg.github.com/
```

The per-registry form is the one to use. The provider does not start for any other registry, and it does not need a `--instance` argument for github.com. The owner-to-account map lives in the provider's own settings, not in npm config. The reference provider reads these settings: `owners` (`@owner` to account name, the owner compared in lower case as GitHub names are, so `@Acme` serves `@acme`), `defaultAccount` (the account for every other scope and for unscoped packages), `loginAccount` (the account a login stores into, `defaultAccount` if unset), `clientId` (the OAuth app of the device flow), `unpublish` (`"delete-token"` turns on the alternative shown under [Publish](#publish); unset, `unpublish` is `operation-not-supported`), `host` (as `--host`) and `subdomainIsolation` (GHES, see [Hello](#hello)). The OAuth calls go through the host's request helper like every other call, with `Accept: application/json` because GitHub's OAuth endpoints answer in a form otherwise; the provider reads no setting for where they go, so a conformance run can redirect them without it.

A global chain also works, because the hello lists the registry:

```ini
credentialProvider[]=npm-credential-provider-github
credentialProvider[]=npm:token
```

The provider then starts for every command that goes to the network, to send its hello, but npm sends it nothing about any registry outside the hello list ([Version negotiation](../phase-2-credential-provider.md#version-negotiation)). Listing `npm:token` last keeps the stored credential for registries the provider does not serve, without the warning the implicit entry draws. The cost against the per-registry form is that a request to `npm.pkg.github.com` this provider cannot answer falls to `npm:token`, which may hold a standing token: see [Where it is easy to go wrong](#where-it-is-easy-to-go-wrong).

On GHES the line names the instance's own registry URL, and the provider takes the host from an argument, `--host HOSTNAME`, because it has to map the npm host to the host of the GitHub API:

```ini
//npm.ghes.example.com/:credentialProvider[]=npm-credential-provider-github --host ghes.example.com
# subdomain isolation off:
//ghes.example.com/_registry/npm/:credentialProvider[]=npm-credential-provider-github --host ghes.example.com
```

GitHub's GHES page prints the token key with a double slash, `//npm.HOSTNAME//:_authToken` ([GHES 3.14 docs](https://docs.github.com/en/enterprise-server@3.14/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)). Do not copy that form into a `credentialProvider` key; see [What this registry asks of the RFC](#what-this-registry-asks-of-the-rfc).

## Hello

```json
{"v":[1],"registries":["https://npm.pkg.github.com/"],"capabilities":["login","logout","erase","retry-context"]}
```

- `v`: protocol version 1.
- `registries`: the one github.com host. npm matches requests against it itself and sends the provider nothing about other registries. On GHES the entry is the instance's registry URL, built from `--host` and the provider's own `subdomainIsolation` setting (on unless set to `false`): `https://npm.HOSTNAME/` or `https://HOSTNAME/_registry/npm/`, never the bare `https://HOSTNAME/`, which is the web UI and API host. List both forms only if the instance really serves both.
- `login`, `logout`: the provider stores a pasted token or runs its own device flow, and removes both on logout.
- `erase`: the provider wants to hear about rejections. It cannot replace a stored token, and the stored token is the credential it hands out, so it keeps it and answers `Ok`; the retry that follows checks the token and answers `other` either way, since the provider has no other credential it would release for that request ([Rejection](#rejection)).
- `retry-context`: the provider reads `retry` and `httpStatus`.
- No `auth-challenges`: GitHub sends no `WWW-Authenticate` header on a 401 (probed anonymously on 2026-10-17: an existing package without a token gave a 401 with a JSON body and no such header), so there is nothing to read.

On GHES the provider's other calls follow the host too: the device flow at `https://HOSTNAME/login/...`, the REST calls (`GET /user`, `POST /credentials/revoke`) under `https://HOSTNAME/api/v3`. [install-ghes.jsonl](github-packages/install-ghes.jsonl) (subdomain isolation on, `npm.ghes.example.com`) and [install-ghes-no-isolation.jsonl](github-packages/install-ghes-no-isolation.jsonl) (off, `ghes.example.com/_registry/npm/`) each run one session on an instance: the hello names that form only, an install is served, a 401 retry checks the token at `/api/v3/user`, a pasted-token login is checked there too, and logout revokes at `/api/v3/credentials/revoke`. The conformance fake serves the REST API only under that prefix for these runs, so a call to the github.com path fails them.

## Install

[install.jsonl](github-packages/install.jsonl)

The developer runs `npm install` in a terminal, in a project whose `.npmrc` maps `@acme` and `@octocat` to GitHub Packages. The provider maps `@acme` to the work account and `@octocat` to the personal one; an unscoped package, which GitHub proxies from npmjs.org, goes to the work account as the default.

```json
{"v":1,"kind":"get","registry":"https://npm.pkg.github.com/","scope":"@acme","package":"widgets","operation":"read","command":"install","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-work-read-token"},"cache":"session","operationIndependent":false,"granularity":"scope"}}
```

- `granularity: "scope"`, because the answer depends on the owner, not because the token is narrower: a classic token is user-wide. The provider answers `scope` to every request on this registry, unscoped ones included. The unscoped request below carries no `scope`, and its answer is cached under "scope absent".
- `operationIndependent: false` (the default, written out), because the provider holds a stronger token for `publish`. With `true`, a cached read token would be found by the later `publish` lookup (see [Where it is easy to go wrong](#where-it-is-easy-to-go-wrong)).
- `cache: "session"`: a classic token carries no expiry the provider knows of. A `GITHUB_TOKEN` also gets `session`: a command is shorter than the job.

The second request, for `@octocat/hello-world`, gets the personal account's token under its own `scope` cache key. The third, for an unscoped package, carries no `scope` and is answered with the work account's token.

```json
{"v":1,"kind":"get","registry":"https://npm.pkg.github.com/","package":"lodash","operation":"read","command":"install","interactive":true}
```

Every other `@acme/*` package is a cache hit.

## Publish

[publish.jsonl](github-packages/publish.jsonl)

GitHub Packages supports `npm publish`, with `write:packages` or, in Actions, a `GITHUB_TOKEN` with `packages: write` for a package associated with the workflow's repository ([package permissions](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages)). The `repository` field of `package.json` links the package to a repository and so decides what access it inherits.

Every request `npm publish` makes carries `operation: "publish"`, the packument fetch before the upload included ([Operations](../phase-2-credential-provider.md#4-operations)), so one `get` serves the command:

```json
{"v":1,"kind":"get","registry":"https://npm.pkg.github.com/","scope":"@acme","package":"widgets","version":"2.4.1","operation":"publish","command":"publish","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-work-write-token"},"cache":"session","operationIndependent":false,"granularity":"package"}}
```

Before it answers, the provider asks for user presence on the controlling terminal, naming `@acme/widgets` and `2.4.1` (the name and version come from the request, so the provider prints them with control characters replaced: an escape sequence in a name must not redraw the prompt). The prompt has a deadline, 4 minutes 30 seconds, shared with the `write:packages` device flow that may follow it, so that the whole `get` ends inside npm's 5 minutes for an interactive request. A person who declines, or who does not answer in time, gets `other` and nothing is released ([publish-declined.jsonl](github-packages/publish-declined.jsonl), [publish-unanswered.jsonl](github-packages/publish-unanswered.jsonl)); the second:

```json
{"v":1,"kind":"get","registry":"https://npm.pkg.github.com/","scope":"@acme","package":"widgets","version":"2.4.1","operation":"publish","command":"publish","interactive":true}
{"Err":{"kind":"other","message":"The publish of @acme/widgets 2.4.1 was not confirmed within 4 minutes 30 seconds. No credential was released."}}
```

When no write token is stored yet, the confirmed prompt is followed by the device flow for `write:packages`, and the token it yields is stored and answered ([publish-device-flow.jsonl](github-packages/publish-device-flow.jsonl)). It binds the write token to that package and operation with `granularity: "package"` and `operationIndependent: false`. GitHub itself cannot bind a token to a package or version, so this binding is the provider's policy; the registry gives no narrowing ([roadmap issue 558](https://github.com/github/roadmap/issues/558)).

**Other write operations.** The research found these gaps; the provider answers `operation-not-supported` for the ones the registry has no endpoint for:

| Operation | What GitHub does | Provider |
|---|---|---|
| `deprecate` | `npm deprecate` fails with a 400, `version.ID cannot be empty`, and GitHub said in February 2024 that it was not on the roadmap ([discussion 63811](https://github.com/orgs/community/discussions/63811)). | `operation-not-supported` |
| `unpublish` | Documented deletion is the web UI or the REST `DELETE` on the package or version, which needs `read:packages` and `delete:packages`, admin on the package, and refuses a public package or version with more than 5,000 downloads ([deleting and restoring](https://docs.github.com/en/packages/learn-github-packages/deleting-and-restoring-a-package), [REST](https://docs.github.com/en/rest/packages/packages)). **Unverified:** whether `npm unpublish` itself works on `npm.pkg.github.com`: the npm registry page (read again on 2026-10-20) does not mention it. | The provider here answers `operation-not-supported`. The alternative, shown below, is a `delete:packages` token behind a presence prompt. |
| `dist-tag` | **Unverified:** the docs say nothing either way (the npm registry page and the REST packages page, read on 2026-10-20, do not mention dist-tags). A community thread from February 2020 ([github.community](https://github.community/t/packages-do-npm-tags-work/17657), now discussion 27112) has GitHub Support suggesting `npm dist-tag add` and a user reporting that tags were not respected, then another that they worked; not verified. | The reference provider maps it to the write token, behind the same presence prompt as `publish` (so a request that may fail costs a prompt and a token released for nothing, as under item 9 below); it is not shown, because nothing documented supports a transcript. |
| `stage`, `stage-read`, `stage-reject` | No `/-/stage` endpoints (recalled, not documented). Read again on 2026-10-20: the npm registry page does not mention staging, and the staged-publishing announcements and docs found describe the npm registry and npmjs.com only ([npm docs](https://docs.npmjs.com/staged-publishing): `npm stage publish`, approval on npmjs.com). An absence, not a documented refusal; **not verified**. | `operation-not-supported` |
| `owner`, `access`, `trust`, `account` | Not implemented; the RFC says so for `access` and `trust`, the rest is recalled. | `operation-not-supported` |

[deprecate-unsupported.jsonl](github-packages/deprecate-unsupported.jsonl). The answer to `deprecate`:

```json
{"v":1,"kind":"get","registry":"https://npm.pkg.github.com/","scope":"@acme","package":"widgets","version":"2.4.0","operation":"deprecate","command":"deprecate","interactive":true}
{"Err":{"kind":"operation-not-supported"}}
```

[unpublish.jsonl](github-packages/unpublish.jsonl). The alternative for `unpublish`, for a user who wants the command to go through, is a provider that answers with a `delete:packages` token after a presence prompt naming the package and version:

```json
{"v":1,"kind":"get","registry":"https://npm.pkg.github.com/","scope":"@acme","package":"widgets","version":"2.4.0","operation":"unpublish","command":"unpublish","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-work-delete-token"},"cache":"never","operationIndependent":false,"granularity":"package"}}
```

What GitHub documents is the deletion, not the npm command: the REST `DELETE` on a package or a package version needs a token with `read:packages` and `delete:packages`, and a public package or version with more than 5,000 downloads cannot be deleted this way ([REST: packages](https://docs.github.com/en/rest/packages/packages)); the web UI and the Actions `GITHUB_TOKEN` with `admin` on the package are other documented ways ([deleting and restoring](https://docs.github.com/en/packages/learn-github-packages/deleting-and-restoring-a-package), [npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)). That the requests `npm unpublish` makes are accepted with that token is **not verified**. `cache` is `never` and the binding is `package`, so the most dangerous scope is released for one command and never reused; the cost, if the registry answers 404 or 405, is a prompt and a token released for nothing (see [Where it is easy to go wrong](#where-it-is-easy-to-go-wrong), item 9). The transcript is the provider's side only.

A deleted version can be published again: GitHub restores a deleted version within 30 days only if its name and version were not reused ([deleting and restoring](https://docs.github.com/en/packages/learn-github-packages/deleting-and-restoring-a-package)), so reuse is possible, unlike on npmjs.org. A provider's audit log keyed on name and version can see the same version twice.

## Rejection

[rejection.jsonl](github-packages/rejection.jsonl)

What a rejection looks like, from anonymous probes made on 2026-10-17: an existing package without a token gives a 401 with the body `{"error":"authentication token not provided"}` and no `WWW-Authenticate` header; a package that does not exist gives a 404 before any authentication, so existence leaks; `/-/whoami` without a token gives a 403. How GitHub answers an invalid or revoked token (the status, the headers) is **unverified**: no request with a token was made. SSO-unauthorized tokens and missing scopes give a 403 (recalled, not verified), an organization that blocks classic tokens gives a 403 ([personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)), and a token without access to a private package may see a 404 instead (recalled).

**401.** npm drops the token from its cache and sends `erase` with the context of the `get` and its `granularity`. An anonymous 401 from GitHub carries no challenge, and none is assumed for a rejected token, so `authChallenges` is absent.

```json
{"v":1,"kind":"erase","registry":"https://npm.pkg.github.com/","scope":"@acme","package":"widgets","operation":"read","granularity":"scope"}
{"Ok":{"kind":"erase"}}
{"v":1,"kind":"get","registry":"https://npm.pkg.github.com/","scope":"@acme","package":"widgets","operation":"read","command":"install","interactive":false,"retry":true,"httpStatus":401}
```

The stored token is the one the provider hands out, so erase has nothing to replace. It keeps the token, as the RFC says a provider whose stored credential is the credential it hands out does, and does not run a login flow on a 401 alone. The URL may be one a lockfile chose. The provider checks the token itself with `GET https://api.github.com/user` (on GHES, `https://HOSTNAME/api/v3/user`). The transcript shows the case where the check passes: GitHub's API accepts the token, so the 401 came from the URL (a lockfile may have chosen it) or from the registry's side, not from the token. The provider holds no other credential it would release for this request, and handing the same token out again could only fail the same way, so the RFC asks for `other`, saying so. Nothing is stored or deleted, and the request fails naming the provider:

```json
{"Err":{"kind":"other","message":"GitHub says the work account's token is still valid, so the 401 did not come from the token but from the registry or the URL. The provider holds no other credential it would release for this request, and no token is handed out again. Check the registry URL and the package's access settings."}}
```

A retry with nothing stored to check starts no device flow either, even for a write on an interactive request: it answers `other`, naming `npm login` ([rejection-no-token.jsonl](github-packages/rejection-no-token.jsonl)).

If the check fails, the token is dead. The retry is answered with an error that names the cure:

```json
{"Err":{"kind":"other","message":"GitHub rejected the stored token for the work account. Run npm logout and npm login for https://npm.pkg.github.com/."}}
```

That exchange is [rejection-dead-token.jsonl](github-packages/rejection-dead-token.jsonl): the request fails and the session goes on.

Only a 401 from that check calls the token dead: GitHub's answer for a bad credential, which the fake gives and the provider recalls rather than reads (see above). Any other status (a 5xx, a rate limit, an SSO 403) says nothing about the token, so the provider says that it could not tell, names the status, and does not send the person to `npm logout` unless GitHub then rejects the token ([rejection-check-unavailable.jsonl](github-packages/rejection-check-unavailable.jsonl)):

```json
{"v":1,"kind":"get","registry":"https://npm.pkg.github.com/","scope":"@acme","package":"widgets","operation":"read","command":"install","interactive":false,"retry":true,"httpStatus":401}
{"Err":{"kind":"other","message":"GitHub answered 503 when asked whether the stored token for the work account is alive, so nothing is known about it. Try again, and run npm logout and npm login for https://npm.pkg.github.com/ only if GitHub then rejects it."}}
```

A provider backed by `gh` never runs `gh auth logout` or touches `gh`'s store on a rejection. That token belongs to `gh`.

**403.** [rejection-403.jsonl](github-packages/rejection-403.jsonl). npm sends no erase and retries once with `httpStatus: 403`:

```json
{"v":1,"kind":"get","registry":"https://npm.pkg.github.com/","scope":"@acme","package":"widgets","operation":"read","command":"install","interactive":true,"retry":true,"httpStatus":403}
{"Err":{"kind":"other","message":"GitHub refused the work account's token for @acme. The organization may require SSO authorization of the token or may block classic personal access tokens. Authorize it at github.com/settings/tokens, then run npm install again."}}
```

A more privileged token would not help: the same token has to be SSO-authorized, and a write token would be a widening a 403 can send for free. The RFC forbids moving a `read` retry to a credential that can write. The provider answers `other` with a reason instead of returning the same token again. That the SSO hint comes from the `X-GitHub-SSO` header of an API call is recalled, not verified.

A 404 on a token that lacks access to a private package gets no retry and no erase. Under `scope` granularity a wrong-account answer therefore shows as "not found".

## Login and logout

[login.jsonl](github-packages/login.jsonl) holds the two logins and the logout below in one session, to keep the fixture short; npm runs each command with its own session.

`npm login --registry https://npm.pkg.github.com/` goes to the provider. There are two ways in.

```json
{"v":1,"kind":"login","registry":"https://npm.pkg.github.com/","interactive":true}
{"Ok":{"kind":"login"}}
```

- **Without `token`:** the provider runs its own OAuth device flow, which needs no client secret and must be enabled for the app. It requests `read:packages` only, and asks again for `write:packages` the first time a publish needs it. The code and URL go to the controlling terminal, never to stdout or stdin. The code expires after 15 minutes, and `slow_down` adds 5 seconds to the polling interval ([authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)).
- **With `token`:** a classic token the user pasted. GitHub has no documented API to create one, so this is the usual path. The provider validates it with `GET /user`, reads the `X-OAuth-Scopes` response header (see [OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)), warns or refuses if `read:packages` is missing or `repo` is present, and stores it in the keychain.

```json
{"v":1,"kind":"login","registry":"https://npm.pkg.github.com/","interactive":true,"token":"example-pasted-token"}
{"Ok":{"kind":"login"}}
```

A provider that delegates to `gh auth refresh -h HOST -s read:packages,write:packages` must hand `gh` the controlling terminal for stdin and stdout, not the provider's own pipes.

```json
{"v":1,"kind":"logout","registry":"https://npm.pkg.github.com/"}
{"Ok":{"kind":"logout"}}
```

**When the sign-in does not complete.** A device flow can end three ways without a token that GitHub itself decides. The person can cancel on the page: GitHub then answers the provider's poll with `access_denied` and the code cannot be used again, so the provider asks for nothing more and answers `other` ([login-refused.jsonl](github-packages/login-refused.jsonl)). The provider can stop waiting: the code is valid for 15 minutes, but npm kills a `login` at 5 ([Timeouts](../phase-2-credential-provider.md#session-lifecycle)), so the provider's own limit has to be shorter, and `expired_token` is never seen inside one npm `login` ([login-unapproved.jsonl](github-packages/login-unapproved.jsonl)). And the app may not have the device flow enabled (`device_flow_disabled`), which is the same answer with another message ([login-device-flow-disabled.jsonl](github-packages/login-device-flow-disabled.jsonl)). All three are documented in [authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps). A pasted token that fails the `GET /user` check, or lacks `read:packages`, is also `other` ([login-token-refused.jsonl](github-packages/login-token-refused.jsonl)); the `repo` warning goes to stderr only, which a transcript does not record. Nothing is stored in any of these, and the request fails, naming the provider. A fourth case is a provider with no controlling terminal to print the code on: nobody can enter it, so the provider answers `other` at once, saying to run `npm login` from a terminal, and polls nothing ([login-no-terminal.jsonl](github-packages/login-no-terminal.jsonl)). The same holds when a publish starts the `write:packages` device flow after the presence prompt: the prompt is answered, the flow cannot be shown, the answer is `other`, and no write token is stored ([publish-no-terminal.jsonl](github-packages/publish-no-terminal.jsonl)).

```json
{"v":1,"kind":"login","registry":"https://npm.pkg.github.com/","interactive":true}
{"Err":{"kind":"other","message":"GitHub reported that the sign-in was cancelled in the browser (access_denied). Run npm login again to start a new one."}}
```

```json
{"v":1,"kind":"login","registry":"https://npm.pkg.github.com/","interactive":true}
{"Err":{"kind":"other","message":"Stopped waiting for the code to be entered after 4 minutes 30 seconds. Run npm login again."}}
```

Logout deletes the keychain entries first, and only then, as a best effort, revokes a token it was given with `POST https://api.github.com/credentials/revoke`, which takes `ghp_`, `gho_` and `github_pat_` tokens, is unauthenticated (an authenticated call gets a 403), allows 60 requests an hour and notifies the token's owner ([REST](https://docs.github.com/en/rest/credentials/revoke)). Whether GHES has the endpoint is **unverified**. It never revokes `gh`'s token or `GITHUB_TOKEN`. If revocation fails, logout still answers `Ok` and warns on stderr; because the entries are already gone, a GitHub that is slow or down cannot keep them (the RFC: a logout always removes the local credentials, inside its 30 seconds). A login that replaces a stored token revokes the replaced one the same way, once the new one is stored: a token that is no longer kept is one that nobody can revoke later, and the device-flow token is one the provider created. That is also what a pasted token gets, as at logout ([login.jsonl](github-packages/login.jsonl): the device token, replaced by a pasted one, is revoked at the second login and the pasted one at logout).

## CI

[ci.jsonl](github-packages/ci.jsonl) is an install, [ci-publish.jsonl](github-packages/ci-publish.jsonl) a publish and [ci-other-owner.jsonl](github-packages/ci-other-owner.jsonl) a read of another owner's package: three npm commands in a job, so three sessions.

In a GitHub Actions job the provider runs with `interactive: false`: no device flow, no presence prompt. It serves `GITHUB_TOKEN` if the workflow exported it into the environment (for example through `env:` or `setup-node`; Phase 1's environment rules keep it), and otherwise a stored token. It serves it only to a request that is not interactive: the job is told from the environment, which a terminal can set too (a developer's own `GITHUB_TOKEN` with `GITHUB_ACTIONS=true` exported), and the job token is released with no presence, so an interactive request takes the stored token and the presence prompt instead ([ci-interactive.jsonl](github-packages/ci-interactive.jsonl), a publish).

```json
{"v":1,"kind":"get","registry":"https://npm.pkg.github.com/","scope":"@acme","package":"widgets","operation":"read","command":"ci","interactive":false}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-actions-token"},"cache":"session","operationIndependent":false,"granularity":"scope"}}
```

And the publish, in its own session:

```json
{"v":1,"kind":"get","registry":"https://npm.pkg.github.com/","scope":"@acme","package":"widgets","version":"2.4.2","operation":"publish","command":"publish","interactive":false}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-actions-token"},"cache":"session","operationIndependent":false,"granularity":"package"}}
```

- The `read` answer carries `operationIndependent: false` although one token serves both operations here: the provider marks every `read` answer so, because outside Actions it holds a stronger token for `publish`, and `true` would let the cached read entry answer the `publish` lookup with no `get`.
- The job's token covers only the workflow's repository, so the provider answers `@acme` (the workflow's owner) and has nothing for another owner. For `@other-org` it answers `not-found`, not `other`: nothing is stored, and the user's chain then decides what comes next. The reference provider is simpler than the token: a request names an owner, not a repository, so it compares only the owner (`GITHUB_REPOSITORY_OWNER`) and serves the job token for every package of that owner, and for every unscoped read, which GitHub proxies from npmjs.org (a publish of an unscoped package gets nothing from it). A package the repository has no access to is refused by the registry, and the retry then answers `other`, naming the workflow's package permissions, rather than the token just refused ([ci-rejected.jsonl](github-packages/ci-rejected.jsonl)). The job is recognised by `GITHUB_ACTIONS=true` together with `GITHUB_TOKEN`, both from the environment, which is as trustworthy as the environment is.
- Withholding `GITHUB_TOKEN` would gain nothing: every lifecycle script in the step already sees the same variable. The provider's value in CI is consistency with other environments, not secrecy. It removes no standing secret from the runner, and a stored classic token for cross-owner reads is still one.
- OIDC trusted publishing does not exist for GitHub Packages (recalled), so the RFC's precedence for an exchanged token never applies here.

## Where it is easy to go wrong

1. **Treating one host as one tenant.** Every owner shares `https://npm.pkg.github.com/`. A provider cannot use `registry` to say "I serve `@acme` but not `@someone-else`": `url-not-supported` is decided from `registry` alone and remembered for the registry. An owner allowlist has to look at `scope`, and the available answers all have a cost: `not-found` lets a listed or implicit `npm:token` send a stored token; `other` fails the install, and Packages wants a token even for public packages. Any project can add `@anyowner:registry=https://npm.pkg.github.com/` and have the user's token sent for that owner's packages. The token goes only to GitHub, but the repository picks whose code is fetched with the user's identity, and that owner sees the download.
2. **Answering `registry` where one account is not the only one.** People hold a work and a personal account; in Actions `GITHUB_TOKEN` covers the workflow's repository and other owners need a classic token. Once a provider answers `scope` for any request on a registry, it must never answer `registry` there, and must answer `scope` for unscoped requests too. A `registry`-level answer is found by the registry step of the cache lookup for every scope with no entry of its own, and sends account A's token for `@owner-b`, which gives a 404 or a 403.
3. **Saying `operationIndependent: true` on a read answer when a stronger token exists for another operation.** The lookup tries an operation-bound entry and then an operation-independent one at each level. A read token cached as independent is found for the `publish` request, goes out on the `PUT`, gets a 403, and the publish's single retry is spent on recovering. The RFC's description of the field says that `true` is only for a credential that may serve every operation.
4. **Building on `gh auth token` for least privilege.** `gh`'s token always carries `repo`, `read:org` and `gist`. A provider, or a Phase 1 helper, that hands it out gives npm, and any install script that runs the provider, a token that can push code, not only read packages. Phase 1's Vendor CLIs table notes it.
5. **Letting `GH_TOKEN` choose the identity.** The provider's environment keeps `GH_TOKEN` and `GITHUB_TOKEN`, since only npm's own variables are removed, and `gh` documents that they override stored credentials for github.com and ghe.com; GHES uses `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` ([environment](https://cli.github.com/manual/gh_help_environment)). `gh` recommends `GH_TOKEN` for fine-grained tokens ([gh auth login](https://cli.github.com/manual/gh_auth_login)), which Packages does not support. A `gh`-backed provider run in a shell with `GH_TOKEN` set returns a token the registry rejects or one for another identity, and the 401 or 403 looks like a provider bug.
6. **Letting a child process inherit the protocol's pipes.** `gh auth refresh` and `gh auth login` prompt and print device codes. A child that inherits the provider's stdin reads protocol bytes or blocks, and one that inherits stdout corrupts the JSON stream. Give it the controlling terminal (`/dev/tty`, or `CONIN$` and `CONOUT$`) or capture its output. `gh auth token` with captured stdout is the only plain subprocess that is safe.
7. **Expecting `erase` to replace a token.** Classic tokens, `gh` tokens and default OAuth tokens are long-lived and are the stored credential itself. Nothing can mint a narrower token from them, unlike on [GitLab](gitlab.md). Erase reports and keeps. Only an OAuth app that opted in to expiring tokens can drop one and refresh it, and whether the registry accepts those is unverified.
8. **Starting a login on a 401.** Check with `GET /user` first, and use `cache: "session"` rather than inventing an `expiresAt` the provider does not know. A classic token with an expiry date may show it in a `GitHub-Authentication-Token-Expiration` response header (recalled), which is the one case where `expires` would be honest.
9. **Mapping `unpublish` or `deprecate` blindly.** A provider that maps `unpublish` to a `delete:packages` token prompts the user to release the most dangerous scope for a request that may fail with a 404 or 405. A provider that answers `deprecate` with a write token hands over a token for a request that fails with a 400. Answering `operation-not-supported` avoids both, but hard-codes today's registry and blocks the day GitHub adds support.
10. **Reading nothing into a 404.** Package existence leaks before authentication, an unscoped package without a token gets a 404 (`/lodash`), and a token without access may see a 404. npm never retries a 404, so a wrong-account answer looks like "not found". Do not widen a later answer because of one.
11. **GHES keys and hosts.** Without subdomain isolation the registry shares a host with the web UI and API. The hello entry and any per-registry key carry `/_registry/npm/`, because a bare `//HOSTNAME/` key would also cover API traffic if npm ever asked about it. The provider maps the npm host to the API host (`npm.HOSTNAME` and `HOSTNAME/_registry/npm` to `HOSTNAME`, API at `HOSTNAME/api/v3`; `npm.pkg.github.com` to `github.com`, API at `api.github.com`) and reads `GH_ENTERPRISE_TOKEN`, not `GH_TOKEN`, there.
12. **A default registry that proxies npmjs.org.** With `registry=https://npm.pkg.github.com/`, the provider is asked about `@types` and every other scope in the tree, and the audit request, and must return a token: anonymous requests are refused, and `/lodash` without a token gives a 404. A provider that picks accounts by owner needs a default account for scopes it does not know. The reference provider does that: `defaultAccount` serves every owner not in `owners`, so the exposure in item 1 stands for it.
13. **Revoking what it does not own.** Logout may revoke a token the provider was given. It must not revoke `gh`'s token (that breaks `gh` everywhere) or `GITHUB_TOKEN`.
14. **Expecting a security gain in Actions.** The provider removes no standing secret there. The token is in the environment only if the workflow put it there, and then every script in the step has it already.

## What this registry asks of the RFC

1. **A multi-tenant host, where the tenant is the scope** ([Provider chaining](../phase-2-credential-provider.md#error-response), [Registry matching](../phase-2-credential-provider.md#registry-matching)). The RFC decides `url-not-supported` from `registry` alone and remembers it per registry, which has no answer for a host like `npm.pkg.github.com`, where the same URL serves every owner and the provider's decision depends on `scope`. The text should say which error a provider that serves some owners and not others uses (`not-found` lets `npm:token` or the legacy-fallback opt-in send a stored token behind it; `other` fails the install), and that a listed `npm:token` behind such a provider is how the stored token gets sent for an owner the provider declined. **In the RFC:** Provider chaining says such a provider answers `not-found` for the scopes it does not serve, never `url-not-supported`.
2. **A key with an empty path segment** ([Registry matching](../phase-2-credential-provider.md#registry-matching)). GitHub's GHES documentation prints the token key as `//npm.HOSTNAME//:_authToken`. Under the RFC's byte-wise comparison at a segment boundary, a `credentialProvider` key written the same way has the path `//` and does not cover `/@scope/pkg`, so the list silently never applies and the global chain or a stored token is used instead. **In the RFC:** the Keys bullet says `//host//` has the path `//` and does not cover `/@scope/pkg`. npm's stored-token lookup does not match it either for a request such as `/@scope/pkg`: npm-registry-fetch walks the request URL up one segment at a time to `//host/` and `//host`, so for a URL with no empty path segment it never tries `//host//` (a URL that has one, such as `https://host//@scope/pkg`, walks through it), and looks keys up as written ([`lib/auth.js` at the base commit 6b4159a](https://github.com/npm/npm-registry-fetch/blob/6b4159a2519ce5aab26cc4dd8d4596a0b47781d2/lib/auth.js#L9-L28)).
3. **Guidance for a provider that answers `scope`** ([Caching](../phase-2-credential-provider.md#5-caching)). Once a provider answers `scope` for any request on a registry, it should answer `scope` for every request there, unscoped ones included: a `registry`-level answer shadows the scope-level entries for every owner that has none yet. The text says only that a provider that issues finer tokens says so in `granularity`. Guidance, not a defect.
4. **`operationIndependent` on a read answer** ([Success response](../phase-2-credential-provider.md#success-response-provider--client)). A provider with a stronger token for another operation must not say `true` on the read answer, or the cached read token is found for the write. The RFC said this for stage-only tokens only, and its default was `true`. **In the RFC:** the field defaults to `false` and its description says `true` is for a credential that may serve every operation, and the GitLab page writes it out.
5. **A 403 retry with nothing better** ([`erase`](../phase-2-credential-provider.md#erase-a-credential-was-rejected)). The RFC says a retry may move to another credential the provider would release and any answer but `Ok` fails the request. It does not say what a provider with no other credential does after a 403: here it answers `other` with a reason (SSO authorization, a blocked classic token) rather than resend the same token. **In the RFC** as guidance in the RFC's retry bullet.
6. **Child processes inherit the protocol's pipes** ([Non-interactive and CI behavior](../phase-2-credential-provider.md#non-interactive-and-ci-behavior)). The RFC forbids the provider to read stdin and tells it to open the controlling terminal for a prompt. It does not say that a child process the provider spawns (here `gh`) inherits the pipes and must be given the terminal or captured. **In the RFC** as guidance under Non-interactive and CI behavior.
7. **Phase 1's Vendor CLIs row for GitHub Packages** ([phase-1-token-helper.md](../phase-1-token-helper.md#vendor-clis)): `gh auth token` hands out a token carrying `repo`, and the docs say Packages accepts only classic tokens. **In the RFC:** a note under that table says so.

Nothing here changes the protocol; items 1 and 2 were where the text was silent for this registry.

## Sources

- [Working with the npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry), and the [GHES 3.14 version](https://docs.github.com/en/enterprise-server@3.14/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)
- [About permissions for GitHub Packages](https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages)
- [Deleting and restoring a package](https://docs.github.com/en/packages/learn-github-packages/deleting-and-restoring-a-package), [REST: packages](https://docs.github.com/en/rest/packages/packages), [REST: revoke credentials](https://docs.github.com/en/rest/credentials/revoke)
- [Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens), [OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps), [authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)
- [gh auth login](https://cli.github.com/manual/gh_auth_login), [gh auth token](https://cli.github.com/manual/gh_auth_token), [gh auth refresh](https://cli.github.com/manual/gh_auth_refresh), [gh environment](https://cli.github.com/manual/gh_help_environment)
- [Roadmap issue 558](https://github.com/github/roadmap/issues/558), [community discussion 63811](https://github.com/orgs/community/discussions/63811)
- Anonymous requests to `https://npm.pkg.github.com/` made on 2026-10-17: an existing package gave a 401 without `WWW-Authenticate`, a missing scoped package and `/lodash` gave 404, `/-/whoami` and the per-owner path form gave 403.
