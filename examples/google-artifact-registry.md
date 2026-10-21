# Google Artifact Registry

Google Artifact Registry serves npm packages from standard, remote and virtual repositories under `https://LOCATION-npm.pkg.dev/PROJECT_ID/REPOSITORY_ID/`. It has no tokens of its own: a request carries a Google OAuth 2.0 access token, and what the token may do comes from the IAM roles of the principal behind it.

The `npm-credential-provider-gar` below is hypothetical, and so are the registry names, project and tokens in the transcripts. The registry's behaviour is what Google documents, and where it is not documented the page says so.

The example shows three things:

- a provider that has to build narrow credentials out of IAM identities, because the registry offers none;
- that it must refuse the operations Artifact Registry has no equivalent for;
- that a provider on a cloud platform gives little protection against a script on the same machine, which the RFC says too ([Publishing while a script runs](../phase-2-credential-provider.md#publishing-while-a-script-runs)).

## Registry and credentials

**URLs.** One host per location, with the project and repository in the path: `https://us-central1-npm.pkg.dev/acme-prod/npm-private/`.

`LOCATION` is a regional or multi-regional location ([authentication](https://docs.cloud.google.com/artifact-registry/docs/nodejs/authentication)). Google's [locations page](https://docs.cloud.google.com/artifact-registry/docs/repositories/repo-locations) (read on 2026-10-21) lists `us-central1` (Iowa) and `europe-west10` (Berlin) as regions and `us`, `europe` and `asia` as multi-regions. The host pattern of Google's helper, `[a-zA-Z0-9-]+` before `-npm.pkg.dev`, accepts `europe-west10` ([`src/config.js`](https://github.com/GoogleCloudPlatform/artifact-registry-npm-tools/blob/eae37c393241cae13a7d0ff05566abe16a624c41/src/config.js) at a commit).

Routing:

- A scope is routed with `@acme:registry=<that URL>`.
- Without a scope, the configuration Google prints makes the registry the default one, which Google says can cause problems for a project that also installs from the public npm registry ([authentication](https://docs.cloud.google.com/artifact-registry/docs/nodejs/authentication)).

Repository kinds:

- Publishing works on standard repositories only.
- A virtual repository serves installs and a remote one proxies an upstream, so the install and publish URLs for one scope often differ ([manage packages](https://docs.cloud.google.com/artifact-registry/docs/nodejs/manage-packages), [virtual repositories](https://docs.cloud.google.com/artifact-registry/docs/repositories/virtual-repo)).

The provider must match `https:` and a host of the form `<location>-npm.pkg.dev` only.

**Credentials.** All are Google access tokens. That they go out as `Authorization: Bearer` is recalled: the [authentication](https://docs.cloud.google.com/artifact-registry/docs/nodejs/authentication) page shows only the string `oauth2accesstoken:<token>` for username and password authentication, without naming the `Basic` scheme or any header.

| Source | Lifetime | Notes |
|---|---|---|
| `gcloud auth print-access-token` (the user's gcloud login) | 60 minutes ([reference](https://docs.cloud.google.com/sdk/gcloud/reference/auth/print-access-token)) | `cloud-platform` scope, so every IAM permission the user holds in every project. The command prints the token without its expiry. |
| Application Default Credentials: `gcloud auth application-default login`, then the attached service account of a VM, GKE, Cloud Run or Cloud Build | about 1 hour | Google's own helper tries ADC first, then gcloud ([helper source](https://github.com/GoogleCloudPlatform/artifact-registry-npm-tools), [ADC](https://docs.cloud.google.com/docs/authentication/application-default-credentials)). npm needs the `cloud-platform` scope, so a VM with the default narrow access scopes gets 403 ([access control](https://docs.cloud.google.com/artifact-registry/docs/access-control)). |
| Impersonated service account: `gcloud auth print-access-token --impersonate-service-account=SA --lifetime=N` | 3600 s by default, shortenable; longer only with an organization policy ([reference](https://docs.cloud.google.com/sdk/gcloud/reference/auth/print-access-token)) | The caller needs `roles/iam.serviceAccountTokenCreator` on the account. This is the only lever for a narrower credential. |
| Workload Identity Federation (GitHub Actions, GitLab, other OIDC issuers) | `access_token_lifetime` of the GitHub action defaults to 1 hour (3600 s) ([action](https://github.com/google-github-actions/auth)); the [federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines) page gives no lifetime | Artifact Registry supports federation without known limitations ([supported services](https://docs.cloud.google.com/iam/docs/federated-identity-supported-services)). |
| Service account key as a `Basic` password (`gcloud artifacts print-settings npm --json-key`) | until the key is deleted | A long-lived private key. The key flag is documented; the exact username in the generated lines is unverified. |

**Permissions** are IAM roles on a project or repository, with no package, scope or action level. `roles/artifactregistry.reader` downloads; `writer` adds upload and tag create and update; `repoAdmin` adds delete of versions and packages and tag delete ([roles](https://docs.cloud.google.com/iam/docs/roles-permissions/artifactregistry)). A role granted on a virtual repository covers every upstream the repository exposes ([access control](https://docs.cloud.google.com/artifact-registry/docs/access-control)). A name and version can be published once; a deleted version cannot be published again ([troubleshooting](https://docs.cloud.google.com/artifact-registry/docs/nodejs/troubleshoot)).

The Artifact Registry pages read for this example document no npm user, token, team, trusted-publisher or staging model (an absence in those pages, not a documented refusal), so the provider serves `read`, `publish` and (documented as working) `deprecate`, and answers `operation-not-supported` for `owner`, `access`, `trust`, `account`, `stage`, `stage-read` and `stage-reject`. Whether npm's `dist-tag` and `unpublish` endpoints exist is undocumented: Google documents tags and deletion through gcloud and the console ([manage packages](https://docs.cloud.google.com/artifact-registry/docs/nodejs/manage-packages)). This example does not map them.

## Configuration

```ini
# ~/.npmrc: one provider entry per repository, never a global chain
@acme:registry=https://us-central1-npm.pkg.dev/acme-prod/npm-all/
//us-central1-npm.pkg.dev/acme-prod/npm-all/:credentialProvider[]=npm-credential-provider-gar --config C:\Users\dev\gar.json
//us-central1-npm.pkg.dev/acme-prod/npm-private/:credentialProvider[]=npm-credential-provider-gar --config C:\Users\dev\gar.json
```

Per-registry, for three reasons:

- The token is a whole-cloud credential valid on every `*-npm.pkg.dev` host and on Google's APIs, so the provider should never start for a registry the user did not name. A provider in the global chain is asked about every registry a command touches, including npmjs.com ([Session lifecycle](../phase-2-credential-provider.md#session-lifecycle)).
- Installs go to the virtual repository and publishes to the standard one, so there are two keys.
- A per-registry list takes the registry out of the global chain and ignores a stored token for that host, which removes the leftovers of Google's own tool, described [below](#where-it-is-easy-to-go-wrong).

The repositories (`repositories`), the identities to use for reading and for writing, and their lifetimes live in `gar.json`, a file only the user can write, together with the path of the CI credentials file (`adc`). The provider reads no identity from the environment.

The environment does decide one thing, whether it is in a job: `CI` set and the file named by `adc` present together make it a machine identity, and only for a request that is not interactive (see [CI](#ci)). The file should still exist only where a job runs.

**What the reference provider simplifies.** It runs without gcloud ([provider.js](providers/google-artifact-registry/provider.js)). Where this page has the provider run `gcloud auth login` and `gcloud auth application-default login` against its own `CLOUDSDK_CONFIG`, it does this instead:

- It runs Google's device authorization flow once against the configured endpoints. This is the second sign-in of the two, the one a token is made from: the `gcloud auth login` one would be stored and never read here, so it is not taken.
- It makes a token by a refresh grant of the stored sign-in and the IAM Credentials API.
- Its messages name `npm login`, never gcloud.

Other differences:

- `logout` revokes that sign-in at Google's revoke endpoint: a `POST` to `https://oauth2.googleapis.com/revoke` with the parameter `token`, form-encoded, which takes an access token or a refresh token; success is 200 and an error is 400 with an error code ([revoking a token](https://developers.google.com/identity/protocols/oauth2/web-server), read on 2026-10-21).
- In CI it uses the federated credentials file `adc` names and no metadata server.
- It has no `repoAdmin` identity, so a 403 retry is `other` for every operation.

Of the endpoint paths and fields it uses, the revoke call and the device flow's are read in Google's documents (below and under Login); the rest are recalled, not read, as the comment in the file says.

## Hello

```json
{"v":[1],"capabilities":["erase","login","logout","retry-context"],"registries":["https://us-central1-npm.pkg.dev/acme-prod/npm-all/","https://us-central1-npm.pkg.dev/acme-prod/npm-private/"]}
```

- `v`: protocol version 1.
- `registries`: the two repositories from its config, exactly. Entries are prefixes with no wildcard for a host such as `*-npm.pkg.dev` ([Registry matching](../phase-2-credential-provider.md#registry-matching)), so a provider that serves "all of Artifact Registry" would have to list a prefix for every location it supports, and update the list when Google adds one. Under a per-registry key the field is not needed; it is a second check, so that npm sends nothing about any other registry to this provider.
- `erase`: it drops its cached token when told a token was rejected, and, like every kind, answers `url-not-supported` for a registry that is not in its configuration (no transcript shows it: the fuzz sessions take their registries from the transcripts, and one for a registry the provider does not serve would be treated as served); the RFC has that decided from `registry` alone, before the kind or the operation.
- `login`, `logout`: it owns a private gcloud configuration directory (`CLOUDSDK_CONFIG`) in which `npm login` signs in, so neither touches the user's machine-wide gcloud or ADC login. A provider that only borrows ambient credentials leaves both out.
- `retry-context`: it reads `retry` and `httpStatus` on a retry. It does not list `auth-challenges`: a request with no credentials got `Www-Authenticate: Basic realm="https://us-central1-npm.pkg.dev"` with its 401 (probe below), a challenge that names neither `otp` nor `ipaddress`, and what an expired token gets was not probed, so the provider never reads `authChallenges`.

## Install

[install.jsonl](google-artifact-registry/install.jsonl). The provider is spawned for the first request and answers its hello before it runs any gcloud command, since gcloud starts in seconds, more on Windows (`gcloud.cmd`, through `cmd.exe`). For `read` it impersonates a reader-only service account with a short `--lifetime` and takes the expiry from the library or API that issued the token, never from `now + 3600`:

```json
{"v":1,"kind":"get","registry":"https://us-central1-npm.pkg.dev/acme-prod/npm-all/","scope":"@acme","package":"web-ui","operation":"read","command":"install","interactive":false}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-reader-token"},"cache":"expires","expiresAt":1792233600,"granularity":"registry","operationIndependent":false}}
```

`granularity` is `registry` because IAM has nothing finer: a provider cannot mint a token for `@acme` and not for `@other` inside one repository. Answering `scope` or `package` would only make npm ask more often.

`cache` is `expires`, never `session`, because an install can outlast the hour. npm stops using the token 60 seconds before `expiresAt` ([Caching](../phase-2-credential-provider.md#5-caching)). Every later package of the install is a cache hit.

The answer carries `operationIndependent: false`, the default, written out. A reader token cannot publish, and with `true` the later `publish` lookup on the same repository would find a cached independent read token and send it on the `PUT`, to a 403, without the provider's write policy ever being asked ([Caching](../phase-2-credential-provider.md#5-caching)). Every `read` answer here says so, the CI ones included.

## Publish

[publish.jsonl](google-artifact-registry/publish.jsonl). `npm publish` goes to the standard repository, a different registry from the install one. The provider releases a writer service account's token only after a presence prompt naming the package, version and repository, and only because `interactive` is `true`. The name and version come from the request, so the prompt prints them with control characters replaced, as it does the address and code of a sign-in:

```json
{"v":1,"kind":"get","registry":"https://us-central1-npm.pkg.dev/acme-prod/npm-private/","scope":"@acme","package":"web-ui","version":"2.4.1","operation":"publish","command":"publish","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-writer-token"},"cache":"expires","expiresAt":1792233000,"granularity":"registry","operationIndependent":false}}
```

A person who declines, or does not answer within 4 minutes 30 seconds (npm kills an interactive `get` at 5), gets `other` and nothing is released ([publish-declined.jsonl](google-artifact-registry/publish-declined.jsonl), [publish-unanswered.jsonl](google-artifact-registry/publish-unanswered.jsonl)); the second:

```json
{"v":1,"kind":"get","registry":"https://us-central1-npm.pkg.dev/acme-prod/npm-private/","scope":"@acme","package":"web-ui","version":"2.4.1","operation":"publish","command":"publish","interactive":true}
{"Err":{"kind":"other","message":"The publish of @acme/web-ui was not confirmed within 4 minutes 30 seconds. No credential was released."}}
```

`operationIndependent` is `false`, so the writer token never answers a later `read`. `deprecate` takes the same path ([deprecate.jsonl](google-artifact-registry/deprecate.jsonl)); the role it needs is not stated in the documentation (`packages.update`, which `writer` has, or `versions.update`, which only `repoAdmin` has), so a provider that serves it must be tested against the real registry first:

```json
{"v":1,"kind":"get","registry":"https://us-central1-npm.pkg.dev/acme-prod/npm-private/","scope":"@acme","package":"web-ui","version":"2.4.0","operation":"deprecate","command":"deprecate","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-writer-token"},"cache":"expires","expiresAt":1792233000,"granularity":"registry","operationIndependent":false}}
```

That `npm deprecate` works is documented: the [manage packages](https://docs.cloud.google.com/artifact-registry/docs/nodejs/manage-packages) page recommends it and says installing a deprecated version shows a warning (read again on 2026-10-20). The writer token is the provider's start; if the registry answers 403 because the call needs `repoAdmin`, the 403 rule in [Rejection](#rejection) lets a provider move up under its write policy, at the cost of one refused request. The reference provider has no `repoAdmin` identity in its configuration and does not move: it answers `other` to every 403 retry, as under Rejection.

`dist-tag` has no transcript on purpose. The same page documents tags only through the console and `gcloud artifacts tags create`, `delete`, `list` and `update`, and names no role for them; it does not mention `npm dist-tag`, and it documents only `npm publish --tag` and installing `@scope/package@tag`. The two IAM tiers below (`tags.create` on `writer`, `tags.delete` on `repoAdmin`, from the [roles reference](https://docs.cloud.google.com/iam/docs/roles-permissions/artifactregistry) as this page already cites it) apply to those gcloud calls; that npm's `dist-tag add` and `rm` reach Artifact Registry through the npm endpoint is **not verified**, so a transcript of either would show an endpoint nothing documents.

[owner-unsupported.jsonl](google-artifact-registry/owner-unsupported.jsonl). An operation the pages describe nothing for is answered `operation-not-supported`, here `owner`. This is an absence in the pages read, not a documented refusal, and the message says so; no write-capable token was released for it:

```json
{"v":1,"kind":"get","registry":"https://us-central1-npm.pkg.dev/acme-prod/npm-private/","scope":"@acme","package":"web-ui","operation":"owner","command":"owner","interactive":true}
{"Err":{"kind":"operation-not-supported","message":"The Artifact Registry pages describe no npm owners; this provider serves none."}}
```

`access`, `trust`, `account`, `stage`, `stage-read` and `stage-reject` are answered the same way. A republish of the same name and version is refused by the registry, and no credential changes that.

An honest limit: on a workstation, a script run during `npm publish` can call `gcloud auth print-access-token --impersonate-service-account=...` itself, and on a VM or in Cloud Build any process can query the metadata server. The presence prompt stops none of that. The control that works is IAM: developers' everyday identity cannot impersonate the writer account, and publishing runs only in CI.

## Rejection

[rejection.jsonl](google-artifact-registry/rejection.jsonl). A token the registry refuses with 401 (expired, revoked, or the wrong principal) is erased and asked for once more:

```json
{"v":1,"kind":"erase","registry":"https://us-central1-npm.pkg.dev/acme-prod/npm-all/","scope":"@acme","package":"web-ui","operation":"read","granularity":"registry"}
{"Ok":{"kind":"erase"}}
{"v":1,"kind":"get","registry":"https://us-central1-npm.pkg.dev/acme-prod/npm-all/","scope":"@acme","package":"web-ui","operation":"read","command":"install","interactive":false,"retry":true,"httpStatus":401}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-reader-token-2"},"cache":"expires","expiresAt":1792234600,"granularity":"registry","operationIndependent":false}}
```

`erase` drops the provider's cached token and answers `Ok`. It does not call Google's revoke endpoint: revoking an access token that has a refresh token behind it also revokes that refresh token, as Google's OAuth documentation says ([revoking a token](https://developers.google.com/identity/protocols/oauth2/web-server), read on 2026-10-21), which would sign the user out of gcloud, kubectl and Terraform.

The retry must mint a new token, and the provider forces one even when no `erase` came first (an `erase` answered `other` does not stop the retry), so a token it still holds is not sent twice ([rejection-no-erase.jsonl](google-artifact-registry/rejection-no-erase.jsonl): the held token has 800 seconds left and is still not reused).

gcloud can return the same cached token again, and `print-access-token` has no documented way to force a refresh, so the provider uses a library call that refreshes, or mints through the IAM Credentials API.

A 403 follows no erase. The retry is `{"v":1,"kind":"get",...,"retry":true,"httpStatus":403}`, and for `read` the provider can do nothing useful with it: it may not move to a writer account, and the usual causes (a missing role, an IAM grant not yet applied, a VPC Service Controls perimeter, a deny policy, a VM with narrow access scopes) are not fixed by another token. It answers `other` and names the principal it used, never the token:

```json
{"Err":{"kind":"other","message":"The registry refused the read for acme-reader@acme-prod.iam.gserviceaccount.com. Check its roles on the repository; a grant can take a few minutes to apply."}}
```

npm then fails the request, naming the provider ([rejection-403.jsonl](google-artifact-registry/rejection-403.jsonl)). Probed anonymously on 2026-10-21 with `curl -sS -i https://us-central1-npm.pkg.dev/some-project/some-repo/somepkg`, a request with no credentials, for a project and repository that need not exist, gets status 401, `Www-Authenticate: Basic realm="https://us-central1-npm.pkg.dev"`, `Content-Type: application/json; charset=utf-8` and the body `{"error":"The request does not have valid authentication credentials."}`. That an anonymous request is answered 401 does not show what a token without the role gets, so the 403 and the other status codes are recalled, not verified against live responses.

**A 401 that no new token can fix.** [rejection-login-lapsed.jsonl](google-artifact-registry/rejection-login-lapsed.jsonl). The retry above assumes the provider can mint again. It cannot when the sign-in behind it has lapsed.

Google lets an organization set a session length of 0 s or 1 to 24 hours for the Google Cloud SDK, and when it ends gcloud asks the user to run `gcloud auth login` ([session controls](https://docs.cloud.google.com/access-context-manager/docs/session-controls-for-reauthentication), [Workspace admin help](https://knowledge.workspace.google.com/admin/security/set-session-length-for-google-cloud-services)). A service account has no such session.

What gcloud prints and which exit code it gives is not documented on the pages read, so the provider treats these as a lapsed login:

- the refusal of its own refresh grant (a 400 or a 401 from the token endpoint);
- a 401 from the IAM Credentials API ([rejection-iam-401.jsonl](google-artifact-registry/rejection-iam-401.jsonl)).

Other outcomes of a mint are not a lapse:

- A refresh answered with a 5xx or a 429 is no refusal: the provider says that it could not tell and names the status ([rejection-refresh-unavailable.jsonl](google-artifact-registry/rejection-refresh-unavailable.jsonl)).
- A 200 with no usable body is a token Google would not issue ([rejection-empty-answer.jsonl](google-artifact-registry/rejection-empty-answer.jsonl)).
- Both are `other`, with `npm login` named only where a refusal was seen.
- Any other refusal to mint (a 403 from IAM, for instance, which says the sign-in is alive but may not impersonate the account) is `other`, naming the service account and not `npm login`.

The 401 does not prove a lapse, so the provider tries the mint first. When it fails, the provider starts no sign-in (the request is not a `login`, and `interactive` is `false` here) and answers `other`, naming `npm login`. The stored login is left alone, as `erase` must:

```json
{"v":1,"kind":"erase","registry":"https://us-central1-npm.pkg.dev/acme-prod/npm-all/","scope":"@acme","package":"web-ui","operation":"read","granularity":"registry"}
{"Ok":{"kind":"erase"}}
{"v":1,"kind":"get","registry":"https://us-central1-npm.pkg.dev/acme-prod/npm-all/","scope":"@acme","package":"web-ui","operation":"read","command":"install","interactive":false,"retry":true,"httpStatus":401}
{"Err":{"kind":"other","message":"The sign-in behind this provider has lapsed and needs a new one. Run npm login for https://us-central1-npm.pkg.dev/acme-prod/npm-all/."}}
```

The request fails and the session goes on. `not-found` would be wrong here, since the provider holds a lapsed login and `not-found` would let a listed `npm:token` answer in its place.

**No `not-found` for an invisible repository.** The pages read say nothing about Artifact Registry hiding a repository from a principal who may not see it: the [troubleshooting](https://docs.cloud.google.com/artifact-registry/docs/nodejs/troubleshoot) and [access control](https://docs.cloud.google.com/artifact-registry/docs/access-control) pages document no 401, 403 or 404 for npm (read again on 2026-10-20).

Whether such a request gets a 403 or a 404 is not verified. A 404 would send no retry and no `erase`, so the provider would never hear of it, and a 403 is answered `other` as above.

A retry with nothing stored at all is `other` naming `npm login`, not `not-found` ([rejection-no-signin.jsonl](google-artifact-registry/rejection-no-signin.jsonl)). The provider's own `not-found` answers "nothing stored", and the hello `registries` list means npm never asks it about a repository it was not configured for, so this page has no `not-found` transcript.

## Login and logout

[login.jsonl](google-artifact-registry/login.jsonl) and [logout.jsonl](google-artifact-registry/logout.jsonl). `npm login --registry https://us-central1-npm.pkg.dev/acme-prod/npm-all/` sends `{"v":1,"kind":"login","registry":"...","interactive":true}`. The provider runs `gcloud auth login` and `gcloud auth application-default login` against its own `CLOUDSDK_CONFIG` directory (the reference provider runs one device flow, see [Configuration](#configuration)), with gcloud attached to the controlling terminal (`/dev/tty`, or `CONIN$`/`CONOUT$` on Windows), never to npm's pipe, since `--no-launch-browser` reads the code from stdin. It answers `{"Ok":{"kind":"login"}}`. When the sign-in is not completed ([login-refused.jsonl](google-artifact-registry/login-refused.jsonl)) it answers `other`:

```json
{"v":1,"kind":"login","registry":"https://us-central1-npm.pkg.dev/acme-prod/npm-all/","interactive":true}
{"Err":{"kind":"other","message":"The sign-in did not finish: no sign-in was completed in 4 minutes 30 seconds. Nothing was stored. Run npm login again."}}
```

What gcloud does when the user denies access or never returns is not documented ([gcloud auth login](https://docs.cloud.google.com/sdk/gcloud/reference/auth/login) says nothing on denial or timeouts). So the provider ends the flow itself, at 4.5 minutes because npm kills a `login` at 5 ([Timeouts](../phase-2-credential-provider.md#session-lifecycle)). A gcloud that exits non-zero earlier gets the same answer with its own reason (the reference provider's message says "The sign-in", since it runs no gcloud).

Google's device flow, as its page for limited-input devices has it ([OAuth 2.0 for TV and Limited-Input Device Applications](https://developers.google.com/identity/protocols/oauth2/limited-input-device), read on 2026-10-21): `POST https://oauth2.googleapis.com/device/code` with `client_id` and `scope`; the answer has `device_code`, `user_code`, `verification_url`, `expires_in` and `interval`. The field is `verification_url`, not `verification_uri` as in RFC 8628, and the reference provider reads `verification_url`.

The polling `POST https://oauth2.googleapis.com/token` takes `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code`, `client_id` and a `client_secret`, which the reference provider does not send.

The page names `access_denied` (403), `authorization_pending` (428) and `slow_down` (403) as the polling answers' `error`, and `invalid_grant` (400) for a code that is invalid or already claimed; it names no `expired_token`, which the reference provider takes from RFC 8628, so how Google answers an expired code is unverified. The page also limits the device flow to the scopes `openid`, `email`, `profile`, `drive.appdata`, `drive.file`, `youtube` and `youtube.readonly`; `cloud-platform`, which the reference provider asks for, is not among them, so its flow is a stand-in that Google's own flow would not accept, and the page's provider runs gcloud instead.

The reference provider runs the device flow itself and has an answer for each way the flow can end early:

- the person denies the sign-in ([login-denied.jsonl](google-artifact-registry/login-denied.jsonl));
- the code expires ([login-expired.jsonl](google-artifact-registry/login-expired.jsonl));
- `slow_down` adds 5 seconds to the polling interval and still ends in a login ([login-slow-down.jsonl](google-artifact-registry/login-slow-down.jsonl));
- Google approves the sign-in without a refresh token, which leaves nothing to store, since an access token lapses within the hour, and is the same `other` ([login-no-refresh-token.jsonl](google-artifact-registry/login-no-refresh-token.jsonl)).

Each ends the request with `other` and nothing stored, except `slow_down`.

A supplied `token` is a one-hour access token and not worth storing, so a provider given one answers `other` with a message saying so ([login-token.jsonl](google-artifact-registry/login-token.jsonl)).

A sign-in the person cannot be shown is not waited for. With no controlling terminal the provider cannot show the code, so it stops at the first sign-in without polling and answers `other`, naming `npm login` to run from a terminal; Google is left with a device code nobody will use, which expires on its own, and nothing is stored ([login-no-terminal.jsonl](google-artifact-registry/login-no-terminal.jsonl)).

`npm login` over a stored sign-in replaces it and revokes the replaced one, once the new one is stored: a refresh token that is no longer kept is one nobody could revoke later ([login-replaces-signin.jsonl](google-artifact-registry/login-replaces-signin.jsonl)).

`npm logout` removes only what the provider created: its own directory (in the reference provider, the `gcloud` entry of its store), removed first, and then revokes that sign-in's refresh token at Google as a best effort. The sign-in is the provider's own grant, so the revocation signs the user out of nothing else. A refused revocation is a warning on stderr and the answer is still `Ok`, the entry already gone, as the RFC asks ([logout-revocation-fails.jsonl](google-artifact-registry/logout-revocation-fails.jsonl)).

It never runs `gcloud auth revoke` on the shared configuration and never deletes `application_default_credentials.json`.

A provider that only borrows ambient ADC has nothing to remove and answers `not-found`, and so does the reference provider when nothing was ever signed in (the RFC: "`not-found` means there was nothing to remove"). Like the `not-found` of a `get` with nothing stored, it has no transcript here (see the end of [Rejection](#rejection)).

## CI

[ci.jsonl](google-artifact-registry/ci.jsonl) is the install and [ci-publish.jsonl](google-artifact-registry/ci-publish.jsonl) the publish: two commands, so two sessions. `interactive` is `false` in both.

The provider takes the identity Application Default Credentials resolves to: a federated identity from the CI job, or the metadata server's service account on Cloud Build. Both are machine identities, so it asks for no presence and answers `publish` at once, but only to a request with `interactive: false`. The variable that says it is in a job is the environment's, which a terminal can export too, and a machine identity is released with no presence. So an interactive request takes the person's sign-in and the presence prompt instead ([ci-interactive.jsonl](google-artifact-registry/ci-interactive.jsonl)).

A 403 on a federated publish is `other` naming the job's identity, not a token ([ci-403.jsonl](google-artifact-registry/ci-403.jsonl)).

The reference provider covers the first identity only: it exchanges the federated credentials file that `adc` in its configuration names, at the Security Token Service, and never calls a metadata server. In CI it does not choose a tier either: the reader and writer service accounts of the configuration are not used. The token can do what the job's identity can do, which is why the install transcript's identity holds only the reader role and the publish one's the writer role:

```json
{"v":1,"kind":"get","registry":"https://us-central1-npm.pkg.dev/acme-prod/npm-private/","scope":"@acme","package":"web-ui","version":"2.4.1","operation":"publish","command":"publish","interactive":false}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-federated-token"},"cache":"expires","expiresAt":1792233600,"granularity":"registry","operationIndependent":false}}
```

Because that identity is chosen in the job, the safety is in the job: install and build in one job under an identity that has no `writer` role, and publish in a separate job whose federated principal carries one, with attribute conditions on repository and ref. A provider that runs gcloud does so with `--quiet` and `CLOUDSDK_CORE_DISABLE_PROMPTS=1`, so a reauthentication prompt cannot hold the `get` for its 30 seconds, and reports that need as `other`, naming `gcloud auth login`; the reference provider runs no gcloud (see [Configuration](#configuration)) and names `npm login`.

## Where it is easy to go wrong

- **Treating the token as a registry token.** It is a whole-cloud credential: for a developer, often Owner or Editor on every project. Hand it to npm for `read` and every install-time request holds the power to delete repositories. Narrowness has to be built by impersonating a reader-only account.
- **Answering for a host the project chose.** The same bearer works on every `*-npm.pkg.dev` host and on Google's APIs. A provider answers only for the repositories it was configured with, over `https:`, and has no allow-all mode; Google's helper has one (`--allow-all-domains`), which attaches the token to any `registry=` line in a project `.npmrc` ([helper source](https://github.com/GoogleCloudPlatform/artifact-registry-npm-tools)).
- **Getting the host list wrong.** Google's own helper still matches locations with `[a-zA-Z1-9-]` in the paths of [`src/update.js`](https://github.com/GoogleCloudPlatform/artifact-registry-npm-tools/blob/eae37c393241cae13a7d0ff05566abe16a624c41/src/update.js) that handle the legacy password format and the deprecated single-file form, which misses `europe-west10`; its current path ([`src/config.js`](https://github.com/GoogleCloudPlatform/artifact-registry-npm-tools/blob/eae37c393241cae13a7d0ff05566abe16a624c41/src/config.js)) uses `[a-zA-Z0-9-]`. Listing exact repositories avoids the pattern.
- **Inventing the expiry.** `expiresAt = now + 3600` after `gcloud auth print-access-token` overstates the lifetime when gcloud returns a token it already held (recalled). The 60-second margin does not cover that. Read the expiry from the library (`expiry_date` is in milliseconds), from the metadata or STS response, or from the IAM Credentials API.
- **Retrying with the same token.** After `erase` the next `get` must force a refresh, or npm's one retry is spent on an identical 401.
- **Revoking on `erase`, or logging out of the shared login.** See [Rejection](#rejection) and [Login and logout](#login-and-logout).
- **Moving to a bigger account on a read 403.** The RFC forbids widening `read`; and a 403 here is often not about the token at all.
- **Splitting `dist-tag` without knowing it.** `dist-tag add` needs `tags.create` (writer) and `dist-tag rm` needs `tags.delete` (`repoAdmin`, which also deletes versions), but both send `operation: "dist-tag"`. Releasing a `repoAdmin` token for every `dist-tag` request gives one to anything that sends that label. The alternative is to answer `dist-tag` with a `writer` token and move to `repoAdmin` only on a 403 retry, under the write policy ([`erase`](../phase-2-credential-provider.md#erase-a-credential-was-rejected)); then `dist-tag rm` costs one refused request. `unpublish` needs `repoAdmin` too. Do not serve either until the registry's npm endpoints are confirmed.
- **Letting the environment pick the identity.** ADC reads `GOOGLE_APPLICATION_CREDENTIALS` first; gcloud honours `CLOUDSDK_CONFIG`, `CLOUDSDK_ACTIVE_CONFIG_NAME`, `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` and others. npm strips only `npm_config_*`, `NODE_OPTIONS` and similar, so these reach the provider, and a direnv file or a nested npm in a script can change who the provider mints for, or point it at an attacker's `external_account` file. Pin the identity sources in the provider's own config; Google itself warns to validate externally sourced credential configs ([authentication](https://docs.cloud.google.com/artifact-registry/docs/nodejs/authentication)).
- **Letting gcloud inherit npm's stdin.** It either corrupts the protocol stream or hangs until a timeout. Give it the terminal for interactive flows and `--quiet` for the rest.
- **Relaying gcloud's stderr.** With `core/log_http=true` gcloud writes token exchanges to stderr. npm masks the credentials the provider returned and generic patterns, and Google refresh tokens (`1//...`) are not among them (recalled). Force `CLOUDSDK_CORE_LOG_HTTP=false`, or summarise errors yourself.
- **Answering `Basic` with a service account key.** That sends a long-lived private key to the registry on every request, and to any lockfile-chosen URL on its host. Keep the key in the provider's storage, exchange it locally for an access token and answer `bearer`.
- **Leaving Google's own tool in place.** Google's README has users run `artifactregistry-auth` from a `package.json` script of the project (the `google-artifactregistry-auth` package), which writes `_authToken` into `~/.npmrc` for every Artifact Registry `registry=` line it finds ([`src/update.js`](https://github.com/GoogleCloudPlatform/artifact-registry-npm-tools/blob/eae37c393241cae13a7d0ff05566abe16a624c41/src/update.js)); the README documents the `--repo-config` and `--credential-config` flags ([helper README](https://github.com/GoogleCloudPlatform/artifact-registry-npm-tools)). Remove the script and the `//LOCATION-npm.pkg.dev/...:_authToken` lines; under a per-registry list npm warns about them on every command.
- **Requiring presence in CI.** `interactive: false` with a write policy that wants presence fails every CI publish. The policy has to tell a machine identity (federated, metadata) from a user's, and not rely on `interactive` alone.
- **Putting the whole-cloud workspace file in reach.** `google-github-actions/auth` writes `gha-creds-*.json` into the checkout and exports `GOOGLE_APPLICATION_CREDENTIALS` to later steps; install scripts of the same job can read it ([action](https://github.com/google-github-actions/auth)). A provider adds nothing over it, which is why install and publish are separate jobs.

## What this registry asks of the RFC

1. **Hello `registries` has no host pattern** ([Registry matching](../phase-2-credential-provider.md#registry-matching)). The text already says what a prefix covers: a host-level entry such as `https://us-central1-npm.pkg.dev/` serves every path on that host, at a segment boundary. What is missing is any way to say "every location". A provider for a vendor with one host per location lists one prefix for each, or leaves the field out and receives every registry the command touches. This is the same point as in the [AWS CodeArtifact page](aws-codeartifact.md#what-this-registry-asks-of-the-rfc): guidance, not a protocol change. **In the RFC:** Version negotiation gives the per-registry form, or no `registries`, for hosts that follow a pattern.
2. **One operation, two IAM tiers** ([Operations](../phase-2-credential-provider.md#4-operations)). `dist-tag` covers `add` and `rm`, which Artifact Registry splits across `writer` and `repoAdmin`, and both send `operation: "dist-tag"`. The 403 rule already lets a provider start at `writer` and move to a credential it would release for that request on a 403, under its write policy, so no protocol change is needed. The cost is that the provider cannot tell the two apart up front; the Operations section could say so in one sentence. **In the RFC:** Operations says one operation can span two tiers and a provider may start low and move up on a 403 under its policy.
3. **"Input is the protocol fields only"** ([Security model](../phase-2-credential-provider.md#6-security-model)). It is true of the protocol, but the libraries a provider uses for a Google identity read the environment and files it points to. npm removes only the variables that carry project config. The RFC could state that a provider reads the variables that choose its identity from its own config, not the process environment, as a requirement beyond the stripped list. **In the RFC:** the Input bullet separates the request from the provider's environment.
4. **Write-gating on ambient credentials** ([Publishing while a script runs](../phase-2-credential-provider.md#publishing-while-a-script-runs)). The RFC says a presence prompt narrows the window and, in [Scope](../phase-2-credential-provider.md#scope), that it does not protect against code running as the same user; on a cloud platform with a metadata server or an ADC file the same credentials are reachable without the provider. The text is consistent with this, so nothing needs to change in the RFC. This page names IAM topology and CI-only publishing as the control where credentials are ambient. **Not in the RFC:** Scope, the list of what Phase 2 does not guarantee, and the last threat row already disclaim code running as the user; IAM advice belongs on this page.
5. **A write policy that depends on the identity, not on `interactive`** ([Non-interactive and CI behavior](../phase-2-credential-provider.md#non-interactive-and-ci-behavior)). The text sends no field that says whether the credential is a person's or a machine's; a provider can see it from its own state. The write policy is the provider's own, and the rule "user presence, and only when `interactive` is `true`" is the example the RFC gives; a policy that exempts a machine identity is within the text, as the [GitLab](gitlab.md) and [AWS CodeArtifact](aws-codeartifact.md) pages also show. **Not in the RFC:** the write policy is the provider's, and npm could not verify a field saying whether a person is behind the credential.
6. **Scope and package granularity have no meaning** ([Caching](../phase-2-credential-provider.md#5-caching)). Nothing new: the text already tells a provider to answer with the granularity it can honour.
