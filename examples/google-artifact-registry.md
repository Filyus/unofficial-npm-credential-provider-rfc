# Google Artifact Registry

Google Artifact Registry serves npm packages from standard, remote and virtual repositories under `https://LOCATION-npm.pkg.dev/PROJECT_ID/REPOSITORY_ID/`. It has no tokens of its own: a request carries a Google OAuth 2.0 access token, and what the token may do comes from the IAM roles of the principal behind it. The `npm-credential-provider-gar` below is hypothetical, and so are the registry names, project and tokens in the transcripts; the registry's behaviour is what Google documents, and where it is not documented the page says so. The example shows a provider that has to build narrow credentials out of IAM identities, because the registry offers none; that it must refuse the operations Artifact Registry has no equivalent for; and that a provider on a cloud platform gives little protection against a script on the same machine, which the RFC says too ([Publishing while a script runs](../phase-2-credential-provider.md#publishing-while-a-script-runs)).

## Registry and credentials

**URLs.** One host per location, with the project and repository in the path: `https://us-central1-npm.pkg.dev/acme-prod/npm-private/`. `LOCATION` is a regional or multi-regional location ([authentication](https://docs.cloud.google.com/artifact-registry/docs/nodejs/authentication)); the examples `us-central1`, `europe-west10` and the multi-regions `us`, `europe` and `asia` are recalled, not fetched, except that Google's helper source handles `europe-west10` ([helper source](https://github.com/GoogleCloudPlatform/artifact-registry-npm-tools)). A scope is routed with `@acme:registry=<that URL>`; without a scope the registry becomes the default one, which Google warns breaks a project that also installs from npmjs. Publishing works on standard repositories only; a virtual repository serves installs and a remote one proxies an upstream, so the install and publish URLs for one scope often differ ([manage packages](https://docs.cloud.google.com/artifact-registry/docs/nodejs/manage-packages), [virtual repositories](https://docs.cloud.google.com/artifact-registry/docs/repositories/virtual-repo)). The provider must match `https:` and a host of the form `<location>-npm.pkg.dev` only.

**Credentials.** All are Google access tokens sent as `Authorization: Bearer`; the documentation also shows the string `oauth2accesstoken:<token>` for username and password authentication, without naming the `Basic` scheme ([authentication](https://docs.cloud.google.com/artifact-registry/docs/nodejs/authentication)).

| Source | Lifetime | Notes |
|---|---|---|
| `gcloud auth print-access-token` (the user's gcloud login) | 60 minutes ([reference](https://docs.cloud.google.com/sdk/gcloud/reference/auth/print-access-token)) | `cloud-platform` scope, so every IAM permission the user holds in every project. The command prints the token without its expiry. |
| Application Default Credentials: `gcloud auth application-default login`, then the attached service account of a VM, GKE, Cloud Run or Cloud Build | about 1 hour | Google's own helper tries ADC first, then gcloud ([helper source](https://github.com/GoogleCloudPlatform/artifact-registry-npm-tools), [ADC](https://docs.cloud.google.com/docs/authentication/application-default-credentials)). npm needs the `cloud-platform` scope, so a VM with the default narrow access scopes gets 403 ([access control](https://docs.cloud.google.com/artifact-registry/docs/access-control)). |
| Impersonated service account: `gcloud auth print-access-token --impersonate-service-account=SA --lifetime=N` | 3600 s by default, shortenable; longer only with an organization policy ([reference](https://docs.cloud.google.com/sdk/gcloud/reference/auth/print-access-token)) | The caller needs `roles/iam.serviceAccountTokenCreator` on the account. This is the only lever for a narrower credential. |
| Workload Identity Federation (GitHub Actions, GitLab, other OIDC issuers) | about 1 hour; `access_token_lifetime` of the GitHub action defaults to 3600 s ([federation](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines), [action](https://github.com/google-github-actions/auth)) | Artifact Registry supports federation without known limitations ([supported services](https://docs.cloud.google.com/iam/docs/federated-identity-supported-services)). |
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

Per-registry, for three reasons. The token is a whole-cloud credential valid on every `*-npm.pkg.dev` host and on Google's APIs, so the provider should never start for a registry the user did not name; a provider in the global chain is asked about every registry a command touches, including npmjs.com ([Session lifecycle](../phase-2-credential-provider.md#session-lifecycle)). Installs go to the virtual repository and publishes to the standard one, so there are two keys. And a per-registry list takes the registry out of the global chain and ignores a stored token for that host, which removes the leftovers of Google's own tool, described [below](#where-it-is-easy-to-go-wrong). The repositories, the identities to use for reading and for writing, and their lifetimes live in `gar.json`, a file only the user can write; the provider reads no identity from the environment.

## Hello

```json
{"v":[1],"capabilities":["erase","login","logout","retry-context"],"registries":["https://us-central1-npm.pkg.dev/acme-prod/npm-all/","https://us-central1-npm.pkg.dev/acme-prod/npm-private/"]}
```

- `v`: protocol version 1.
- `registries`: the two repositories from its config, exactly. Entries are prefixes with no wildcard for a host such as `*-npm.pkg.dev` ([Registry matching](../phase-2-credential-provider.md#registry-matching)), so a provider that serves "all of Artifact Registry" would have to list a prefix for every location it supports, and update the list when Google adds one. Under a per-registry key the field is not needed; it is a second check, so that npm sends nothing about any other registry to this provider.
- `erase`: it drops its cached token when told a token was rejected.
- `login`, `logout`: it owns a private gcloud configuration directory (`CLOUDSDK_CONFIG`) in which `npm login` signs in, so neither touches the user's machine-wide gcloud or ADC login. A provider that only borrows ambient credentials leaves both out.
- `retry-context`: it reads `retry` and `httpStatus` on a retry. It does not list `auth-challenges`: whether Artifact Registry sends `WWW-Authenticate` on a 401 is unverified, so the provider never reads `authChallenges`.

## Install

[install.jsonl](google-artifact-registry/install.jsonl). The provider is spawned for the first request and answers its hello before it runs any gcloud command, since gcloud starts in seconds, more on Windows (`gcloud.cmd`, through `cmd.exe`). For `read` it impersonates a reader-only service account with a short `--lifetime` and takes the expiry from the library or API that issued the token, never from `now + 3600`:

```json
{"v":1,"kind":"get","registry":"https://us-central1-npm.pkg.dev/acme-prod/npm-all/","scope":"@acme","package":"web-ui","operation":"read","command":"install","interactive":false}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-reader-token"},"cache":"expires","expiresAt":1792233600,"granularity":"registry"}}
```

`granularity` is `registry` because IAM has nothing finer: a provider cannot mint a token for `@acme` and not for `@other` inside one repository. Answering `scope` or `package` would only make npm ask more often. `cache` is `expires`, never `session`, because an install can outlast the hour; npm stops using the token 60 seconds before `expiresAt` ([Caching](../phase-2-credential-provider.md#5-caching)). Every later package of the install is a cache hit.

## Publish

[publish.jsonl](google-artifact-registry/publish.jsonl). `npm publish` goes to the standard repository, a different registry from the install one. The provider releases a writer service account's token only after a presence prompt naming the package, version and repository, and only because `interactive` is `true`:

```json
{"v":1,"kind":"get","registry":"https://us-central1-npm.pkg.dev/acme-prod/npm-private/","scope":"@acme","package":"web-ui","version":"2.4.1","operation":"publish","command":"publish","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-writer-token"},"cache":"expires","expiresAt":1792233000,"granularity":"registry","operationIndependent":false}}
```

`operationIndependent` is `false`, so the writer token never answers a later `read`. `deprecate` takes the same path; the role it needs is not stated in the documentation (`packages.update`, which `writer` has, or `versions.update`, which only `repoAdmin` has), so a provider that serves it must be tested against the real registry first. A republish of the same name and version is refused by the registry, and no credential changes that.

An honest limit: on a workstation, a script run during `npm publish` can call `gcloud auth print-access-token --impersonate-service-account=...` itself, and on a VM or in Cloud Build any process can query the metadata server. The presence prompt stops none of that. The control that works is IAM: developers' everyday identity cannot impersonate the writer account, and publishing runs only in CI.

## Rejection

[rejection.jsonl](google-artifact-registry/rejection.jsonl). A token the registry refuses with 401 (expired, revoked, or the wrong principal) is erased and asked for once more:

```json
{"v":1,"kind":"erase","registry":"https://us-central1-npm.pkg.dev/acme-prod/npm-all/","scope":"@acme","package":"web-ui","operation":"read","granularity":"registry"}
{"Ok":{"kind":"erase"}}
{"v":1,"kind":"get","registry":"https://us-central1-npm.pkg.dev/acme-prod/npm-all/","scope":"@acme","package":"web-ui","operation":"read","command":"install","interactive":false,"retry":true,"httpStatus":401}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-reader-token-2"},"cache":"expires","expiresAt":1792237200,"granularity":"registry"}}
```

`erase` drops the provider's cached token and answers `Ok`. It does not call Google's revoke endpoint: revoking an access token that has a refresh token behind it also revokes the refresh grant (recalled from Google's OAuth documentation, not fetched), which would sign the user out of gcloud, kubectl and Terraform. The retry must mint a new token. gcloud can return the same cached token again, and `print-access-token` has no documented way to force a refresh, so the provider uses a library call that refreshes, or mints through the IAM Credentials API.

A 403 follows no erase. The retry is `{"v":1,"kind":"get",...,"retry":true,"httpStatus":403}`, and for `read` the provider can do nothing useful with it: it may not move to a writer account, and the usual causes (a missing role, an IAM grant not yet applied, a VPC Service Controls perimeter, a deny policy, a VM with narrow access scopes) are not fixed by another token. It answers `other` and names the principal it used, never the token:

```json
{"Err":{"kind":"other","message":"The registry refused the read for acme-reader@acme-prod.iam.gserviceaccount.com. Check its roles on the repository; a grant can take a few minutes to apply."}}
```

npm then fails the request, naming the provider ([rejection-403.jsonl](google-artifact-registry/rejection-403.jsonl)). The status codes are recalled, not verified against live responses.

## Login and logout

[login.jsonl](google-artifact-registry/login.jsonl) and [logout.jsonl](google-artifact-registry/logout.jsonl). `npm login --registry https://us-central1-npm.pkg.dev/acme-prod/npm-all/` sends `{"v":1,"kind":"login","registry":"...","interactive":true}`. The provider runs `gcloud auth login` and `gcloud auth application-default login` against its own `CLOUDSDK_CONFIG` directory, with gcloud attached to the controlling terminal (`/dev/tty`, or `CONIN$`/`CONOUT$` on Windows), never to npm's pipe, since `--no-launch-browser` reads the code from stdin. It answers `{"Ok":{"kind":"login"}}`. A supplied `token` is a one-hour access token and not worth storing, so a provider given one answers `other` with a message saying so.

`npm logout` removes only what the provider created: its own directory and its remembered identity mapping. It never runs `gcloud auth revoke` on the shared configuration and never deletes `application_default_credentials.json`. A provider that only borrows ambient ADC has nothing to remove and answers `not-found`.

## CI

[ci.jsonl](google-artifact-registry/ci.jsonl). `interactive` is `false`. The provider takes the identity Application Default Credentials resolves to: a federated identity from the CI job, or the metadata server's service account on Cloud Build. Both are machine identities, so it asks for no presence and answers `publish` at once:

```json
{"v":1,"kind":"get","registry":"https://us-central1-npm.pkg.dev/acme-prod/npm-private/","scope":"@acme","package":"web-ui","version":"2.4.1","operation":"publish","command":"publish","interactive":false}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-federated-token"},"cache":"expires","expiresAt":1792233600,"granularity":"registry","operationIndependent":false}}
```

Because that identity is chosen in the job, the safety is in the job: install and build in one job under an identity that has no `writer` role, and publish in a separate job whose federated principal carries one, with attribute conditions on repository and ref. It runs gcloud with `--quiet` and `CLOUDSDK_CORE_DISABLE_PROMPTS=1`, so a reauthentication prompt cannot hold the `get` for its 30 seconds; it reports that need as `other`, naming `gcloud auth login`.

## Where it is easy to go wrong

- **Treating the token as a registry token.** It is a whole-cloud credential: for a developer, often Owner or Editor on every project. Hand it to npm for `read` and every install-time request holds the power to delete repositories. Narrowness has to be built by impersonating a reader-only account.
- **Answering for a host the project chose.** The same bearer works on every `*-npm.pkg.dev` host and on Google's APIs. A provider answers only for the repositories it was configured with, over `https:`, and has no allow-all mode; Google's helper has one (`--allow-all-domains`), which attaches the token to any `registry=` line in a project `.npmrc` ([helper source](https://github.com/GoogleCloudPlatform/artifact-registry-npm-tools)).
- **Getting the host list wrong.** Google's own helper once matched locations with `[a-zA-Z1-9-]`, which misses `europe-west10` ([helper source](https://github.com/GoogleCloudPlatform/artifact-registry-npm-tools), `src/update.js`). Listing exact repositories avoids the pattern.
- **Inventing the expiry.** `expiresAt = now + 3600` after `gcloud auth print-access-token` overstates the lifetime when gcloud returns a token it already held (recalled). The 60-second margin does not cover that. Read the expiry from the library (`expiry_date` is in milliseconds), from the metadata or STS response, or from the IAM Credentials API.
- **Retrying with the same token.** After `erase` the next `get` must force a refresh, or npm's one retry is spent on an identical 401.
- **Revoking on `erase`, or logging out of the shared login.** See [Rejection](#rejection) and [Login and logout](#login-and-logout).
- **Moving to a bigger account on a read 403.** The RFC forbids widening `read`; and a 403 here is often not about the token at all.
- **Splitting `dist-tag` without knowing it.** `dist-tag add` needs `tags.create` (writer) and `dist-tag rm` needs `tags.delete` (`repoAdmin`, which also deletes versions), but both send `operation: "dist-tag"`. Releasing a `repoAdmin` token for every `dist-tag` request gives one to anything that sends that label. The alternative is to answer `dist-tag` with a `writer` token and move to `repoAdmin` only on a 403 retry, under the write policy ([`erase`](../phase-2-credential-provider.md#erase-a-credential-was-rejected)); then `dist-tag rm` costs one refused request. `unpublish` needs `repoAdmin` too. Do not serve either until the registry's npm endpoints are confirmed.
- **Letting the environment pick the identity.** ADC reads `GOOGLE_APPLICATION_CREDENTIALS` first; gcloud honours `CLOUDSDK_CONFIG`, `CLOUDSDK_ACTIVE_CONFIG_NAME`, `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` and others. npm strips only `npm_config_*`, `NODE_OPTIONS` and similar, so these reach the provider, and a direnv file or a nested npm in a script can change who the provider mints for, or point it at an attacker's `external_account` file. Pin the identity sources in the provider's own config; Google itself warns to validate externally sourced credential configs ([authentication](https://docs.cloud.google.com/artifact-registry/docs/nodejs/authentication)).
- **Letting gcloud inherit npm's stdin.** It either corrupts the protocol stream or hangs until a timeout. Give it the terminal for interactive flows and `--quiet` for the rest.
- **Relaying gcloud's stderr.** With `core/log_http=true` gcloud writes token exchanges to stderr. npm masks the credentials the provider returned and generic patterns, and Google refresh tokens (`1//...`) are not among them (recalled). Force `CLOUDSDK_CORE_LOG_HTTP=false`, or summarise errors yourself.
- **Answering `Basic` with a service account key.** That sends a long-lived private key to the registry on every request, and to any lockfile-chosen URL on its host. Keep the key in the provider's storage, exchange it locally for an access token and answer `bearer`.
- **Leaving Google's own tool in place.** Google's README has users run `artifactregistry-auth` from a `package.json` script of the project (the `google-artifactregistry-auth` package), which writes `_authToken` into `~/.npmrc` for every Artifact Registry `registry=` line it finds ([helper source](https://github.com/GoogleCloudPlatform/artifact-registry-npm-tools)). Remove the script and the `//LOCATION-npm.pkg.dev/...:_authToken` lines; under a per-registry list npm warns about them on every command.
- **Requiring presence in CI.** `interactive: false` with a write policy that wants presence fails every CI publish. The policy has to tell a machine identity (federated, metadata) from a user's, and not rely on `interactive` alone.
- **Putting the whole-cloud workspace file in reach.** `google-github-actions/auth` writes `gha-creds-*.json` into the checkout and exports `GOOGLE_APPLICATION_CREDENTIALS` to later steps; install scripts of the same job can read it ([action](https://github.com/google-github-actions/auth)). A provider adds nothing over it, which is why install and publish are separate jobs.

## What this registry asks of the RFC

1. **Hello `registries` has no host pattern** ([Registry matching](../phase-2-credential-provider.md#registry-matching)). The text already says what a prefix covers: a host-level entry such as `https://us-central1-npm.pkg.dev/` serves every path on that host, at a segment boundary. What is missing is any way to say "every location". A provider for a vendor with one host per location lists one prefix for each, or leaves the field out and receives every registry the command touches. This is the same point as in the [AWS CodeArtifact page](aws-codeartifact.md#what-this-registry-asks-of-the-rfc): guidance, not a protocol change.
2. **One operation, two IAM tiers** ([Operations](../phase-2-credential-provider.md#4-operations)). `dist-tag` covers `add` and `rm`, which Artifact Registry splits across `writer` and `repoAdmin`, and both send `operation: "dist-tag"`. The 403 rule already lets a provider start at `writer` and move to a credential it would release for that request on a 403, under its write policy, so no protocol change is needed. The cost is that the provider cannot tell the two apart up front; the Operations section could say so in one sentence.
3. **"Input is the protocol fields only"** ([Security model](../phase-2-credential-provider.md#6-security-model)). It is true of the protocol, but the libraries a provider uses for a Google identity read the environment and files it points to. npm removes only the variables that carry project config. The RFC could state that a provider reads the variables that choose its identity from its own config, not the process environment, as a requirement beyond the stripped list.
4. **Write-gating on ambient credentials** ([Publishing while a script runs](../phase-2-credential-provider.md#publishing-while-a-script-runs)). The RFC says a presence prompt narrows the window and, in [Scope](../phase-2-credential-provider.md#scope), that it does not protect against code running as the same user; on a cloud platform with a metadata server or an ADC file the same credentials are reachable without the provider. The text is consistent with this, so nothing needs to change in the RFC. This page names IAM topology and CI-only publishing as the control where credentials are ambient.
5. **A write policy that depends on the identity, not on `interactive`** ([Non-interactive and CI behavior](../phase-2-credential-provider.md#non-interactive-and-ci-behavior)). The text sends no field that says whether the credential is a person's or a machine's; a provider can see it from its own state. The write policy is the provider's own, and the rule "user presence, and only when `interactive` is `true`" is the example the RFC gives; a policy that exempts a machine identity is within the text, as the [GitLab](gitlab.md) and [AWS CodeArtifact](aws-codeartifact.md) pages also show.
6. **Scope and package granularity have no meaning** ([Caching](../phase-2-credential-provider.md#5-caching)). Nothing new: the text already tells a provider to answer with the granularity it can honour.
7. **Conformance tooling.** `tests/protocol_model.py` raises on any provider error answer, so an example with a 403 retry that ends in `other`, or an `operation-not-supported`, cannot be a checked transcript. Not a protocol point, but two of the exchanges above are shown inline only for that reason (checked in `validate_transcript`: any answer other than `Ok`, `url-not-supported` or `not-found` raises `ProviderFailure`). **Settled:** the model now fails that request and goes on, so these exchanges are checked transcripts.
