# GitLab

A hypothetical `npm-credential-provider-gitlab` for the npm package registry of a GitLab instance, here `gitlab.example.com`. Nothing here exists: the provider, its name, its keychain layout and the way it obtains tokens are invented, and its behaviour follows the [Phase 2 protocol](../phase-2-credential-provider.md). What it relies on is GitLab's documented behaviour, cited below, and where the documentation does not say, this page says so. The example shows a registry whose URL names a project, so the credential must follow the project; a login that holds only a refresh token while the registry takes other kinds of token, so the provider turns one into the other; and a CI case where the credential already exists in the job's environment.

## Registry and credentials

**URL shapes.** GitLab serves the npm registry at three levels ([npm registry](https://docs.gitlab.com/user/packages/npm_registry/)):

- project: `https://<host>/api/v4/projects/<project_id>/packages/npm/`
- group: `https://<host>/api/v4/groups/<group_id>/-/packages/npm/`
- instance: `https://<host>/api/v4/packages/npm/`

Publishing uses the project endpoint. Installing can use any of the three, and the URL needs its trailing slash, since omitting it can cause a 403. An install from the instance endpoint requires a scoped name whose scope is the lowercase root group of the project that holds the package. This provider matches project URLs only (`/api/v4/projects/`) and answers `url-not-supported` for the others, and for the `http:` form of the host, in `get`, `erase`, `login` and `logout` alike (no transcript shows it, because npm never sends such a request: the conformance harness does, to every provider and every kind).

**Why not the group and instance endpoints.** The credential this provider hands out is a deploy token minted for one project (`POST /projects/:id/deploy_tokens`), and a group or instance URL does not name a project.

Serving them would mean choosing the project from the package's scope, which only GitLab's own resolution does, or minting something broader than a per-project read token. Neither is the smaller correct change, so the provider declines them, and the RFC's examples configure a project's registry: a per-registry key at `/api/v4/projects/<id>/packages/npm/`, or the global chain with the project in the repository's `@scope:registry`. A user who installs from a group or instance endpoint puts a per-registry list that holds just `npm:token` on that URL, which also puts the stored credential there on purpose ([Legacy fallback](../phase-2-credential-provider.md#legacy-fallback)).

**Credentials.** The documented ones ([npm registry](https://docs.gitlab.com/user/packages/npm_registry/)):

| Kind | Scope or role | Lifetime |
|---|---|---|
| Personal, group or project access token | `api`; for an organization that uses 2FA the page names a personal access token with `api` | set at creation; the page recommends a short expiry for personal access tokens |
| Deploy token | `read_package_registry`, `write_package_registry`, or both | none by default; an optional expiry date, which the [deploy token page](https://docs.gitlab.com/user/project/deploy_tokens/) puts at 00:00 UTC on that date |
| CI/CD job token (`CI_JOB_TOKEN`) | the access of the user who triggered the pipeline | valid only while the job runs ([job token](https://docs.gitlab.com/ci/jobs/ci_job_token/)) |

A deploy token's username defaults to `gitlab+deploy-token-{n}` ([deploy tokens](https://docs.gitlab.com/user/project/deploy_tokens/)).

A project deploy token:

- is created and deleted through the API (`POST /projects/:id/deploy_tokens`, `DELETE /projects/:id/deploy_tokens/:token_id`) by a Maintainer or Owner, with `scopes` and an optional `expires_at` ([deploy tokens API](https://docs.gitlab.com/api/deploy_tokens/));
- has its secret in the response that creates it. The API's examples for retrieving one token and for listing carry none, so the provider keeps what it needs (the id) and never expects to read the secret again.

OAuth tokens ([OAuth provider](https://docs.gitlab.com/integration/oauth_provider/), [OAuth 2.0 API](https://docs.gitlab.com/api/oauth2/)):

- An access token lives two hours (7200 seconds) by default.
- A refresh token replaces both tokens when used.

The same API page lists the device authorization grant (its history section puts general availability at GitLab 17.9, its list of flows says 17.1 and later) and PKCE.

**Open points.** The two OAuth pages disagree about the package registry ([OAuth provider](https://docs.gitlab.com/integration/oauth_provider/), [OAuth 2.0 API](https://docs.gitlab.com/api/oauth2/)):

- The provider page says package registry access is covered by `api` (read and write) and `read_api` (read only).
- The API page says standard OAuth tokens do not allow authenticating to the package registry.

GitLab documents no way to exchange an OAuth token for a short-lived package registry token. The registry page lists a deploy token among the values for `_authToken`, which npm sends as a bearer token.

In GitLab's code an `api`-scoped token reaches every API route ([api.rb at 449ed28](https://github.com/gitlabhq/gitlabhq/blob/449ed2875c2e3c4b51169484b799f4f803194ab5/lib/api/api.rb#L58)), and creating a deploy token asks only for the Maintainer or Owner role ([deploy_tokens.rb](https://github.com/gitlabhq/gitlabhq/blob/449ed2875c2e3c4b51169484b799f4f803194ab5/lib/api/deploy_tokens.rb#L110-L112)), so a Maintainer's OAuth token with `api` may call it. That was read in the code, and then tried: on 2026-10-22 against GitLab 19.5.1 (the revision those links name), the OAuth access token of a Maintainer, obtained through the device authorization grant, created project deploy tokens with `POST /projects/:id/deploy_tokens` (201, for `read_package_registry` and for `write_package_registry`) and deleted them (204); the same call with a Developer's OAuth token was a 403, and with a token of a user who is no member of the project a 404 ([Against a real GitLab](#against-a-real-gitlab)).
- On that GitLab, the two OAuth pages' disagreement about the registry is settled the other way from the API page: the OAuth access token of a Developer or a Maintainer was accepted by the project's npm registry, for a read and for a publish (200). The provider still never sends it there: what GitLab accepts today is not what its documentation promises, and an `api` token is far broader than the read credential this provider hands out.

The provider therefore never sends its OAuth token to the registry. It uses the OAuth token only to mint a deploy token for the project, scoped to `read_package_registry` or `write_package_registry`, and sends that.

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

The provider is in the global chain, not under a `//gitlab.example.com/` key, because the request must name the project. npm sends the URL that matched: the key's, or, when no key matches, the registry the request chose ([Registry matching](../phase-2-credential-provider.md#registry-matching)). A key for the host, or for `/api/v4/`, would match first and send `https://gitlab.example.com/` or `https://gitlab.example.com/api/v4/`, and the provider could not tell project 42 from project 43.

Two forms work:

- A key per project, one line for each, which also gives the right URL.
- The global form, which needs one provider line, and the projects stay in the repositories that use them. A provider in the global chain must list its registries in its hello, as the one below does; npm asks it about no registry outside the list ([Version negotiation](../phase-2-credential-provider.md#version-negotiation)).

The `--instance` argument is for the provider's own use, for example to find the right keychain entry; with or without a trailing slash it names the same instance, and the hello below is the same.

**The reference provider's settings.** [The reference provider](providers/gitlab/provider.js) reads a JSON file named by a `--config <file>` argument that the line above leaves out; it fails to start without one. The file holds the settings the page shows as arguments, here `instance` (the `--instance` argument overrides it), and `clientId`, the id of the OAuth application it logs in with. The rest of the file is for the run: where its store is, which address answers for the host, the clock, the scripted answers of the person ([providers/README.md](providers/README.md)).

The project `.npmrc` carries no token: a `_authToken` there would be a standing secret, and GitLab's own example keeps tokens out of committed files by reading `${NPM_TOKEN}` ([npm registry](https://docs.gitlab.com/user/packages/npm_registry/)).

## Hello

```json
{"v":[1],"capabilities":["login","logout"],"registries":["https://gitlab.example.com/api/v4/projects/"]}
```

- `"v":[1]` is the only version this provider speaks.
- `registries` lists one entry, the `/api/v4/projects/` path on the instance. It matches at a segment boundary, so it covers every project URL, and npm never asks the provider about npmjs.com or any other host, nor about a group or instance URL on this host ([Registry matching](../phase-2-credential-provider.md#registry-matching)). The scheme is `https:`, so an `http:` form of the host is not served.
- `login` and `logout` because the provider runs the OAuth flow and keeps the refresh token. On `erase`, which npm always sends, it deletes the deploy token it minted when one is rejected. It uses `httpStatus` on a retry without announcing anything, since npm sends the retry fields to every provider. Capabilities are advisory ([Version negotiation](../phase-2-credential-provider.md#version-negotiation)).

## Install

[install.jsonl](gitlab/install.jsonl). An interactive `npm install` needs `@acme/widgets` from project 42. The provider reads the refresh token from the keychain, refreshes the OAuth access token (the refresh replaces both tokens, so it stores the new refresh token), creates a deploy token for project 42 with `read_package_registry` and an expiry at the first 00:00 UTC after its own limit below, and answers:

```json
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-read-deploy-token"},"cache":"expires","expiresAt":1792198800,"operationIndependent":false,"granularity":"scope"}}
```

`expiresAt` is the provider's own limit, an hour from now. GitLab's expiry is a backstop: documented as 00:00 UTC on a date, so the token outlives the limit by up to a day.

The provider deletes the token itself:

- on `erase` and `logout`;
- before it mints another for the same context (a second `get` for it).

It has no timer and does nothing when the session ends, since npm need not wait for the provider to exit ([Session lifecycle](../phase-2-credential-provider.md#session-lifecycle)). The expiry is what limits a token whose deletion never ran.

The other two fields:

- `operationIndependent` is `false` because the provider holds a separate write token: with `true` the cached read token would be found for the `publish` lookup and sent without the presence prompt.
- `granularity` is `scope`: every `@acme/*` package is a cache hit. Because the registry URL already contains the project, `registry` would give the same cache key while only `@acme` points at project 42; `scope` keeps one token per scope, so that erasing the token of `@acme` leaves `@acme-tools` alone.

The second request in the file, for `@acme-tools/lint-rules`, is a new `get` and a second deploy token.

**A lapsed login on a read.** [install-login-lapsed.jsonl](gitlab/install-login-lapsed.jsonl). A refresh with the stored refresh token is not a sign-in: it asks the person nothing, and the provider does it on any `get`. When GitLab refuses the refresh token (`invalid_grant`), a `read` is answered `other`, naming `npm login`, and the provider starts no device grant and shows nothing, whatever `interactive` says ([A read never starts a login](../phase-2-credential-provider.md#non-interactive-and-ci-behavior)). Only `login`, which the person runs, starts the device grant. The provider does not answer anonymously instead: a read of a project's registry takes a credential, and what GitLab does for a public package is not something this page has read.

```json
{"Err":{"kind":"other","message":"GitLab did not accept the stored login; run npm login"}}
```

## Publish

[publish.jsonl](gitlab/publish.jsonl). `npm publish` of `@acme/widgets@2.4.1` sends `operation: "publish"` with `version`. The provider mints a deploy token with `write_package_registry`, after the user-presence prompt its policy requires for write credentials (the request is interactive). The prompt names the operation, the package and the version, and says that the token can write packages to the project. A prompt nobody answers within the provider's own 4 minutes 30 seconds, inside npm's 5 minutes, is `other` and mints nothing ([publish-unanswered.jsonl](gitlab/publish-unanswered.jsonl)):

```json
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-write-deploy-token"},"cache":"never","operationIndependent":false,"granularity":"package"}}
```

The deploy token is bound to the project, not to the package or the version: GitLab's deploy token has a scope (`write_package_registry`) and a project, and the API has no way to narrow it further. `granularity` `package` is only npm's cache key, and the prompt says that the token can write packages to the project.

The RFC's short-lived credential bound to the package and version is therefore not what this provider can make; the token's limit is GitLab's date (below), widened if GitLab documents a narrower token or a finer expiry.

`cache: "never"` keeps the write token out of npm's cache, so the next publish asks again. The provider's own record of the token lets it delete the token:

- on `logout`;
- when it is asked for a token for the same context again.

It does not delete it at the end of the session, or on a timer; the token's expiry date is the limit. `granularity` is still set, since npm keeps it with the credential for any later `erase`.

GitLab refuses a publish of a name already in the root namespace with a 400, even for a new version ([npm registry](https://docs.gitlab.com/user/packages/npm_registry/)); that is not a credential problem and no retry follows it.

**Deprecate and unpublish.** GitLab's registry page describes `npm deprecate`, which it says needs permission to delete packages, and says nothing about `unpublish`, deleting a package being a UI or API action for a Maintainer or Owner. It does not say whether a deploy token may deprecate. This provider holds no credential it knows to serve either, so it answers `deprecate` and `unpublish` with `operation-not-supported`.

[deprecate.jsonl](gitlab/deprecate.jsonl) and [unpublish.jsonl](gitlab/unpublish.jsonl) show the answers, one command to a session: a `deprecate` and an `unpublish` request, each answered `operation-not-supported`, which npm reports as unsupported without a retry, and nothing minted.

An `erase` that names one of these operations gets the same answer and deletes nothing, so it is never taken for the erase of a read token ([unsupported-erase.jsonl](gitlab/unsupported-erase.jsonl)).

[dist-tag.jsonl](gitlab/dist-tag.jsonl) is `npm dist-tag add`. The page says a job token or a deploy token runs `npm dist-tag` commands in a CI/CD job and is silent about other places, so the provider maps `dist-tag` to the write token: the same presence prompt, a deploy token with `write_package_registry`, `cache: "never"`, and no `version`, since the command names none.

**Staging.** The transcripts have no `stage`, `stage-read` or `stage-reject`: GitLab's npm registry page does not mention staged publishing or an approval step for a version, and a search of GitLab's documentation found none (an absence in the docs, not a statement that none exists). A `publish` there is live at once. Were a request with one of these operations to arrive, the provider would answer `operation-not-supported`, as it does for `deprecate`.

## Rejection

[rejection.jsonl](gitlab/rejection.jsonl) is a 401. The registry refuses the read token, perhaps because someone revoked it in the project settings. npm drops its cache entries, sends an erase with the context of the `get` and its `granularity`, then retries once:

```json
{"v":1,"kind":"erase","registry":"https://gitlab.example.com/api/v4/projects/42/packages/npm/","scope":"@acme","package":"widgets","operation":"read","granularity":"scope"}
{"v":1,"kind":"get","registry":"https://gitlab.example.com/api/v4/projects/42/packages/npm/","scope":"@acme","package":"widgets","operation":"read","command":"install","interactive":true,"retry":true,"httpStatus":401}
```

The erase deletes the deploy token the provider minted for that scope. It does not touch the refresh token: that is `logout`'s job, and a 401 may come from a URL a lockfile chose ([`erase`](../phase-2-credential-provider.md#erase-a-credential-was-rejected)). The retry mints a new deploy token.

**A deletion that fails.** A deletion GitLab does not accept (a 500) leaves the token recorded and answers the erase `other`. The retry that follows deletes it again before it mints, so a second token is never recorded over the first and lost ([rejection-delete-failed.jsonl](gitlab/rejection-delete-failed.jsonl)).

**A refresh token that no longer works.** The provider answers `other` and names `npm login`; it opens no browser on the strength of the 401 alone. [rejection-revoked.jsonl](gitlab/rejection-revoked.jsonl) is that case: someone has revoked the refresh token, and by the time of the retry the OAuth access token has lapsed too.

- The erase still succeeds, deleting the deploy token while the access token holds.
- The retry cannot refresh, so GitLab's `invalid_grant` becomes `other` with the text `run npm login`, and npm fails the command.
- Erase left the stored refresh token alone, and the provider mints nothing.

Only that OAuth error says the login is dead: a refresh that GitLab answers with a 503 is `other` too, but says to try again and names `npm login` only for a failure that keeps coming ([install-refresh-unavailable.jsonl](gitlab/install-refresh-unavailable.jsonl)).

The request in the file carries no `authChallenges`, because GitLab sends none: on GitLab 19.5.1 every 401 of the project's npm registry (no credential, a token GitLab does not know, a deleted deploy token) had a JSON body with a `message` and no `WWW-Authenticate` header ([Against a real GitLab](#against-a-real-gitlab)).

[forbidden.jsonl](gitlab/forbidden.jsonl) is a 403. GitLab's own list of causes for a 403 on install includes an expired token, a missing trailing slash, a disabled registry, and a same-name package in the scope ([npm registry](https://docs.gitlab.com/user/packages/npm_registry/)), so a 403 here can mean either permissions or an expired token. npm sends no erase after a 403, and the retry follows no erase.

The provider deletes the read token it holds for that context and answers with a fresh one, a different credential from the one refused and of the same scope; it never answers a `read` retry with a token that can write. (A 401 retry follows an erase that has already deleted it.)

The RFC asks a provider with no other credential to answer `other` "rather than the credential just refused". A new deploy token of the same scope is not that credential, but it is not likely to fare differently either: a token this provider minted cannot have passed its date while it was still being handed out, so the causes left (a token deleted in the project settings, a registry that is switched off) are ones the provider cannot see.

The retry is kept because:

- it is one call;
- it costs at most one live token per context (the old one is deleted first);
- it is the only way to tell a token removed behind the provider's back from a refusal that stands.

A second 403 is reported.

## Login and logout

[login.jsonl](gitlab/login.jsonl). `npm login --registry https://gitlab.example.com/api/v4/projects/42/packages/npm/` sends `login` with `interactive: true`. The provider starts the device authorization grant, or an authorization code flow with PKCE, prints the URL and code on the controlling terminal, polls, and keeps the refresh token in the OS keychain. It answers `{"Ok":{"kind":"login"}}`. No token is written to a file npm reads. The URL and the code come from GitLab and are shown with any control character or bidirectional override replaced by `?`.

Three cases end in `other`:

- A `token` in the request, which `npm login` sends when the person pastes one, is not stored: this provider turns an OAuth login into deploy tokens, and a pasted token is neither, so it answers `other` and says so instead of starting a browser login that ignores what was given ([login-token-refused.jsonl](gitlab/login-token-refused.jsonl)).
- The provider stops polling when the device code's life, which the server gives with it, is over, or after 4 minutes 30 seconds if that comes first (npm gives a `login` 5 minutes), and answers `other` ([login-unapproved.jsonl](gitlab/login-unapproved.jsonl)); a person who has not approved it by then has not.
- When the provider has no controlling terminal to print the code on, nobody can approve it: it answers `other` at once, naming `npm login` to be run from a terminal, instead of polling to the deadline, and stores nothing ([login-no-terminal.jsonl](gitlab/login-no-terminal.jsonl)).

[logout.jsonl](gitlab/logout.jsonl). `npm logout` sends `logout`. The provider:

1. removes the keychain entry first, so that nothing GitLab does keeps it;
2. then, with what it held, deletes any deploy tokens (`DELETE /projects/:id/deploy_tokens/:token_id`) and revokes the OAuth tokens, each on a best effort basis and within the time npm gives a `logout`;
3. answers `{"Ok":{"kind":"logout"}}` even if revocation failed, warning on stderr.

A deploy token whose deletion fails is not kept anywhere after that: with the login revoked and removed, nothing could authorize deleting it later, so it ends on GitLab's date and the warning says so.

The same holds in the other direction: a `get` that is still working when a logout lands (a refresh and a mint take time) writes back only what it changed, and only if the store still holds the same login, so a removed entry stays removed ([install-concurrent-logout.jsonl](gitlab/install-concurrent-logout.jsonl): the logout comes between the refresh and the end of the mint, and nothing is stored afterwards).

With no keychain entry and no deploy token held there is nothing to remove, and it answers `not-found` ([logout-nothing-stored.jsonl](gitlab/logout-nothing-stored.jsonl)).

## CI

In a GitLab job there is no keychain and no browser. The provider is in the job image and configured in its global npmrc; the job's `CI_JOB_TOKEN` is already in its environment.

[ci.jsonl](gitlab/ci.jsonl). `npm ci` sends `interactive: false`. The provider checks that the registry host is the job's `CI_SERVER_HOST` and that the project is the job's own `CI_PROJECT_ID`, and answers with the job token:

```json
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-job-token"},"cache":"session","operationIndependent":false,"granularity":"registry"}}
```

The check binds only where npm sends the token. Any other process of the job reads `CI_JOB_TOKEN` from the environment without the provider, so the check does not keep the token from a script; it keeps npm from sending the pipeline's token to a project, or a host, a repository chose. A static key bound to a registry path, `//gitlab.example.com/api/v4/projects/42/packages/npm/:_authToken=${CI_JOB_TOKEN}`, does the same and needs no provider. What the provider adds in a job is that one rule in one place, and, outside a job, deploy tokens that are short-lived.

The token lasts while the job runs ([job token](https://docs.gitlab.com/ci/jobs/ci_job_token/)), so `session` is enough; `operationIndependent` is `false` here too, as on every read answer of this provider, since outside CI it holds a stronger token for `publish`.

**Publish in CI.** [ci-publish.jsonl](gitlab/ci-publish.jsonl) is the same for `npm publish`: the pipeline is what authorizes the publish, so the provider asks for no presence it could not get and releases the job token, with `operationIndependent: false`. That holds when the request says `interactive: false`. `CI_JOB_TOKEN` is the environment's, set by whoever ran npm, and a write request that says a person is there is not a pipeline's: it gets the same presence prompt as any write, naming the operation and the package ([ci-publish-interactive.jsonl](gitlab/ci-publish-interactive.jsonl)). GitLab documents `_authToken=${CI_JOB_TOKEN}` for publishing from a pipeline ([npm registry](https://docs.gitlab.com/user/packages/npm_registry/)).

The rule behind this is that a write credential the job already has in its environment is released on `interactive: false`, and one it does not have is not. `CI_JOB_TOKEN` is read from the environment, so every process of the job reaches it, a dependency's lifecycle script included; a gate in front of it would add nothing, and releasing it is honest. A deploy token the provider mints from a login is not in the environment, and `interactive: false` is also that lifecycle script, so a write on it is answered `other` and says a person must confirm ([publish-not-interactive.jsonl](gitlab/publish-not-interactive.jsonl)). The presence prompt for an interactive request with the job token guards the request, not the token.

**No job token.** A job outside a CI environment has no job token and no refresh token, and the provider answers `not-found`. So does a job asked about another project's registry ([ci-other-project.jsonl](gitlab/ci-other-project.jsonl)): the job token is released only for the job's own host and project (`CI_SERVER_HOST`, `CI_PROJECT_ID`), so a dependency in another project is left to a credential behind the provider rather than sent the pipeline's token.

**Projects on the job token's allowlist are refused too.** GitLab lets a project's allowlist name another project, and the job token then reaches it ([job token](https://docs.gitlab.com/ci/jobs/ci_job_token/)). The provider does not use that: it answers `not-found` for any project but the job's own, an allowlisted one included.

The provider has no list of the projects whose allowlists name the job's project to check against, so it could not tell an allowed project from one a repository chose, and a project chosen by a repository is what the check is there to refuse. The smaller change is to say that it refuses them; a dependency in an allowlisted project is read with a credential of the user's own, through a per-registry list for that project's URL.

**A refused job token.** A job token that GitLab refuses is not handed out again: it is the only credential here, so the retry is `other` and says so.

- After a 401 the `erase` before it has nothing to delete ([ci-rejection.jsonl](gitlab/ci-rejection.jsonl)).
- A 403 on a publish sends no erase, and the retry is the same `other` ([ci-forbidden.jsonl](gitlab/ci-forbidden.jsonl)).

**A deploy token in a CI variable** needs no provider: `_authToken=${VAR}` in the user's npmrc is that credential, and a provider that finds neither a job token nor a login answers `not-found`. After a `not-found` the next entry of the chain is asked, and `credentialProvider[]=npm:token` after the provider's line serves the variable's token if it is written in the image's user or global config, the environment or the command line. That is all it serves:

`npm:token` never serves a credential from a project `.npmrc`, so a project that commits `//gitlab.example.com/api/v4/projects/42/packages/npm/:_authToken=${CI_JOB_TOKEN}` gets nothing from it, and neither does one that commits `registry=` for a host of its own with a token line beside it ([Legacy fallback](../phase-2-credential-provider.md#legacy-fallback)).

The advice therefore holds for an image that carries its own `_authToken=${VAR}` in `/etc/npmrc` or `~/.npmrc`, or sets it in the environment, and does not for a token the project's repository wrote down: that one is moved to the image's config or replaced by the provider's job-token answer, which needs no line at all. The provider reading the variable itself would only copy it, and would have to guess its name and which scopes it has.

## What breaks

- **A Developer cannot use this provider.** Creating a deploy token takes the Maintainer or Owner role, and a Developer's OAuth token is refused with a 403 ([install-not-maintainer.jsonl](gitlab/install-not-maintainer.jsonl); on GitLab 19.5.1 the probes show the same 403 from a real instance).
  - The provider answers `other` and says Maintainer or Owner is needed; it does not fall back to the OAuth token, which GitLab accepted at the registry for a Developer on 19.5.1 but which carries `api` and is not what the provider hands out.
  - What a Developer uses instead is a personal access token with `api` (the first row of the credentials table), which any user can create for themselves, stored in the user's own config or environment and served by a per-registry list that holds just `npm:token` on the project's URL, as for a group or instance endpoint above. The provider's `other` is not `not-found`, so a Developer does not leave this provider in the global chain for that registry.
- **The stored login is broader than what the provider hands out.** The refresh token the provider keeps is an OAuth login with the `api` scope, because creating a deploy token takes it, and `api` reaches every API route as the user ([api.rb](https://github.com/gitlabhq/gitlabhq/blob/449ed2875c2e3c4b51169484b799f4f803194ab5/lib/api/api.rb#L58)). The read deploy token the provider answers with reads one project's packages. A process that can read the provider's store holds the broader of the two, so the gain over a stored personal access token with `api` is that the long-lived secret sits in the keychain, not that it is narrower.
- **The job token is not released for another project.** Allowlisted projects included, as the CI section says.
- **A deploy token is never narrower than its project.** Project, not package or version, as under Publish.

## Where it is easy to go wrong

- **Sending the OAuth access token to the registry.** The OAuth 2.0 API page says OAuth tokens do not authenticate to the package registry, while the provider page lists package registry access under `api` ([OAuth 2.0 API](https://docs.gitlab.com/api/oauth2/), [OAuth provider](https://docs.gitlab.com/integration/oauth_provider/)). A provider that sends it works for some GitLab versions and fails for others, and an `api` token is far broader than a read credential. Send a deploy token.
- **Treating `expires_at` as a clock.** A deploy token's expiry is a date, so the GitLab-side lifetime is counted in days, up to a day past the limit the provider means. A provider that relies on GitLab's expiry alone hands out day-long tokens.
  - A read token gets its short life from the provider: a small `expiresAt` in the answer, and deletion of the token on `erase`, on `logout` and before the next one for the same context.
  - A write token has neither: it is `cache: "never"`, so there is no `expiresAt`, and nothing in the protocol tells the provider when npm is done with it. It lives until the provider deletes it (the next `get` for the same context, `erase`, `logout`) or until GitLab's date, up to about a day.
  - That is a limit of this example, not a choice: it ends when GitLab documents a shorter expiry or npm gives a provider a signal that a write credential has been used.
- **Leaking deploy tokens.** A token that is never deleted stays valid until its date, or forever when no expiry was set. Delete on `erase`, on `logout` and before minting a replacement, and never create one without `expires_at`. Deleting when the session ends is not available: npm sends `erase` only after a rejection and need not wait for the provider to exit, so the token's own expiry is what limits it (this reference provider has no timer of its own; one that keeps a process alive could add it).
- **Reading the project from the wrong place.** The project is in the `registry` field. A host-level `credentialProvider` key hides it, as the Configuration section says, and a provider that falls back to a default project mints a token for the wrong one.
- **Matching the wrong URL.** The registry page lists the same kinds of token for all three endpoints, and for the instance one requires a scope equal to the root group; for packages spread over projects it uses a group deploy token on the instance endpoint ([npm registry](https://docs.gitlab.com/user/packages/npm_registry/)). This provider mints project deploy tokens, which reach one project, so one that served the group and instance URLs with them would fail on dependencies in other projects. Tried on 19.5.1: a project deploy token read its own project's packages on the group and instance URLs (200), another project's token got a 404 ([Against a real GitLab](#against-a-real-gitlab)). Answer `url-not-supported`, or list only the project path in hello.
- **Releasing the job token for any project.** `CI_JOB_TOKEN` reaches only its own project by default, plus the projects whose allowlist names it ([job token](https://docs.gitlab.com/ci/jobs/ci_job_token/)), and the registry page says that installing with it a package whose dependencies are in another project gives 404 ([npm registry](https://docs.gitlab.com/user/packages/npm_registry/)). A provider that hands it to a registry for any project on the host fails on dependencies in other projects, and sends the pipeline's token to registries it never meant to serve. This provider refuses every project but the job's own, allowlisted ones included ([CI](#ci)).
- **Starting a login on a 401, or on any read.** A 401 does not prove the login is dead; check the refresh token with a refresh before saying so. And a read never starts a sign-in even when it is dead: it is `other`, naming `npm login` ([install-login-lapsed.jsonl](gitlab/install-login-lapsed.jsonl)).
- **Widening on a 403.** A 403 for an expired token or a missing trailing slash is not a request for a write token. Answer a `read` retry with a read token or fail.
- **Forgetting `forward`.** GitLab forwards a request for a package it does not hold to npmjs.com unless an administrator or group Owner disables it, and `npm audit` sends its body, including private package names, to the public registry unless run with `--registry` pointing at GitLab ([npm registry](https://docs.gitlab.com/user/packages/npm_registry/)). This is the registry's behaviour, not the provider's, and the provider cannot change it; its README should say so.

## Against a real GitLab

Everything on this page that a transcript shows is produced by the [reference provider](providers/gitlab/provider.js) against a fake of GitLab, written from the documentation and the source. A fake and a provider written from the same reading can share a mistake, so [`examples/providers/live/gitlab.js`](providers/live/gitlab.js) also runs the provider against a real GitLab CE, started as a docker container by [`gitlab-live.yml`](../.github/workflows/gitlab-live.yml). The pinned version is **GitLab CE 19.5.1** (`gitlab/gitlab-ce:19.5.1-ce.0`, revision 449ed2875c2, the latest stable tag on Docker Hub on 2026-10-22); the workflow runs on manual dispatch, with the image as an input whose default is that tag, and every night at 03:30 UTC against `gitlab/gitlab-ce:latest`.

The pinned run is a reproducible check of our code against one GitLab; the nightly run catches GitLab changing under us, and prints the version it actually got at its start and in its last line, so a failure says which GitLab changed. What the harness does and how a difference between the fake and GitLab is told is in the [providers README](providers/README.md#against-a-real-server).

24 of the 28 scenarios run on 19.5.1, with the same 62 requests no scenario reaches (the probes). Three scenarios were added after the last live run (install-login-lapsed, install-not-maintainer and publish-not-interactive); the first and the third are meant to run and have not yet, and the second is skipped, below. The login scenarios run for real: the scripted person signs in on GitLab's web pages, opens the verification link the provider shows, and presses Authorize and then Confirm. The others do not, and the run prints this list with the reasons ([skips](providers/live/gitlab-skips.json)):

- [install-refresh-unavailable](gitlab/install-refresh-unavailable.jsonl): the scenario needs the token endpoint to answer the refresh grant with a 503; a real GitLab is not made to fail on request.
- [rejection-delete-failed](gitlab/rejection-delete-failed.jsonl): it needs GitLab to answer the deletion of a deploy token with a 500 and delete nothing.
- [install-not-maintainer](gitlab/install-not-maintainer.jsonl): it needs a stored login of a Developer, and the harness signs in as the Maintainer only. The Developer's 403 is among the probes.
- [login-unapproved](gitlab/login-unapproved.jsonl): it ends a login nobody approves by the provider's own 4 minutes 30 seconds of synthetic time. GitLab judges the polls against its real interval and its device code lives 300 real seconds, so a run of it would take as long as the login does. The unapproved poll and the poll that comes too soon are in the probes.

Observed on 2026-10-22, GitLab 19.5.1, and held by the fake from then on (a difference fails the run unless [listed](providers/live/gitlab-divergences.json) with a reason, and the list is empty):

- **The device grant is a setting of the application.** An OAuth application made through the API (`POST /applications`, with `confidential: false`) answers `POST /oauth/authorize_device` with a 400 `access_denied`, whatever the request says about `device_code_enabled`; the grant works only once `device_code_enabled` is true on the application, which the harness sets from the Rails console (a person registering the application in the admin area would find it among the application's settings). An unknown client is a 401 `invalid_client`, a scope the application lacks a 400 `invalid_scope`. The answer carries `verification_uri` and `verification_uri_complete` (`/oauth/device` on the instance, the second with the user code in it) besides the code, the interval and the lifetime.
- **Approval is two pages**, both behind a signed-in session: the verification page, whose button is Authorize, and the consent page that names the access ("Access the API on your behalf"), whose button is Confirm. The first poll of the token endpoint after that gets the tokens; before it, `authorization_pending`; a poll sooner than the interval, `slow_down`; a code nobody gave, `invalid_grant`. The errors are 400s with a `WWW-Authenticate: Bearer realm="Doorkeeper", error="…"` header, a JSON body of `error` and `error_description`, and `Cache-Control: no-store`.
- **A refresh replaces both tokens**, as the page says: the old refresh token is `invalid_grant` afterwards. A revoked access token is a 401 on the API with `error="invalid_token"` and a revoked refresh token an `invalid_grant`; revoking a token GitLab does not know is a 200.
- **Creating and deleting a deploy token** (the Maintainer's OAuth token with `api`, the settled point above): the request takes `scopes` and an optional `expires_at` date, answers 201 with `id`, `name`, `username`, `expires_at`, `scopes`, `revoked`, `expired` and the `token`; a request without scopes or with an unknown scope is a 400 with an `error` body; a past date was accepted; the list gives the expiry as midnight UTC of the date sent. A deletion is a 204, and of a token already gone a 404, which the provider takes as deleted.
- **The project's npm registry**: a read deploy token and a write one both read a packument (JSON, sent as `application/octet-stream`); a write is a 403 for a read deploy token and a 200 for a write one, an OAuth token or a job token; `dist-tag` a 403 or a 204. A republish of a version the project holds, and of a name outside the root group, was accepted. A package the project lacks, or a project that is not there, is a 302 to npmjs.com (the forwarding the registry page describes); another project's deploy token is a 404; no credential and an unknown token are the same 401, as is the URL without its trailing slash.
- **The CI job token** is accepted for a read, a publish and a `dist-tag` of its own project. The harness makes one in the Rails console (a pipeline and a running job of the Maintainer), since the scenarios' CI case has no runner.

What the live run found on its first days, and fixed: the fake had no registry at all, answered the headers of none of these endpoints, took a write-only deploy token for one that cannot read, refused a past expiry that GitLab accepts, and answered the device grant with a code and no `verification_uri_complete`; the provider needed no change.

## What this registry asks of the RFC

- **A key above the project hides the project ([Registry matching](../phase-2-credential-provider.md#registry-matching)).**
  - The text says `registry` is the URL that matched, and a key for the registry's host is the form most other examples use. For GitLab that URL is too coarse to choose a credential, and the registry URL the user configured (`@acme:registry`) reaches the provider only through the global chain.
  - The RFC could say this where it describes what a provider that needs a path component must configure: a key at or below the path it needs, or the global chain with hello `registries`. The text is correct as it stands; the effect for providers is easy to miss.
  - **In the RFC:** What is sent says that a hello entry is never what is sent, and that a provider needing a path component gets it from the global chain or from a key at or below that path.
- **The end of a session does not say whether npm waits for the provider ([Session lifecycle](../phase-2-credential-provider.md#session-lifecycle)).**
  - "The client closes stdin to end the session, and the provider exits." A provider that deletes the deploy tokens it minted, or revokes a credential, does so after stdin closes, and a call to GitLab may take longer than npm waits before it exits.
  - The RFC should say whether npm waits for the child, for how long, and whether a provider may rely on cleanup at close. Without that a provider with a revocable credential relies on `erase` and a short expiry.
  - **In the RFC:** npm need not wait and sets no deadline, so a provider does not depend on work after stdin closes.
- **A 403 carries no erase and does not say which credential it refused ([`erase`](../phase-2-credential-provider.md#erase-a-credential-was-rejected)).**
  - GitLab's documentation lists an expired token among the causes of a 403 on install.
  - By the table the credential is not erased and the retry carries `httpStatus: 403` and the challenges if the registry sent any, without the `granularity` or the credential that was refused.
  - The retry still names `registry`, `scope`, `package` and `operation`, so a provider that keeps its own record of what it handed out for that context copes; the RFC does not say that it should. It would help to say so, and either state that a provider keeps its own record of what it handed out, or let the retry carry what an erase carries.
  - **In the RFC:** the RFC says the retry names the context, not the credential or the reason, and that a provider which needs the credential keeps its own record.
- **No place for a credential that must be created and deleted** ([`erase`](../phase-2-credential-provider.md#erase-a-credential-was-rejected), [Caching](../phase-2-credential-provider.md#5-caching)). With `cache: "never"` npm sends an erase only on a rejection, so nothing tells the provider that a write token it minted has been used and may be deleted. The provider must delete when it is next asked for one, on `logout`, or let the expiry end it. This is a consequence of the design, not an error in it; a short note would save provider authors from looking for a signal that does not exist. **In the RFC** by the same Session lifecycle sentence: cleanup after stdin closes is not guaranteed, so the token's expiry limits it.
