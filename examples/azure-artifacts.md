# Azure Artifacts

A hypothetical `npm-credential-provider-azure-artifacts` for the npm feeds of Azure Artifacts in Azure DevOps Services. Nothing here exists: the provider and its behaviour follow the [Phase 2 protocol](../phase-2-credential-provider.md); what the registry does (URLs, tokens, scopes, errors) is Microsoft's documented behaviour, with the source beside each fact. A fact the research could only recall, not verify, says so. The example shows a credential that is organization-wide and a key that sits at the organization prefix to match, a read that needs a write-capable token, a 403 that is a version conflict, and a token source (`az`) that answers the retry with the rejected token.

Every exchange below has a transcript in [azure-artifacts/](azure-artifacts/), checked by `tests/test_examples.py` against the executable model. The error answers (a refused operation, a 403 on publish, a retry after a 401 with an Entra token) are transcripts too: the model fails that request and goes on. All tokens, organizations and URLs are fake.

## Registry and credentials

**URLs the provider must match.** One feed has several URL shapes:

| Shape | Source |
|---|---|
| `https://pkgs.dev.azure.com/ORG/PROJECT/_packaging/FEED/npm/registry/` (project-scoped feed) | [npmrc](https://learn.microsoft.com/en-us/azure/devops/artifacts/npm/npmrc?view=azure-devops) |
| `https://pkgs.dev.azure.com/ORG/_packaging/FEED/npm/registry/` (organization-scoped feed: no project, the segment after `ORG` is `_packaging`) | [npmrc](https://learn.microsoft.com/en-us/azure/devops/artifacts/npm/npmrc?view=azure-devops), [upstream sources](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-sources?view=azure-devops) |
| The same two without the trailing `registry/` (`.../_packaging/FEED/npm/`): Microsoft's snippet writes the credentials under both keys | [npmrc](https://learn.microsoft.com/en-us/azure/devops/artifacts/npm/npmrc?view=azure-devops) |
| `https://ORG.pkgs.visualstudio.com/[PROJECT/]_packaging/FEED/npm/registry/` (legacy host) | `.pkgs.visualstudio.com` is in the feed-host allowlist of artifacts-credprovider ([VstsEndpointPolicy.cs](https://github.com/microsoft/artifacts-credprovider/blob/fd03bdfa0d44facee74b938ed74512f468b048b0/CredentialProvider.Microsoft/CredentialProviders/Vsts/VstsEndpointPolicy.cs)) |
| `.../_packaging/FEED@VIEW/npm/registry/` (a view such as `@Release`, read-only) | recalled, not verified; views are read-only and only `@Local` takes publishes: [views](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/views?view=azure-devops) |
| Feed or project GUIDs in place of names, for example in tarball URLs | recalled, not verified |
| `http(s)://SERVER/COLLECTION[/PROJECT]/_packaging/FEED/npm/registry/` (Azure DevOps Server) | [npmrc](https://learn.microsoft.com/en-us/azure/devops/artifacts/npm/npmrc?view=azure-devops) |

What varies is the host, `ORG` (a path segment or a subdomain), an optional project, the feed, and the `/npm/` or `/npm/registry/` suffix. One organization credential covers every feed in the organization. This example covers the two Services hosts.

**Credentials.**

| Kind | How it is obtained | Lifetime | Scope |
|---|---|---|---|
| Personal access token (PAT), organization-scoped | The UI, or the [PAT lifecycle API](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops); only a user-delegated Entra token can call it, so service principals and managed identities cannot create PATs | Set by the creator, capped by the tenant's maximum-lifespan [policy](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/manage-pats-with-policies-for-administrators?view=azure-devops). Global (all-organization) PATs stop working on 2026-12-01 | `vso.packaging` (read), `vso.packaging_write` (read and write), `vso.packaging_manage` (also delete): [OAuth scopes](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/oauth?view=azure-devops). Scopes are organization-wide, not per feed or package; the user's feed role still decides what is allowed ([feed permissions](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions?view=azure-devops)) |
| Session token from the SessionTokens API (Compact, a PAT; or SelfDescribing, a JWT) | Minted from an Entra token by artifacts-credprovider with scope `vso.packaging_write vso.drop_write`, even for restore ([VstsSessionTokenClient.cs](https://github.com/microsoft/artifacts-credprovider/blob/fd03bdfa0d44facee74b938ed74512f468b048b0/CredentialProvider.Microsoft/CredentialProviders/Vsts/VstsSessionTokenClient.cs)) | credprovider defaults: Compact 90 days, SelfDescribing 4 hours (capped at 24 hours) ([VstsSessionTokenFromBearerTokenProvider.cs](https://github.com/microsoft/artifacts-credprovider/blob/fd03bdfa0d44facee74b938ed74512f468b048b0/CredentialProvider.Microsoft/CredentialProviders/Vsts/VstsSessionTokenFromBearerTokenProvider.cs)); the service may grant less (the client logs a requested and a received `validTo` that differ), and the returned `validTo` is authoritative | As above |
| Entra access token for the Azure DevOps resource `499b84ac-1321-427f-aa17-267ca6975798` | `az account get-access-token`, MSAL, or a managed identity: [Entra tokens](https://learn.microsoft.com/en-us/azure/devops/cli/entra-tokens?view=azure-devops), [service principals and managed identities](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/service-principal-managed-identity?view=azure-devops) | About one hour (the [Azure CLI page](https://learn.microsoft.com/en-us/azure/devops/cli/entra-tokens?view=azure-devops) says they last one hour; the service-principal page says not to depend on a fixed lifetime, so the provider reads the expiry its token source returns) | Not packaging-only: everything the client is permitted for, in every organization of the tenant where the identity is a member |
| Pipelines job token (`System.AccessToken`) | `NpmAuthenticate@0` writes it as `_authToken` ([task source](https://github.com/microsoft/azure-pipelines-tasks/blob/952b2f72d356677dae10cf535dacc0d752ca4cb9/Tasks/NpmAuthenticateV0/npmauthutils.ts)); the job access token is generated for each job at run time ([job access tokens](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/access-tokens?view=azure-devops)) | The job; that it stops working when the job ends is recalled, not verified | The build identity: `Project Collection Build Service` or the project's `Build Service`, by default Collaborator; publishing needs Contributor on both ([feed permissions](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions?view=azure-devops), [publish from Pipelines](https://learn.microsoft.com/en-us/azure/devops/pipelines/artifacts/npm?view=azure-devops)) |

**Headers.** A PAT goes in `Authorization: Basic`. The PAT [docs](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops) allow an empty username; the [npm docs](https://learn.microsoft.com/en-us/azure/devops/artifacts/npm/npmrc?view=azure-devops) use a non-empty one because npm needs a username and `_password` pair. artifacts-credprovider answers session tokens as Basic with username `VssSessionToken` and Entra tokens as Basic with username `EntraToken` (opt-in) ([VstsCredentialProvider.cs](https://github.com/microsoft/artifacts-credprovider/blob/fd03bdfa0d44facee74b938ed74512f468b048b0/CredentialProvider.Microsoft/CredentialProviders/Vsts/VstsCredentialProvider.cs)); the pipeline task writes the job token as `_authToken` (Bearer) ([task source](https://github.com/microsoft/azure-pipelines-tasks/blob/952b2f72d356677dae10cf535dacc0d752ca4cb9/Tasks/NpmAuthenticateV0/npmauthutils.ts)), and that it does the same for the Entra token of a workload-identity service connection is recalled, not verified. A PAT the user supplied is sent by the reference provider as Basic with the placeholder username `npm`, since the registry needs a non-empty one. That the endpoint rejects a PAT sent as Bearer is recalled, not verified.

**Roles per operation** ([feed permissions](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions?view=azure-devops), [delete and recover](https://learn.microsoft.com/en-us/azure/devops/artifacts/how-to/delete-and-recover-packages?view=azure-devops)):

| `operation` | Scope and role | Notes |
|---|---|---|
| `read` | `vso.packaging`, Reader | A version an upstream supplies and the feed has not saved yet is saved by the install, which needs Collaborator ([upstream sources](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-sources?view=azure-devops)). No PAT scope sits between `vso.packaging` and `vso.packaging_write` |
| `publish`, `deprecate`, `dist-tag` | `vso.packaging_write`, Contributor | `npm deprecate` is documented; `dist-tag` is recalled, not verified |
| `unpublish` | `vso.packaging_manage`, Owner | `npm unpublish pkg@version` moves that version to a 30-day Recycle Bin; the number stays reserved |
| `stage`, `stage-read`, `stage-reject` | none | Not documented: Microsoft's npm pages ([npmrc](https://learn.microsoft.com/en-us/azure/devops/artifacts/npm/npmrc?view=azure-devops), [publish](https://learn.microsoft.com/en-us/azure/devops/artifacts/npm/publish?view=azure-devops), [npm in Pipelines](https://learn.microsoft.com/en-us/azure/devops/pipelines/artifacts/npm?view=azure-devops)) and the [feed roles](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions?view=azure-devops) describe no staging of npm versions (the roles do list promoting a package to a view, which makes a published version visible through that view: it is not a staging area before publication, and npm sends no operation for it), and a search of Microsoft's pages found none. An absence in the documentation, not a statement that the endpoints do not exist (read 2026-10) |
| `owner`, `access`, `trust`, `account` | none | These npm endpoints are not implemented (recalled) |

## Configuration

```ini
# ~/.npmrc
//pkgs.dev.azure.com/contoso/:credentialProvider[]=npm-credential-provider-azure-artifacts --org contoso
//contoso.pkgs.visualstudio.com/:credentialProvider[]=npm-credential-provider-azure-artifacts --org contoso
```

The keys sit at the organization prefix, not at a feed. The feed URL has two spellings (`/npm/registry/` and `/npm/`), project-scoped and organization-scoped feeds sit under different paths, and the credential is organization-wide anyway. A key at the prefix covers all of them by path prefix, and `registry` in every request is then the key's URL, `https://pkgs.dev.azure.com/contoso/`, not a feed URL ([What is sent](../phase-2-credential-provider.md#registry-matching)). One registry-level answer therefore serves every feed of the organization. The key must use the lowercase host and the organization in the casing the project's registry URLs use, since npm compares paths byte for byte ([Registry matching](../phase-2-credential-provider.md#registry-matching)).

A global chain works too, and then the hello below does the work of the keys:

```ini
credentialProvider[]=npm-credential-provider-azure-artifacts --org contoso
```

No key matched there, so this page reads `registry` as the registry chosen for the request, the feed URL (see [What this registry asks of the RFC](#what-this-registry-asks-of-the-rfc)). npm then caches per feed URL and asks once per feed, though the credential is the same: [global-chain.jsonl](azure-artifacts/global-chain.jsonl) shows two feeds of one organization, and the provider answers both from its own per-organization cache.

What the reference provider ([provider.js](providers/azure-artifacts/provider.js)) reads besides `--org` (it needs `--config <file>` too, which says where its store is): for CI, the pipeline's `SYSTEM_ACCESSTOKEN` and `SYSTEM_COLLECTIONURI` (the job token is used only when the collection is this organization's), or a workload identity's `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_FEDERATED_TOKEN_FILE`; `AZURE_ARTIFACTS_ENTRA_SOURCE=az` to use the Azure CLI's token instead; and `endpoints` in its own configuration file, which the conformance run uses to send every vendor address to a local fake and which a real build has no use for.

The per-registry form is the better default. It keeps the provider from starting for registries it does not serve, and a team that adds this line changes nothing for other registries. Either way a stored `_authToken` that Microsoft's `NpmAuthenticate` task or `vsts-npm-auth` wrote is ignored under the per-registry form, and warned about on every command: delete those lines, or list `npm:token`.

## Hello

```json
{"v":[1],"capabilities":["login","logout","erase"],"registries":["https://pkgs.dev.azure.com/contoso/","https://contoso.pkgs.visualstudio.com/"]}
```

- `capabilities`: `erase` because the provider drops tokens it minted and must be told which one was rejected; `login` and `logout` because it runs the Entra sign-in and clears it. Without `erase` npm may skip it.
- `registries` lists one prefix per organization and host, never the bare `https://pkgs.dev.azure.com/`. An Entra token is valid in every organization of the tenant, so a project that chose `https://pkgs.dev.azure.com/other-org/...` as its registry would otherwise get a token for an organization the user never named. With the field, npm sends the provider nothing about other organizations.
- The entries are compared byte for byte and carry a scheme, so each is written as the user's config writes it. A server-side case-insensitive match (recalled, not verified) does not help: `/Contoso/` is a different path to npm.

## Install

[install.jsonl](azure-artifacts/install.jsonl). A developer runs `npm install` for `@contoso/ui`. The registry is the organization-scoped feed `tools`, reached through the per-registry key above. The provider holds an Entra refresh token in the keychain from `npm login`, gets an access token silently, and mints a session token with `vso.packaging_write`.

```json
{"v":1,"kind":"get","registry":"https://pkgs.dev.azure.com/contoso/","scope":"@contoso","package":"ui","operation":"read","command":"install","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"basic","username":"VssSessionToken","password":"example-session-token-1"},"cache":"expires","expiresAt":1792213200,"operationIndependent":true,"granularity":"registry"}}
```

- The answer is write-capable for a `read`. Saving a version from an upstream needs Collaborator, and the scope above `vso.packaging` is `vso.packaging_write` (see [What this registry asks of the RFC](#what-this-registry-asks-of-the-rfc)). Microsoft's own `ado-npm-auth` mints `vso.packaging_write` for installs for the same reason ([generate-npmrc-pat.ts](https://github.com/microsoft/ado-npm-auth/blob/aadffcc6807c73a6ec0113e25ac6a7f350ae420b/packages/ado-npm-auth-lib/src/npmrc/generate-npmrc-pat.ts), whose comment says that `vso.packaging` is Reader only and `vso.packaging_write` includes the Collaborator permissions).
- `basic` with username `VssSessionToken` and the raw token as `password`. npm does the base64 encoding.
- `expiresAt` is the `validTo` the service returned, not the one the provider asked for.
- `granularity` is `registry`: nothing finer exists. `operationIndependent` is `true` because one `vso.packaging_write` token serves read, publish and deprecate. npm caches every other operation bound to that operation and package anyway ([Caching](../phase-2-credential-provider.md#5-caching)).

## Publish

[publish.jsonl](azure-artifacts/publish.jsonl). `npm publish` of `@contoso/ui` 3.2.0 from a terminal.

```json
{"v":1,"kind":"get","registry":"https://pkgs.dev.azure.com/contoso/","scope":"@contoso","package":"ui","version":"3.2.0","operation":"publish","command":"publish","interactive":true}
```

The provider answers from its own per-organization cache, the same session token as for the install. Publishing needs `vso.packaging_write` and the Contributor role, which the user either has or has not. The provider cannot see the role cheaply, so a refusal is the registry's to give.

[unpublish.jsonl](azure-artifacts/unpublish.jsonl). `npm unpublish @contoso/ui@3.1.0` is the one write that needs more: `vso.packaging_manage` and Owner.

```json
{"v":1,"kind":"get","registry":"https://pkgs.dev.azure.com/contoso/","scope":"@contoso","package":"ui","version":"3.1.0","operation":"unpublish","command":"unpublish","interactive":true}
{"Ok":{"kind":"get","auth":{"type":"basic","username":"VssSessionToken","password":"example-manage-token-1"},"cache":"never","operationIndependent":false,"granularity":"package"}}
```

The manage token is minted from the sign-in for this one request, bound to the package and never reused, and lives 15 minutes (the reference provider's choice: it cannot depend on revoking the token after it exits). A credential that is not minted from the sign-in, a stored PAT, the job token or the identity's Entra token, serves `unpublish` as it serves every operation: the provider cannot see a PAT's scope or the build identity's role, so whether it may delete is the registry's to say, and a 403 gets the refusal shown under Rejection. The unpublished version goes to the Recycle Bin and its number stays reserved ([delete and recover](https://learn.microsoft.com/en-us/azure/devops/artifacts/how-to/delete-and-recover-packages?view=azure-devops)). `stage`, `stage-read` and `stage-reject`, and `owner`, `access`, `trust` and `account`, are answered `operation-not-supported`, so the user sees npm's unsupported-operation error and not a 404 after a write-capable token was released for nothing ([unsupported-operation.jsonl](azure-artifacts/unsupported-operation.jsonl)):

```json
{"Err":{"kind":"operation-not-supported"}}
```

## Rejection

**A 401.** [rejection.jsonl](azure-artifacts/rejection.jsonl). The session token expired in the middle of a long install (a 401 is what an expired token gets: [npmrc](https://learn.microsoft.com/en-us/azure/devops/artifacts/npm/npmrc?view=azure-devops)). The challenge shown is the `Bearer authorization_uri=...` form that artifacts-credprovider parses from an unauthenticated request ([IAuthUtil.cs](https://github.com/microsoft/artifacts-credprovider/blob/fd03bdfa0d44facee74b938ed74512f468b048b0/CredentialProvider.Microsoft/CredentialProviders/Vsts/IAuthUtil.cs)); that a rejected token gets the same challenge is recalled, not verified.

```json
{"v":1,"kind":"erase","registry":"https://pkgs.dev.azure.com/contoso/","scope":"@contoso","package":"ui","operation":"read","granularity":"registry","authChallenges":["Bearer authorization_uri=\"https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000\""]}
{"Ok":{"kind":"erase"}}
{"v":1,"kind":"get","registry":"https://pkgs.dev.azure.com/contoso/","scope":"@contoso","package":"ui","operation":"read","command":"install","interactive":false,"retry":true,"httpStatus":401,"authChallenges":["Bearer authorization_uri=\"https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000\""]}
```

Erase drops the session token the provider minted, from memory and from its own per-organization cache, so the retry mints a new one. It keeps the Entra refresh token: that is `login`'s, removed only by `logout`. A user's static PAT stored by `login --token` is also kept: the provider reports the rejection and names `npm logout` and `npm login` ([rejection-pat.jsonl](azure-artifacts/rejection-pat.jsonl)). The retry answers with a new token and a later `expiresAt`. What stays in the store after an erase of a manage token is only the `authorizationId` the provider needs to revoke it at logout, never the token.

**A 401 with a token that has not expired.** With `az account get-access-token` as the token source, a non-interactive retry (CI, where the bare token is handed out) gets the same token again, because `az` serves its cached token until it is near expiry. The provider must not answer with it. (The reference provider does not run `az`: it is told to use that source by `AZURE_ARTIFACTS_ENTRA_SOURCE=az` and reads the token from a stand-in HTTP address, since a run cannot depend on `az` being installed; whether the real command's output has the fields used here is recalled, not verified.) A 401 on an unexpired Entra token can mean an identity not added to the organization (`TF401444`, [service principals](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/service-principal-managed-identity?view=azure-devops)); the az subscription must also belong to the tenant connected to the organization ([Entra tokens](https://learn.microsoft.com/en-us/azure/devops/cli/entra-tokens?view=azure-devops)). That a wrong tenant or a conditional-access rule gives a 401 is recalled, not verified. Refreshing fixes none of them. It answers the retry with a diagnosis ([rejection-unchanged-token.jsonl](azure-artifacts/rejection-unchanged-token.jsonl)):

```json
{"Err":{"kind":"other","message":"Azure Artifacts rejected an Entra token that has not expired. The token source returns the same token again. Check that the signed-in tenant is the one connected to the contoso organization and that the identity is a member of it, then run npm login."}}
```

**A 403 on publish.** [publish-version-conflict.jsonl](azure-artifacts/publish-version-conflict.jsonl). A 403 on a publish usually means the version exists or once existed in the feed, and an upstream that holds the version blocks it too; versions are immutable and permanently reserved ([publish](https://learn.microsoft.com/en-us/azure/devops/artifacts/npm/publish?view=azure-devops), [upstream sources](https://learn.microsoft.com/en-us/azure/devops/artifacts/concepts/upstream-sources?view=azure-devops)). npm sends no erase, only a retry:

```json
{"v":1,"kind":"get","registry":"https://pkgs.dev.azure.com/contoso/","scope":"@contoso","package":"ui","version":"3.2.0","operation":"publish","command":"publish","interactive":true,"retry":true,"httpStatus":403}
{"Err":{"kind":"other","message":"Azure Artifacts refused the publish of @contoso/ui 3.2.0 with 403. For a publish this usually means the version already exists, or once existed, in the feed or in an upstream, and versions are never reused. No other credential is released for this request. Publish a new version.","causedBy":["Azure Artifacts answers 403 for a duplicate or deleted version"]}}
```

The provider does not move to `vso.packaging_manage`: that token can delete, and the retry would fail anyway. A 403 on `read` never moves to a credential that can write when the first answer could not ([erase](../phase-2-credential-provider.md#erase-a-credential-was-rejected)); here the first answer already is the widest the provider releases for a read, so the retry is answered `other` and names the role to ask a feed owner for ([read-forbidden.jsonl](azure-artifacts/read-forbidden.jsonl)). That the registry also answers 403 with `User ... lacks permission ... You need to have AddPackage` for a missing permission is recalled, not verified.

## Login and logout

[login.jsonl](azure-artifacts/login.jsonl). `npm login --registry https://pkgs.dev.azure.com/contoso/_packaging/tools/npm/registry/`:

```json
{"v":1,"kind":"login","registry":"https://pkgs.dev.azure.com/contoso/","interactive":true}
{"Ok":{"kind":"login"}}
```

The provider probes the feed URL without credentials and reads `X-VSS-ResourceTenant` and the `authorization_uri` of `WWW-Authenticate` to find the Entra authority ([IAuthUtil.cs](https://github.com/microsoft/artifacts-credprovider/blob/fd03bdfa0d44facee74b938ed74512f468b048b0/CredentialProvider.Microsoft/CredentialProviders/Vsts/IAuthUtil.cs): it reads the tenant header and the `authorization_uri` parameter of the challenge). It checks the authority against an allowlist of Microsoft's sign-in hosts that is the provider's own: artifacts-credprovider's allowlists cover the feed host and the SPS endpoint, not the authority, which it takes from the challenge as given ([VstsEndpointPolicy.cs](https://github.com/microsoft/artifacts-credprovider/blob/fd03bdfa0d44facee74b938ed74512f468b048b0/CredentialProvider.Microsoft/CredentialProviders/Vsts/VstsEndpointPolicy.cs)). It does not take an authority from `authChallenges`. Then it signs in with the broker, the system browser or device code, writes the device-code text to the controlling terminal and not to stderr, and stores the refresh token in the keychain. It confirms the login with its own request to the feed before it answers. With a `token` the user supplied, it stores that PAT instead and validates it the same way, with a request to the feed as Basic ([login-pat.jsonl](azure-artifacts/login-pat.jsonl) shows the login and the Basic answer a later `get` gets). Azure DevOps Server takes a `token` only and answers a login without one `operation-not-supported`.

[login-refused.jsonl](azure-artifacts/login-refused.jsonl). The Entra sign-in is started and not finished: the user closes the browser, or the device code is never entered. artifacts-credprovider's device flow gives up after 90 seconds by default ([EnvUtil.cs](https://github.com/microsoft/artifacts-credprovider/blob/fd03bdfa0d44facee74b938ed74512f468b048b0/CredentialProvider.Microsoft/Util/EnvUtil.cs)); what it does afterwards (its exit code and message) is not documented, so the provider decides the outcome itself and answers `other`, as the [corporate gateway](corporate-sso.md) does when its sign-in is not approved ([login-unapproved.jsonl](corporate-sso/login-unapproved.jsonl)):

```json
{"v":1,"kind":"login","registry":"https://pkgs.dev.azure.com/contoso/","interactive":true}
{"Err":{"kind":"other","message":"The Microsoft Entra sign-in for the contoso organization was not completed within 90 seconds. Nothing was stored. Run npm login again."}}
```

[login-no-terminal.jsonl](azure-artifacts/login-no-terminal.jsonl) shows the same login with no controlling terminal to show the device code on: the provider cannot show the step, so it answers `other` at once, naming `npm login` from a terminal, without polling Entra until the deadline.

**The authority check refuses.** Three answers of the probe, each a login that answers `other` before any sign-in is started, with nothing stored and Entra never asked for a device code: the challenge names an authority on a host outside the allowlist ([login-authority-not-allowed.jsonl](azure-artifacts/login-authority-not-allowed.jsonl)); the tenant in `X-VSS-ResourceTenant` is not the tenant in the authority's path, so the feed names two ([login-tenant-mismatch.jsonl](azure-artifacts/login-tenant-mismatch.jsonl)); and the authority is `http:` and not `https:` ([login-authority-http.jsonl](azure-artifacts/login-authority-http.jsonl)), which the provider treats as off the allowlist, with the same answer as the first:

```json
{"v":1,"kind":"login","registry":"https://pkgs.dev.azure.com/contoso/","interactive":true}
{"Err":{"kind":"other","message":"Azure Artifacts named two different Microsoft Entra tenants for the contoso organization, so no sign-in was started."}}
```

Nothing is stored, so there is nothing to clear, and the answer is not `not-found`: that would let a listed `npm:token` run `npm login` and write a plaintext PAT the user never asked for ([login](../phase-2-credential-provider.md#login-authenticate-with-a-registry)). The 90 seconds sit inside the 5-minute interactive budget; the credprovider falling back to a username and password prompt is documented for NuGet clients and is of no use to a provider, which must read the terminal itself.

**A feed the identity cannot see has no transcript.** `not-found` is the answer to a provider that holds nothing for the registry or scope. This provider holds an organization-wide credential, so it answers `Ok` for any feed under the organization prefix and cannot tell which feeds the identity may read: that is decided by the feed's roles when the request is made ([feed permissions](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions?view=azure-devops)). Microsoft's documents do not say whether an unreadable feed answers 401, 403 or 404, and none say the service hides it, so no refusal of that kind is shown; it would reach the provider as a 401 or 403 retry, covered above. A feed in another organization is `url-not-supported`, since it is not in the hello `registries`. Not verified: the status an unreadable feed gets.

[logout.jsonl](azure-artifacts/logout.jsonl):

```json
{"v":1,"kind":"logout","registry":"https://pkgs.dev.azure.com/contoso/"}
{"Ok":{"kind":"logout"}}
```

The provider revokes the session tokens it minted and still holds the handles of (that needs an Entra token, from the refresh token), clears its own account and keychain entries, and answers `Ok` even if the revocation failed, with a warning on stderr. It does not run `az logout` or touch the caches of `az` and artifacts-credprovider, which other tools own. A PAT the user supplied cannot be revoked without an Entra token: the provider removes it locally and warns.

## CI

[ci.jsonl](azure-artifacts/ci.jsonl). `npm ci` in a pipeline with a managed identity or a workload-identity service principal, `interactive` false. The provider may use only a silent cache, the identity, or the job token if the pipeline maps `$(System.AccessToken)` into the environment. Service principals and managed identities cannot create PATs ([PAT docs](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops)), so the answer is the Entra token itself:

```json
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-entra-token-1"},"cache":"expires","expiresAt":1792202400,"operationIndependent":true,"granularity":"registry"}}
```

**A publish from a pipeline.** [ci-publish.jsonl](azure-artifacts/ci-publish.jsonl). `npm publish` in a job, `interactive` false. Microsoft's own route is `NpmAuthenticate@0` followed by `npm publish`, with the build identities made Feed Publisher (Contributor) on the feed ([publish from Pipelines](https://learn.microsoft.com/en-us/azure/devops/pipelines/artifacts/npm?view=azure-devops)); the default is Collaborator, which cannot publish ([feed permissions](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions?view=azure-devops)). With the job token mapped into the provider's environment the provider has nothing to mint and answers the token itself, as `bearer` like the Entra token above. A workload-identity service principal answers the same way with its Entra token, once it has been added to the organization ([service principals](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/service-principal-managed-identity?view=azure-devops)) and given Contributor on the feed ([feed permissions](https://learn.microsoft.com/en-us/azure/devops/artifacts/feeds/feed-permissions?view=azure-devops)).

```json
{"v":1,"kind":"get","registry":"https://pkgs.dev.azure.com/contoso/","scope":"@contoso","package":"ui","version":"3.2.0","operation":"publish","command":"publish","interactive":false}
{"Ok":{"kind":"get","auth":{"type":"bearer","token":"example-job-token-1"},"cache":"session","operationIndependent":true,"granularity":"registry"}}
```

- No presence prompt, no login and no minting: the pipeline is what authorizes the publish, and `interactive: false` forbids the rest ([Non-interactive and CI behavior](../phase-2-credential-provider.md#non-interactive-and-ci-behavior)).
- `cache` is `session`: the token has no expiry the provider can read, and the job is the process. `operationIndependent` is `true` because the same token serves read, publish and deprecate; npm still binds a `publish` answer to its operation and package ([Caching](../phase-2-credential-provider.md#5-caching)).
- Whether the token may publish is the feed role's to say. A 403 on this request is, as above, mostly a version conflict, and a 401 with the job token has no refresh to fall back on.
- That the provider reads the job token from an environment variable the pipeline maps (`env: SYSTEM_ACCESSTOKEN: $(System.AccessToken)`) is recalled, not verified; the access-token page does not say that a script step needs the mapping.
- If the identity holds no token at all, the answer is `not-found`, as for a read.

A later request for a project-scoped feed, `https://pkgs.dev.azure.com/contoso/web/_packaging/web-feed/npm/registry/`, is a cache hit: the key is the same, so npm sends no second `get`. Nothing finer than the identity's feed role limits this token. If a token exists but would need a prompt, the provider answers `other`; if nothing is configured, `not-found`.

## Where it is easy to go wrong

- **Starting `read` at `vso.packaging`.** An install that saves a version from an upstream needs Collaborator, and a 403 on `read` must not move to a credential that can write. The provider has to pick `vso.packaging_write` up front or fail the install.
- **Escalating a publish 403 to `vso.packaging_manage`.** The 403 is a version conflict. The wider token can delete and still fails.
- **Handing out the Entra token for `read` by default.** It is not packaging-scoped and works in every organization of the tenant. Use it to mint a short-lived packaging token; keep the bare token for CI (`interactive` false), where nothing else exists. The reference provider hands it out only there: an interactive request that has no sign-in but finds an Entra token on the machine is answered `other`, naming `npm login` ([install-az-interactive.jsonl](azure-artifacts/install-az-interactive.jsonl)). It does not mint from the machine's own identity token, which would be the fuller design for a person who is signed in with `az`.
- **Passing `_password` through.** Microsoft's `.npmrc` snippet stores `_password` as base64 of the PAT, and `ado-npm-auth` decodes it ([npmrcFileProvider.ts](https://github.com/microsoft/ado-npm-auth/blob/aadffcc6807c73a6ec0113e25ac6a7f350ae420b/packages/ado-npm-auth-lib/src/npmrc/npmrcFileProvider.ts)). The protocol's `password` is the raw token and npm encodes `username:password` itself. A provider that returns the stored value sends doubly encoded credentials and gets a 401 on every request, which ends in a pointless erase and retry.
- **One auth type for every token.** PATs and session tokens go as `basic`; Entra and job tokens as `bearer`. "Bearer for everything" breaks a static PAT.
- **Listing `https://pkgs.dev.azure.com/` as the registry.** List one organization.
- **Matching the feed instead of the organization.** The key, the hello entry and the provider's own matching sit at the organization prefix, in the user's casing. A key at `.../_packaging/FEED/npm/registry/` misses requests under `.../npm/`, and `Contoso` is not `contoso`.
- **Taking the second path segment as the project.** For an organization-scoped feed it is `_packaging`. Locate `_packaging` first; the URL parser of `ado-npm-auth` takes the second segment of a `dev.azure.com` path as the project, so it returns `_packaging` as the project for such feeds (it uses only the organization, which it gets right) ([get-organization-from-feed-url.ts](https://github.com/microsoft/ado-npm-auth/blob/aadffcc6807c73a6ec0113e25ac6a7f350ae420b/packages/ado-npm-auth-lib/src/utils/get-organization-from-feed-url.ts)).
- **A per-feed cache.** The credential is organization-wide. With the key at the organization prefix npm's cache key is that prefix and covers every feed; under a global chain it is each feed URL. Keep a per-organization cache in the provider either way, and let one erase evict the token for every feed.
- **Reporting the requested lifetime as `expiresAt`.** A tenant policy can cap a PAT, and credprovider retries a 400 without `validTo` so that the service picks the lifetime (its own log line says "service-defined valid-time"; the reason for the 400 is not stated there) ([VstsSessionTokenClient.cs](https://github.com/microsoft/artifacts-credprovider/blob/fd03bdfa0d44facee74b938ed74512f468b048b0/CredentialProvider.Microsoft/CredentialProviders/Vsts/VstsSessionTokenClient.cs)). Report what the service returned.
- **Expecting presence to gate a publish.** The `read` answer already carries `vso.packaging_write`, so a script that asks for `read` gets a token that can publish; a presence prompt on `publish` guards only the request, not the token ([Publishing while a script runs](../phase-2-credential-provider.md#publishing-while-a-script-runs)). A provider that wants the gate has to keep the write token out of `read`, which this registry makes costly for installs from an upstream.
- **Answering an `http:` URL.** `registry` arrives with the request's scheme. The hello lists `https:` entries only, so npm treats the `http:` form as `url-not-supported` and asks nothing; a provider in the global chain, or one that matches for itself, answers `url-not-supported` too ([Registry matching](../phase-2-credential-provider.md#registry-matching)). An Azure DevOps Server over `http:` needs its own, explicit entry.
- **Re-running `az` on the retry.** It returns the rejected token.
- **Writing the device-code prompt to stderr.** Under the RFC stderr is logged at verbose only. Open the controlling terminal. credprovider's device-code flow times out after 90 seconds, inside the 5-minute interactive `get` budget.
- **Trusting `authChallenges` for the authority.** The provider does its own probe, cached per organization, and checks the authority against its own allowlist of Microsoft sign-in hosts.
- **Copying `vsts-npm-auth`'s defaults.** It writes a read-write token for 90 days (`-E 129600`) unless run with `-R` ([README, version 0.43.0](https://registry.npmjs.org/vsts-npm-auth), inspected, not executed). `ado-npm-auth` mints `vso.packaging_write` tokens ([generate-npmrc-pat.ts](https://github.com/microsoft/ado-npm-auth/blob/aadffcc6807c73a6ec0113e25ac6a7f350ae420b/packages/ado-npm-auth-lib/src/npmrc/generate-npmrc-pat.ts)) and suggests running from `preinstall`, a project-controlled install hook ([README](https://github.com/microsoft/ado-npm-auth/blob/aadffcc6807c73a6ec0113e25ac6a7f350ae420b/packages/ado-npm-auth/README.md)). A provider should mint short tokens and keep the refresh token in the keychain. Global PATs stop working on 2026-12-01 in any case.
- **Treating a view as another credential.** `FEED@Release` takes the same organization token; the view is read-only.
- **Releasing a token for a command the registry does not implement.** Answer `operation-not-supported` for the `stage*`, `owner`, `access`, `trust` and `account` operations.
- **Sending a PAT over `http:`** to an Azure DevOps Server. Refuse unless the user opted in. Server uses PATs only, sometimes with the username `DefaultCollection` for a collection-scoped feed ([npmrc](https://learn.microsoft.com/en-us/azure/devops/artifacts/npm/npmrc?view=azure-devops)); NTLM and Negotiate cannot be expressed by the protocol.
- **Leaving `NpmAuthenticate` in a pipeline.** It writes a stored job token that a per-registry provider list ignores, with a warning on every command.

## What this registry asks of the RFC

- **[Operations](../phase-2-credential-provider.md#4-operations), registry-tier table.** Nothing to change in the RFC. On Azure Artifacts the lowest credential that serves `read` can be write-capable: an install that saves a package from an upstream needs Collaborator, which only `vso.packaging_write` reaches. The 403 rule only bars widening a `read` answer when the first answer could not write, so a provider that starts with the write token is within the text. The cost is the one named under pitfalls: the `read` answer can publish, so a presence prompt on `publish` guards the request, not the token.
- **[erase](../phase-2-credential-provider.md#erase-a-credential-was-rejected), the 403 row.** On publish a 403 is mostly a version conflict, not a missing permission, so the row's reason ("lacks permission; the provider may have a more privileged one") does not describe this registry. The RFC permits the retry; a provider has to know not to widen. A line in the row or in Operations would say that a retry may reasonably be answered `other`. **Settled:** the retry bullet now says a provider with nothing else to release answers `other`, naming what it knows rather than a guessed cause.
- **[Auth types](../phase-2-credential-provider.md#auth-types).** The RFC does not say whether `username` in `basic` may be empty. Microsoft's PAT docs allow it and its npm docs say to use a non-empty one. The example sends `VssSessionToken` for a session token and `npm` for a stored PAT. **Settled:** both fields are non-empty, and a provider whose registry ignores the username sends a fixed placeholder.
- **[Registry matching](../phase-2-credential-provider.md#registry-matching).** Paths are compared byte for byte, but the server treats the organization case-insensitively (recalled, not verified). A project that spells `/Contoso/` is not covered by a hello entry or key written `/contoso/`, and under a per-registry list the request fails. The RFC could say so where it explains the comparison.
- **[Security model](../phase-2-credential-provider.md#6-security-model), "Input is the protocol fields only".** It does not say whether the provider may read its own environment. CI needs it (`System.AccessToken`, `az`, managed-identity settings). npm strips `npm_config_*` and similar from the provider's environment, not other variables. A clarification: the provider may read its own environment, and npm sends none of its config through it. **Settled:** the Input bullet now separates the request from the environment the provider is started with.
- **[Caching](../phase-2-credential-provider.md#5-caching).** `granularity` has no value broader than the registry URL, while the credential is organization-wide. With a per-registry key at the organization prefix this costs nothing, since the key is the registry. Under a global chain, where `registry` is the feed URL, it costs one `get` per feed and an erase that must evict across feeds; the provider's own per-organization cache absorbs both. A note would do.
- **[Registry matching](../phase-2-credential-provider.md#registry-matching), "What is sent".** For a request matched only through hello `registries` the text does not say whether `registry` is the hello entry or the chosen registry. This page reads it as the chosen registry, like the JFrog page. **Settled:** it is the chosen registry; a hello entry is never what is sent.
- **[Erase](../phase-2-credential-provider.md#erase-a-credential-was-rejected), the retry.** Nothing new: the retry for a token source that returns the same token (`az`) is answered `other`, which the RFC allows. It said that the retry `get` carries the rejection but not that a provider should not re-answer with the same credential; the retry bullet now says so.
- **[Request kinds](../phase-2-credential-provider.md#3-request-kinds) and the conformance model.** A provider error on the retry once ended the transcript in the test model, so an `Err` answer to a rejection could not be a checked transcript. **Settled:** the model now fails that request and the session goes on, so [rejection-unchanged-token.jsonl](azure-artifacts/rejection-unchanged-token.jsonl), [rejection-pat.jsonl](azure-artifacts/rejection-pat.jsonl) and [read-forbidden.jsonl](azure-artifacts/read-forbidden.jsonl) are checked transcripts.
