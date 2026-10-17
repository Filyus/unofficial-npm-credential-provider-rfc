# Provider examples

How providers for real registries would use the [Phase 2 protocol](../phase-2-credential-provider.md): their configuration, hello, and the exchanges for an install, a publish, a rejection, a login and CI, with where a provider author is likely to go wrong and what each registry asks of the RFC. The providers are hypothetical; what they rely on (token lifetimes, scopes, APIs, CLIs) is the vendors' documented behaviour, cited beside each fact, and anything only recalled is marked as such.

Every exchange is also a transcript in the example's directory, and `tests/test_examples.py` replays each one through the Python model of the client, so an example that stops following the protocol fails the tests. Exchanges that end in an error (`other`, `operation-not-supported`) are shown inline only: the model stops at them.

| Registry | What it shows |
|---|---|
| [GitLab](gitlab.md) | OAuth with a refresh token in the keychain; project-level registry URLs, so the key's depth decides what the provider learns; deploy and job tokens in CI |
| [AWS CodeArtifact](aws-codeartifact.md) | A domain-wide token from AWS credentials the provider never sends; tiers that live in IAM, not in the token; SSO sessions that lapse; vendor environment variables that choose the identity |
| [Google Artifact Registry](google-artifact-registry.md) | No tokens of its own: OAuth access tokens and IAM roles; one host per location for the global chain; operations that span two IAM roles |
| [Azure Artifacts](azure-artifacts.md) | PATs and Entra ID tokens over Basic; organisation- and project-scoped feeds; a least-privileged read that can write; a publish 403 that is a version conflict |
| [GitHub Packages](github-packages.md) | One host shared by every owner; tokens no narrower than an owner; two accounts mapped by scope; `GITHUB_TOKEN` in Actions |
| [JFrog Artifactory](jfrog-artifactory.md) | Many repositories on one host; access tokens valid on the whole instance; permissions per user, not per token; anonymous reads |
| [npmjs.com](npmjs.md) | Session tokens and granular tokens; staged publishing with a read-only `stage-read` token, as the [live test](../stage-tiers-test.md) showed; trusted publishing taking over |
| [Verdaccio](verdaccio.md) | Self-hosted, two token tiers minted once at login; a 403 that does not say why; staged publishing and rejection by the stager |
| [Corporate SSO gateway](corporate-sso.md) | An OIDC device-code login on the controlling terminal; tokens minted per request scope; CI with a service identity; `other` rather than `not-found` when presence is needed |
