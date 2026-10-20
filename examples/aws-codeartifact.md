# AWS CodeArtifact

A hypothetical `npm-credential-provider-codeartifact` for [AWS CodeArtifact](https://docs.aws.amazon.com/codeartifact/latest/ug/npm-auth.html). Nothing in this page is shipped by AWS: the provider, its name, its arguments and its behaviour are invented, and follow the [Phase 2 protocol](../phase-2-credential-provider.md). What the registry does (URLs, tokens, lifetimes, permissions) is AWS's documented behaviour, cited below. The example shows a registry whose npm token is a short-lived bearer token minted from AWS credentials, so the provider holds no standing secret; a token that covers a whole domain while npm caches by registry URL; write permissions that are separate IAM actions on a package; and a registry that supports only part of the npm API, so that the provider answers `operation-not-supported` for the rest. The transcripts use fake URLs and tokens.

## Registry and credentials

**URL shapes the provider must match.** All are `https:`, and npm needs the trailing `/`:

| Form | Shape | Source |
|---|---|---|
| Standard | `https://{domain}-{owner}.d.codeartifact.{region}.amazonaws.com/npm/{repository}/` | [npm-auth](https://docs.aws.amazon.com/codeartifact/latest/ug/npm-auth.html), [GetRepositoryEndpoint](https://docs.aws.amazon.com/codeartifact/latest/APIReference/API_GetRepositoryEndpoint.html) |
| Dual-stack | the same under `codeartifact.{region}.on.aws`; the full host name is recalled, not verified | [npm-auth](https://docs.aws.amazon.com/codeartifact/latest/ug/npm-auth.html) |
| VPC endpoint without private DNS | `https://vpce-{id}-{suffix}.d.codeartifact.{region}.vpce.amazonaws.com/npm/d/{domain}-{owner}/{repository}/`: domain and owner move into the path | [use from a VPC](https://docs.aws.amazon.com/codeartifact/latest/ug/use-codeartifact-from-vpc.html) |
| VPC endpoint with private DNS | the standard form | [VPC endpoints](https://docs.aws.amazon.com/codeartifact/latest/ug/create-vpc-endpoints.html) |

The domain may contain hyphens and the owner is a 12-digit account id, so the host splits at the last hyphen. The repository name allows capital letters, which npm compares byte for byte ([GetRepositoryEndpoint](https://docs.aws.amazon.com/codeartifact/latest/APIReference/API_GetRepositoryEndpoint.html)). Other AWS partitions change the host suffix (recalled, not verified). The AWS API host (`codeartifact.{region}.amazonaws.com`) is used by the provider, never by npm.

**The registry credential** is a CodeArtifact authorization token, sent as `Authorization: Bearer`. `aws codeartifact login --tool npm` writes it as `_authToken` ([login.py](https://raw.githubusercontent.com/aws/aws-cli/v2/awscli/customizations/codeartifact/login.py)).

- **How it is obtained.** `GetAuthorizationToken(domain, domainOwner, durationSeconds)` with AWS credentials from the SDK default chain or a named profile; the response has `authorizationToken` and `expiration`. The caller needs `codeartifact:GetAuthorizationToken` and `sts:GetServiceBearerToken`; root users cannot call it ([tokens-authentication](https://docs.aws.amazon.com/codeartifact/latest/ug/tokens-authentication.html), [API](https://docs.aws.amazon.com/codeartifact/latest/APIReference/API_GetAuthorizationToken.html)).
- **Lifetime.** 12 hours by default; `durationSeconds` is 0 or 900 to 43200. With 0 the token expires with the caller's assumed-role session; otherwise it outlives the role session. Tokens cannot be revoked; the remedy is an IAM deny on the principal ([tokens-authentication](https://docs.aws.amazon.com/codeartifact/latest/ug/tokens-authentication.html)).
- **Scope.** The token is domain-wide: every repository of the domain, in one region. It carries the identity that minted it, with its session tags and session policies, and each request is authorized when it is made, against the identity's policies and the domain and repository policies ([tokens-authentication](https://docs.aws.amazon.com/codeartifact/latest/ug/tokens-authentication.html), [bearer tokens](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_bearer.html)).
- **Permissions.** Reading needs `codeartifact:ReadFromRepository`, which applies to a repository only: a principal reads all packages of a repository or none ([repo-policies](https://docs.aws.amazon.com/codeartifact/latest/ug/repo-policies.html)). `npm publish` needs `PublishPackageVersion` on the package ARN, and `npm dist-tag add` and `rm` need `PutPackageMetadata` ([permissions reference](https://docs.aws.amazon.com/codeartifact/latest/ug/auth-and-access-control-permissions-reference.html)). The `@scope` becomes the ARN namespace without the `@`, and an unscoped package has an empty namespace ([repo-policies](https://docs.aws.amazon.com/codeartifact/latest/ug/repo-policies.html)).
- **Underlying AWS credentials** (IAM Identity Center role credentials, an assumed role, a CI role) never go to the registry. `aws sso login` starts a browser or device-code login, and `aws sso logout` signs out of all SSO profiles ([CLI SSO](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sso.html)).

**Unsupported npm commands.** CodeArtifact lists `access`, `owner`, `team`, `token`, `profile`, `whoami`, `login`, `logout` and `unpublish` as unsupported; it supports `dist-tag` and `deprecate` ([npm-commands](https://docs.aws.amazon.com/codeartifact/latest/ug/npm-commands.html), [npm-tags](https://docs.aws.amazon.com/codeartifact/latest/ug/npm-tags.html)). Its list has no `trust` and no `/-/stage` endpoints; that reading is an inference from the list, not stated by AWS. Deleting a version is `aws codeartifact delete-package-version`. Which IAM action `deprecate` needs is not documented, so this provider maps it to the write identity.

## Configuration

One per-registry key per repository, in `~/.npmrc` or the global npmrc:

```ini
//my-domain-111122223333.d.codeartifact.us-west-2.amazonaws.com/npm/my-repo/:credentialProvider[]=npm-credential-provider-codeartifact --profile dev --allow-owner 111122223333
//my-domain-111122223333.d.codeartifact.us-west-2.amazonaws.com/npm/tools/:credentialProvider[]=npm-credential-provider-codeartifact --profile dev --allow-owner 111122223333
@acme:registry=https://my-domain-111122223333.d.codeartifact.us-west-2.amazonaws.com/npm/my-repo/
```

Why per registry and not a global chain:

- The provider mints tokens for AWS accounts. A project can choose a registry URL on a CodeArtifact host of another account, and a global provider would then call `GetAuthorizationToken` against that account's domain with the user's identity. The per-registry form keeps it away from hosts the user did not name ([Threat model](../phase-2-credential-provider.md#threat-model)). A global chain is possible only if the provider checks `--allow-owner` itself.
- The key goes down to the repository. A host-level key would send `registry` as `https://host/`, and the provider could not learn the repository, which it needs for a package ARN in a publish session policy. For the VPC endpoint form a host-level key would also hide the domain and owner, so the key must reach at least `/npm/d/{domain}-{owner}/`.
- The profile and the allowed owner are arguments, so they come from trusted config. The provider ignores `AWS_PROFILE`, `AWS_CONFIG_FILE` and similar variables (see [Where it is easy to go wrong](#where-it-is-easy-to-go-wrong)).

A key and a hello entry exist for each URL form the user uses: a lockfile written on a laptop (standard host) and installed in a VPC without private DNS (VPC endpoint host) names a host no key covers.

## Hello

```json
{"v":[1],"capabilities":["login","logout","erase"],"registries":["https://my-domain-111122223333.d.codeartifact.us-west-2.amazonaws.com/npm/my-repo/","https://my-domain-111122223333.d.codeartifact.us-west-2.amazonaws.com/npm/tools/"]}
```

- `v`: version 1 only.
- `capabilities`: `login` and `logout` because the provider implements them (login is `aws sso login`); `erase` because it keeps a token to drop. It does not list `auth-challenges`: CodeArtifact's `WWW-Authenticate` header, if any, is not documented, so the provider never reads `authChallenges`.
- `registries`: the endpoints named in the provider's own arguments, so npm sends nothing about any other registry ([Version negotiation](../phase-2-credential-provider.md#version-negotiation)). Entries are prefixes, not patterns, so a provider cannot list "any CodeArtifact host".
- The provider sends hello before it starts the AWS CLI or SDK. Python-based AWS tooling is slow to start (about a second, recalled, not measured here), and hello has a 10-second budget ([Timeouts](../phase-2-credential-provider.md#session-lifecycle)).

## Install

[install.jsonl](aws-codeartifact/install.jsonl). `npm install @acme/ui` spawns the provider on the first request to `my-repo`.

```json
{"v":1,"kind":"get","registry":"https://my-domain-111122223333.d.codeartifact.us-west-2.amazonaws.com/npm/my-repo/","scope":"@acme","package":"ui","operation":"read","command":"install","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-read-token"},"cache":"expires","expiresAt":1760000900,"operationIndependent":true,"granularity":"registry"}}
```

The provider parses domain, owner and region from the host, checks the owner against `--allow-owner`, and calls `GetAuthorizationToken` with `durationSeconds` 900. It answers `granularity: "registry"`, the only honest value for a read: `ReadFromRepository` cannot be narrowed below a repository, so `scope` or `package` would only cause more `get`s. `expiresAt` is the API's `expiration` converted to integer Unix seconds.

The token is valid for the whole domain, but npm's cache is keyed by registry URL, so the first package from `tools` is a second `get`. The provider answers it from its own per-domain token, and the same string comes back. A tarball download is redirected by CodeArtifact to S3 ([npm-auth](https://docs.aws.amazon.com/codeartifact/latest/ug/npm-auth.html)); npm sends no credential to another host.

## Publish

[publish.jsonl](aws-codeartifact/publish.jsonl). This provider has a second identity for writes: a publish role whose trust policy requires MFA. The everyday role has no `PublishPackageVersion`, so the user's presence means something. (A provider with one identity would return a token of the read kind, and say `operationIndependent: true`.)

```json
{"v":1,"kind":"get","registry":"https://my-domain-111122223333.d.codeartifact.us-west-2.amazonaws.com/npm/my-repo/","scope":"@acme","package":"ui","version":"2.4.1","operation":"publish","command":"publish","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-publish-token"},"cache":"expires","expiresAt":1760000900,"operationIndependent":false,"granularity":"package"}}
```

The provider asks for presence on the controlling terminal, naming `@acme/ui` and 2.4.1, reads the MFA code there, and assumes the publish role with a session policy limited to `PublishPackageVersion` on `arn:aws:codeartifact:us-west-2:111122223333:package/my-domain/my-repo/npm/acme/ui` (scope without `@`; an unscoped package ends `npm//name`). It then mints with `durationSeconds` 0, so the token ends with the session. That a token minted this way is in practice limited to that package follows from [bearer tokens](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_bearer.html) but is untested. With `interactive: false` it answers `other` ("publish needs user presence"), unless its trusted config says the ambient identity is a CI publisher ([CI](#ci)).

`dist-tag add` and `rm` need `PutPackageMetadata`, so the provider maps `dist-tag` to the same write identity and answers with its own package-bound token ([dist-tag.jsonl](aws-codeartifact/dist-tag.jsonl): `npm dist-tag` is a command of its own, so a session of its own). `deprecate` maps likewise.

Operations CodeArtifact does not serve get a clear refusal, not the read token:

```json
{"Err":{"kind":"operation-not-supported"}}
```

for `unpublish`, `owner`, `access`, `account`, `trust`, `stage`, `stage-read` and `stage-reject`. `npm stage approve` and `reject` then stop at the `stage-read` lookup ([Staged versions](../phase-2-credential-provider.md#4-operations)). The refusal is [unsupported-operation.jsonl](aws-codeartifact/unsupported-operation.jsonl).

## Rejection

[rejection.jsonl](aws-codeartifact/rejection.jsonl). A 401 on a read means the token is expired or invalid; third-party guides report it as E401, and AWS's npm page does not state the status.

```json
{"v":1,"kind":"erase","registry":"https://my-domain-111122223333.d.codeartifact.us-west-2.amazonaws.com/npm/my-repo/","scope":"@acme","package":"ui","operation":"read","granularity":"registry"}
{"Ok":{"kind":"erase"}}
{"v":1,"kind":"get","registry":"https://my-domain-111122223333.d.codeartifact.us-west-2.amazonaws.com/npm/my-repo/","scope":"@acme","package":"ui","operation":"read","command":"install","interactive":false,"retry":true,"httpStatus":401}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-read-token-2"},"cache":"expires","expiresAt":1760001000,"operationIndependent":true,"granularity":"registry"}}
```

The erase carries no `authChallenges`, since CodeArtifact's header is not documented. The provider drops its cached domain token, never `~/.aws/sso/cache`, and cannot revoke on the server, since tokens have no revocation. The retry mints again. If the AWS session itself has expired and `interactive` is `false`, the retry answers `other` ("run aws sso login"); with `interactive: true` it starts an SSO login only after a check of its own (`sts:GetCallerIdentity` fails), not because of the 401.

A 403 is different. An authenticated identity that lacks the permission presumably gets 403 (unverified in AWS's documents), and the token is an identity snapshot, so a re-minted token from the same identity is refused the same way. npm sends no erase and one retry with `httpStatus: 403`. A provider with only one identity answers it `other` and does not call `GetAuthorizationToken` again ([publish-forbidden.jsonl](aws-codeartifact/publish-forbidden.jsonl)):

```json
{"Err":{"kind":"other","message":"The publish identity is denied PublishPackageVersion for this package. A new token would be refused the same way.","causedBy":["registry answered 403"]}}
```

Only a provider configured with a second, more privileged identity for that operation answers `Ok`, and then under its write policy and never for `read` ([erase](../phase-2-credential-provider.md#erase-a-credential-was-rejected)). Publishing a version that exists in an upstream or the external connection returns 409, and a publish blocked by package origin controls is rejected with an undocumented status ([origin controls](https://docs.aws.amazon.com/codeartifact/latest/ug/package-origin-controls.html)); neither is a reason to mint again.

## Login and logout

[login.jsonl](aws-codeartifact/login.jsonl).

```json
{"v":1,"kind":"login","registry":"https://my-domain-111122223333.d.codeartifact.us-west-2.amazonaws.com/npm/my-repo/","interactive":true}
{"Ok":{"kind":"login"}}
{"v":1,"kind":"logout","registry":"https://my-domain-111122223333.d.codeartifact.us-west-2.amazonaws.com/npm/my-repo/"}
{"Ok":{"kind":"logout"}}
```

`login` runs `aws sso login --profile dev` with the child's output on the controlling terminal, never on protocol stdout (it prints the authorization URL and code). For a profile with static, instance or environment credentials it answers `operation-not-supported`. It refuses a supplied `token` with `other`: a CodeArtifact token lasts at most 12 hours, and storing it recreates the standing secret. It never does what `aws codeartifact login --tool npm` does, which writes `registry=` and `_authToken` into `~/.npmrc` ([login.py](https://raw.githubusercontent.com/aws/aws-cli/v2/awscli/customizations/codeartifact/login.py)), which the RFC forbids a provider to do.

`logout` drops the provider's own cached tokens and answers `Ok`, warning on stderr that issued tokens stay valid until they expire. It never calls `aws sso logout`: that signs the user out of every SSO profile. A stale `_authToken` that an earlier `aws codeartifact login` left in `~/.npmrc` under the same key makes npm warn on every command, and the user removes it.

## CI

[ci.jsonl](aws-codeartifact/ci.jsonl). In CI the ambient role (a CodeBuild service role, GitHub OIDC through `AssumeRoleWithWebIdentity`, an instance profile) is the credential, and the SDK chain finds it inside the provider. `interactive` is `false`, and `get` for `read` works.

```json
{"v":1,"kind":"get","registry":"https://my-domain-111122223333.d.codeartifact.us-west-2.amazonaws.com/npm/my-repo/","scope":"@acme","package":"ui","operation":"read","command":"ci","interactive":false}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-ci-token"},"cache":"expires","expiresAt":1760000900,"operationIndependent":true,"granularity":"registry"}}
```

For `publish` the example provider's trusted config (an argument such as `--ci-publisher`) says that the ambient role is a publisher, so it answers without presence, still bound to the package and the operation, as [ci-publish.jsonl](aws-codeartifact/ci-publish.jsonl) shows (an `npm publish` is a command, and so a session, of its own). Without that argument it answers `other`. No AWS credentials at all is `not-found`. npm's own OIDC exchange does not apply to CodeArtifact (recalled: it has no such endpoint); if npm tries it, it fails and leaves the chain in charge.

## Where it is easy to go wrong

- **Treating a 403 as a bad token.** The token carries the identity that minted it, and each request is authorized at request time, so re-minting from the same identity gets the same refusal and spends a `GetAuthorizationToken` call. A 409 or an origin-control rejection is not a credential problem either.
- **Answering `read` with `scope` or `package` granularity** to look fine-grained. `ReadFromRepository` takes a repository, so the answer is `registry`; finer values cost more `get`s and give nothing. Only writes take package ARNs.
- **Expecting one erase to clear everything.** One token serves every repository of the domain, while npm caches per registry URL. An erase for `my-repo` drops the provider's domain token, but npm's cache entry for `tools` holds the same string until it gets its own 401. This is harmless; the provider's own cache must not outlive the erase.
- **A host-level key.** It strips the repository from `registry` (and the domain and owner, in the VPC endpoint form), so a package ARN cannot be built, or nothing can be minted.
- **Default 12-hour tokens, and the false belief that logout revokes them.** By default a token minted from a 15-minute role session lives 12 hours and survives `aws sso logout`, provider logout and erase. Mint with 900 seconds, or 0 under an assumed role. Whether 0 is accepted for long-term IAM user keys is not documented.
- **`expiresAt` in the wrong unit.** The API gives a timestamp and the AWS CLI prints a date string (recalled); the protocol wants integer Unix seconds.
- **Calling `aws sso logout` from `logout`**, or copying `aws codeartifact login` into `login` (see above).
- **Letting the AWS CLI write to protocol stdout.** `aws sso login` prints the URL and code, and its errors and prompts can land on stdout. Capture stdout for `get-authorization-token --output json`, and send login output to the controlling terminal (`/dev/tty`, or `CONIN$`/`CONOUT$`). Send hello first.
- **Trusting the AWS environment.** npm strips `npm_config_*` and `NODE_OPTIONS`, but the provider still inherits `AWS_PROFILE`, `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE` and `AWS_ACCESS_KEY_ID`. A script or `.env` tool can pick the identity (`AWS_PROFILE=prod npm publish`), and an `AWS_CONFIG_FILE` inside the repository can add a `credential_process` that the SDK runs. Take the profile and region from arguments, and ignore these variables, or at least never follow an `AWS_CONFIG_FILE` in a project.
- **A loose host regex in a global chain.** Split at the last hyphen before the 12-digit owner, anchor the regex to the whole host (`...amazonaws.com.evil.example` must not match), and allowlist owners. A project-chosen URL on another account's genuine host would otherwise make the provider call that account's `GetAuthorizationToken`, which can show in that account's CloudTrail, and if its policy grants access, the user's identity is used there.
- **One identity for everything.** With a single role the write gate is no gate: any install script can run `aws codeartifact get-authorization-token` with the same ambient credentials ([Publishing while a script runs](../phase-2-credential-provider.md#publishing-while-a-script-runs)).
- **Building ARNs from the protocol fields.** Strip the `@` from `scope`, handle the empty namespace for an unscoped package, and keep the case: ARNs match exactly and case-sensitively.
- **Answering `read` for the commands CodeArtifact does not support.** `unpublish`, `owner`, `access`, `account`, `trust` and the stage operations get `operation-not-supported`. If AWS adds an endpoint, the provider must be updated; npm will not fall through.
- **Throttling.** Every npm process, child npm processes from lifecycle scripts included, starts its own provider and mints its own token. `GetAuthorizationToken` can answer 429 with `retryAfterSeconds`; wait inside the 30-second `get` budget. A cross-process token cache would be a stored bearer secret the provider must then clear.

## What this registry asks of the RFC

- **The request carries no path below the key** ([Registry matching](../phase-2-credential-provider.md#registry-matching)). `registry` is the matched key's URL, so a provider keyed at the host never learns the repository, which a package-ARN session policy needs, and in the VPC endpoint form never learns the domain or owner. The RFC's cure is a more specific key, which works here, but the text does not tell provider authors to document the key depth they need. **Settled:** What is sent now says a provider needing a path component gets it from the global chain or from a key at or below that path.
- **Vendor environment variables that choose an identity or run a program** ([Spawning](../phase-2-credential-provider.md#1-configuration), [Threat model](../phase-2-credential-provider.md#threat-model)). npm removes its own config variables only. `AWS_PROFILE`, `AWS_CONFIG_FILE` and the like let a project script or a repository file pick the identity the provider mints for, or run `credential_process`. The RFC says nothing about this class; the cure is in the provider, but the threat model has no row for it. **Settled:** the Input bullet now says npm strips only the variables carrying a project's config, so a provider that needs presence takes the settings choosing its identity, or naming a program it runs, from its own configuration.
- **A login that exists but has lapsed** ([Non-interactive and CI behavior](../phase-2-credential-provider.md#non-interactive-and-ci-behavior)). The text names two cases: nothing stored (`not-found`) and a credential withheld for lack of presence (`other`). An expired SSO session with `interactive: false` fits neither. `not-found` would let a listed `npm:token`, or the legacy fallback, serve the stale `_authToken` that `aws codeartifact login` left behind, so the example answers `other`. The text could say it. **Settled:** a login that has lapsed and can be renewed only by a forbidden flow is answered `other`.
- **A credential wider than the cache key** ([Caching](../phase-2-credential-provider.md#5-caching), [erase](../phase-2-credential-provider.md#erase-a-credential-was-rejected)). The token is domain-wide, and the `registry` granularity is one URL. The extra `get` per repository and an erase that clears only one URL's cache entry work, but the RFC does not say that a provider may answer several URLs with one credential, or that an erase for one leaves the others in npm's cache. **Settled:** erase now evicts by value, whatever registry URL the credential was cached under.
- **Global chain with hello `registries`** ([Version negotiation](../phase-2-credential-provider.md#version-negotiation)). Entries are prefixes, so a provider for "any CodeArtifact host" cannot list its registries and must parse `registry` itself. The per-registry form is the advice here; the text could say that a provider whose hosts are a pattern belongs there. **Settled:** Version negotiation now says a provider whose hosts follow a pattern goes in the per-registry form or leaves `registries` out.
- **`logout` and `login` for a registry with no revocation and no long-lived credential** ([login](../phase-2-credential-provider.md#login-authenticate-with-a-registry), [logout](../phase-2-credential-provider.md#logout-remove-stored-credentials)). `logout` has nothing to revoke, and `login` has no static token to store; both fit the existing text (`Ok` with a warning, `operation-not-supported` or `other`), so nothing new, only an example. **Not adopted:** the login and logout text already allows `operation-not-supported`, `Ok` with a warning, and `not-found`.
- **Test material.** The transcript model raises on any terminal error (`other`, `operation-not-supported`), so a transcript cannot show a refused operation or a 403 that ends in `other`; this page shows them inline. **Settled:** the model now fails that request and goes on, so these exchanges are checked transcripts.
