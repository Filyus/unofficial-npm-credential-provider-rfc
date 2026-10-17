# GitLab

A hypothetical `npm-credential-provider-gitlab` for the npm package registry of a GitLab instance, here `gitlab.example.com`. Nothing here exists: the provider, its name, its keychain layout and the way it obtains tokens are invented, and its behaviour follows the [Phase 2 protocol](../phase-2-credential-provider.md). What it relies on is GitLab's documented behaviour, cited below, and where the documentation does not say, this page says so. The example shows a registry whose URL names a project, so the credential must follow the project; a login that holds only a refresh token while the registry takes other kinds of token, so the provider turns one into the other; and a CI case where the credential already exists in the job's environment.

## Registry and credentials

**URL shapes.** GitLab serves the npm registry at three levels ([npm registry](https://docs.gitlab.com/user/packages/npm_registry/)):

- project: `https://<host>/api/v4/projects/<project_id>/packages/npm/`
- group: `https://<host>/api/v4/groups/<group_id>/-/packages/npm/`
- instance: `https://<host>/api/v4/packages/npm/`

Publishing uses the project endpoint. Installing can use any of the three, and the URL needs its trailing slash, since omitting it can cause a 403. An install from the instance endpoint requires a scoped name whose scope is the lowercase root group of the project that holds the package. This provider matches project URLs only (`/api/v4/projects/`) and answers `url-not-supported` for the others.

**Credentials.** The documented ones ([npm registry](https://docs.gitlab.com/user/packages/npm_registry/)):

| Kind | Scope or role | Lifetime |
|---|---|---|
| Personal, group or project access token | `api`; for an organization that uses 2FA the page names a personal access token with `api` | set at creation; the page recommends a short expiry for personal access tokens |
| Deploy token | `read_package_registry`, `write_package_registry`, or both | none by default; an optional expiry date, which the [deploy token page](https://docs.gitlab.com/user/project/deploy_tokens/) puts at 00:00 UTC on that date |
| CI/CD job token (`CI_JOB_TOKEN`) | the access of the user who triggered the pipeline | valid only while the job runs ([job token](https://docs.gitlab.com/ci/jobs/ci_job_token/)) |

A deploy token's secret is shown once, and its username defaults to `gitlab+deploy-token-{n}` ([deploy tokens](https://docs.gitlab.com/user/project/deploy_tokens/)). A project deploy token can be created and deleted through the API (`POST /projects/:id/deploy_tokens`, `DELETE /projects/:id/deploy_tokens/:token_id`) by a Maintainer or Owner, with `scopes` and an optional `expires_at` ([deploy tokens API](https://docs.gitlab.com/api/deploy_tokens/)). An OAuth access token lives two hours (7200 seconds) by default, and a refresh token replaces both tokens when used ([OAuth provider](https://docs.gitlab.com/integration/oauth_provider/), [OAuth 2.0 API](https://docs.gitlab.com/api/oauth2/)). The same API page lists the device authorization grant (its history section puts general availability at GitLab 17.9, its list of flows says 17.1 and later) and PKCE.

**Open points.** The two OAuth pages disagree about the package registry. The provider page says package registry access is covered by `api` (read and write) and `read_api` (read only). The API page says standard OAuth tokens do not allow authenticating to the package registry ([OAuth provider](https://docs.gitlab.com/integration/oauth_provider/), [OAuth 2.0 API](https://docs.gitlab.com/api/oauth2/)). GitLab documents no way to exchange an OAuth token for a short-lived package registry token. The registry page lists a deploy token among the values for `_authToken`, which npm sends as a bearer token. Unverified here: whether an OAuth token with the `api` scope may call the deploy-token endpoint. This example assumes it may. The provider therefore never sends its OAuth token to the registry. It uses the OAuth token only to mint a deploy token for the project, scoped to `read_package_registry` or `write_package_registry`, and sends that.

## Configuration

```ini
# ~/.npmrc (user config)
credentialProvider[]=npm-credential-provider-gitlab --instance https://gitlab.example.com
```

```ini
# the project's .npmrc: registries only, never a provider or a token
@acme:registry=https://gitlab.example.com/api/v4/projects/42/packages/npm/
@acme-tools:registry=https://gitlab.example.com/api/v4/projects/42/packages/npm/
```

The provider is in the global chain, not under a `//gitlab.example.com/` key, because the request must name the project. npm sends the URL that matched: the key's, or, when no key matches, the registry the request chose ([Registry matching](../phase-2-credential-provider.md#registry-matching)). A key for the host, or for `/api/v4/`, would match first and send `https://gitlab.example.com/` or `https://gitlab.example.com/api/v4/`, and the provider could not tell project 42 from project 43. A key per project works too, one line for each, and also gives the right URL. The global form needs one provider line, and the projects stay in the repositories that use them. The cost is that a global provider is asked about every registry, which the hello below removes. The `--instance` argument is for the provider's own use, for example to find the right keychain entry.

The project `.npmrc` carries no token: a `_authToken` there would be a standing secret, and GitLab's own example keeps tokens out of committed files by reading `${NPM_TOKEN}` ([npm registry](https://docs.gitlab.com/user/packages/npm_registry/)).

## Hello

```json
{"v":[1],"capabilities":["login","logout","erase","retry-context"],"registries":["https://gitlab.example.com/api/v4/projects/"]}
```

- `"v":[1]` is the only version this provider speaks.
- `registries` lists one entry, the `/api/v4/projects/` path on the instance. It matches at a segment boundary, so it covers every project URL, and npm never asks the provider about npmjs.com or any other host, nor about a group or instance URL on this host ([Registry matching](../phase-2-credential-provider.md#registry-matching)). The scheme is `https:`, so an `http:` form of the host is not served.
- `login` and `logout` because the provider runs the OAuth flow and keeps the refresh token; `erase` because it deletes the deploy tokens it minted when one is rejected; `retry-context` because it uses `httpStatus` on a retry. Capabilities are advisory ([Version negotiation](../phase-2-credential-provider.md#version-negotiation)).

## Install

[install.jsonl](gitlab/install.jsonl). An interactive `npm install` needs `@acme/widgets` from project 42. The provider reads the refresh token from the keychain, refreshes the OAuth access token (the refresh replaces both tokens, so it stores the new refresh token), creates a deploy token for project 42 with `read_package_registry` and an expiry at the first 00:00 UTC after its own limit below, and answers:

```json
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-read-deploy-token"},"cache":"expires","expiresAt":1792198800,"operationIndependent":false,"granularity":"scope"}}
```

`expiresAt` is the provider's own limit, an hour from now. GitLab's expiry is a backstop: documented as 00:00 UTC on a date, so the token outlives the limit by up to a day. The provider deletes the token itself on `erase` and `logout`, and may try to at the end of the session, but npm need not wait for the provider to exit ([Session lifecycle](../phase-2-credential-provider.md#session-lifecycle)), so the expiry is what limits a token whose deletion never ran. `operationIndependent` is `false` because the provider holds a separate write token: at the default the cached read token would be found for the `publish` lookup and sent without the presence prompt. `granularity` is `scope`: every `@acme/*` package is a cache hit. Because the registry URL already contains the project, `registry` would give the same cache key while only `@acme` points at project 42; `scope` keeps one token per scope, so that erasing the token of `@acme` leaves `@acme-tools` alone. The second request in the file, for `@acme-tools/lint-rules`, is a new `get` and a second deploy token.

## Publish

[publish.jsonl](gitlab/publish.jsonl). `npm publish` of `@acme/widgets@2.4.1` sends `operation: "publish"` with `version`. The provider mints a deploy token with `write_package_registry`, after the user-presence prompt its policy requires for write credentials (the request is interactive):

```json
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-write-deploy-token"},"cache":"never","operationIndependent":false,"granularity":"package"}}
```

`cache: "never"` keeps the write token out of npm's cache, so the next publish asks again, and the provider's own record of the token lets it delete the token on its own timer or when the session ends. `granularity` is still set, since npm keeps it with the credential for any later `erase`. GitLab refuses a publish of a name already in the root namespace with a 400, even for a new version ([npm registry](https://docs.gitlab.com/user/packages/npm_registry/)); that is not a credential problem and no retry follows it. GitLab's registry page describes `npm deprecate`, which it says needs permission to delete packages, and says nothing about `unpublish`, deleting a package being a UI or API action for a Maintainer or Owner. It does not say whether a deploy token may deprecate. This provider holds no credential it knows to serve either, so it answers `deprecate` and `unpublish` with `operation-not-supported`. The transcript model cannot show that answer ([What this registry asks of the RFC](#what-this-registry-asks-of-the-rfc)). `dist-tag` works with a job token or a deploy token ([npm registry](https://docs.gitlab.com/user/packages/npm_registry/)), so the provider maps it to the write token.

## Rejection

[rejection.jsonl](gitlab/rejection.jsonl) is a 401. The registry refuses the read token, perhaps because someone revoked it in the project settings. npm drops its cache entries, sends an erase with the context of the `get` and its `granularity`, then retries once:

```json
{"v":1,"kind":"erase","registry":"https://gitlab.example.com/api/v4/projects/42/packages/npm/","scope":"@acme","package":"widgets","operation":"read","granularity":"scope"}
{"v":1,"kind":"get","registry":"https://gitlab.example.com/api/v4/projects/42/packages/npm/","scope":"@acme","package":"widgets","operation":"read","command":"install","interactive":true,"retry":true,"httpStatus":401}
```

The erase deletes the deploy token the provider minted for that scope. It does not touch the refresh token: that is `logout`'s job, and a 401 may come from a URL a lockfile chose ([`erase`](../phase-2-credential-provider.md#erase-a-credential-was-rejected)). The retry mints a new deploy token. If the refresh token no longer works, the provider answers `other` and names `npm login`; it opens no browser on the strength of the 401 alone. The request in the file carries no `authChallenges`, because this page does not know which `WWW-Authenticate` value GitLab sends.

[forbidden.jsonl](gitlab/forbidden.jsonl) is a 403. GitLab's own list of causes for a 403 on install includes an expired token, a missing trailing slash, a disabled registry, and a same-name package in the scope ([npm registry](https://docs.gitlab.com/user/packages/npm_registry/)), so a 403 here can mean either permissions or an expired token. npm sends no erase after a 403, and the retry follows no erase. The provider, which knows when its own token expires, answers with a fresh read token; it never answers a `read` retry with a token that can write.

## Login and logout

[login.jsonl](gitlab/login.jsonl). `npm login --registry https://gitlab.example.com/api/v4/projects/42/packages/npm/` sends `login` with `interactive: true`. The provider starts the device authorization grant, or an authorization code flow with PKCE, prints the URL and code on the controlling terminal, polls, and keeps the refresh token in the OS keychain. It answers `{"Ok":{"kind":"login"}}`. No token is written to a file npm reads.

[logout.jsonl](gitlab/logout.jsonl). `npm logout` sends `logout`. The provider revokes the OAuth tokens on a best effort basis, deletes any deploy tokens it still holds (`DELETE /projects/:id/deploy_tokens/:token_id`), removes the keychain entry, and answers `{"Ok":{"kind":"logout"}}` even if revocation failed, warning on stderr.

## CI

In a GitLab job there is no keychain and no browser. The provider is in the job image and configured in its global npmrc; the job's `CI_JOB_TOKEN` is already in its environment.

[ci.jsonl](gitlab/ci.jsonl). `npm ci` sends `interactive: false`. The provider checks that the registry host is the job's `CI_SERVER_HOST` and that the project is the job's own `CI_PROJECT_ID`, and answers with the job token:

```json
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-job-token"},"cache":"session","operationIndependent":false,"granularity":"registry"}}
```

The token lasts while the job runs ([job token](https://docs.gitlab.com/ci/jobs/ci_job_token/)), so `session` is enough; `operationIndependent` is `false` here too, as on every read answer of this provider, since outside CI it holds a stronger token for `publish`. [ci-publish.jsonl](gitlab/ci-publish.jsonl) is the same for `npm publish`: the pipeline is what authorizes the publish, so the provider asks for no presence it could not get and releases the job token, with `operationIndependent: false`. GitLab documents `_authToken=${CI_JOB_TOKEN}` for publishing from a pipeline ([npm registry](https://docs.gitlab.com/user/packages/npm_registry/)). A job outside a CI environment has no job token and no refresh token, and the provider answers `not-found`. A deploy token kept in a CI variable works the same way: the provider reads it from the environment and answers with it.

## Where it is easy to go wrong

- **Sending the OAuth access token to the registry.** The OAuth 2.0 API page says OAuth tokens do not authenticate to the package registry, while the provider page lists package registry access under `api` ([OAuth 2.0 API](https://docs.gitlab.com/api/oauth2/), [OAuth provider](https://docs.gitlab.com/integration/oauth_provider/)). A provider that sends it works for some GitLab versions and fails for others, and an `api` token is far broader than a read credential. Send a deploy token.
- **Treating `expires_at` as a clock.** A deploy token's expiry is a date, so the GitLab-side lifetime is counted in days, up to a day past the limit the provider means. The short life comes from the provider: a small `expiresAt` in the answer, and deletion of the token. A provider that relies on GitLab's expiry hands out day-long tokens.
- **Leaking deploy tokens.** A token that is never deleted stays valid until its date, or forever when no expiry was set. Delete on `erase` and on `logout`, and never create one without `expires_at`. Deleting when the session ends is best effort: npm sends `erase` only after a rejection and need not wait for the provider to exit, so the token's own expiry and a timer in the provider are what limit it.
- **Reading the project from the wrong place.** The project is in the `registry` field. A host-level `credentialProvider` key hides it, as the Configuration section says, and a provider that falls back to a default project mints a token for the wrong one.
- **Matching the wrong URL.** The group and instance endpoints take other credentials and, for the instance one, a scope equal to the root group ([npm registry](https://docs.gitlab.com/user/packages/npm_registry/)). A provider that serves them with a project token gets 404 or 403 on install. Answer `url-not-supported`, or list only the project path in hello.
- **Releasing the job token for any project.** `CI_JOB_TOKEN` reaches only its own project by default, plus the projects whose allowlist names it ([job token](https://docs.gitlab.com/ci/jobs/ci_job_token/)), and the registry page says that installing with it a package whose dependencies are in another project gives 404 ([npm registry](https://docs.gitlab.com/user/packages/npm_registry/)). A provider that hands it to a registry for any project on the host fails on dependencies in other projects, and sends the pipeline's token to registries it never meant to serve.
- **Starting a login on a 401.** A 401 does not prove the login is dead. Check the refresh token with a refresh before saying so.
- **Widening on a 403.** A 403 for an expired token or a missing trailing slash is not a request for a write token. Answer a `read` retry with a read token or fail.
- **Forgetting `forward`.** GitLab forwards a request for a package it does not hold to npmjs.com unless an administrator or group Owner disables it, and `npm audit` sends its body, including private package names, to the public registry unless run with `--registry` pointing at GitLab ([npm registry](https://docs.gitlab.com/user/packages/npm_registry/)). This is the registry's behaviour, not the provider's, and the provider cannot change it; its README should say so.

## What this registry asks of the RFC

- **A key above the project hides the project ([Registry matching](../phase-2-credential-provider.md#registry-matching)).** The text says `registry` is the URL that matched, and a key for the registry's host is the form most other examples use. For GitLab that URL is too coarse to choose a credential, and the registry URL the user configured (`@acme:registry`) reaches the provider only through the global chain. The RFC could say this where it describes what a provider that needs a path component must configure: a key at or below the path it needs, or the global chain with hello `registries`. The text is correct as it stands; the effect for providers is easy to miss. **Settled:** What is sent now says that a hello entry is never what is sent, and that a provider needing a path component gets it from the global chain or from a key at or below that path.
- **The end of a session does not say whether npm waits for the provider ([Session lifecycle](../phase-2-credential-provider.md#session-lifecycle)).** "The client closes stdin to end the session, and the provider exits." A provider that deletes the deploy tokens it minted, or revokes a credential, does so after stdin closes, and a call to GitLab may take longer than npm waits before it exits. The RFC should say whether npm waits for the child, for how long, and whether a provider may rely on cleanup at close. Without that a provider with a revocable credential relies on `erase` and a short expiry. **Settled:** npm need not wait and sets no deadline, so a provider does not depend on work after stdin closes.
- **A 403 carries no erase and does not say which credential it refused ([`erase`](../phase-2-credential-provider.md#erase-a-credential-was-rejected)).** GitLab's documentation lists an expired token among the causes of a 403 on install. By the table the credential is not erased and the retry carries `httpStatus: 403` only, without the `granularity` or the credential that was refused. The retry still names `registry`, `scope`, `package` and `operation`, so a provider that keeps its own record of what it handed out for that context copes; the RFC does not say that it should. It would help to say so, and either state that a provider keeps its own record of what it handed out, or let the retry carry what an erase carries. **Settled:** the RFC now says the retry names the context, not the credential or the reason, and that a provider which needs the credential keeps its own record.
- **No place for a credential that must be created and deleted** ([`erase`](../phase-2-credential-provider.md#erase-a-credential-was-rejected), [Caching](../phase-2-credential-provider.md#5-caching)). With `cache: "never"` npm sends an erase only on a rejection, so nothing tells the provider that a write token it minted has been used and may be deleted. The provider must delete on its own timer or at session end. This is a consequence of the design, not an error in it; a short note would save provider authors from looking for a signal that does not exist. **Settled** by the same Session lifecycle sentence: cleanup after stdin closes is not guaranteed, so the token's expiry limits it.
