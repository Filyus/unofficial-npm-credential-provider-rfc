# Provider examples

How providers for real registries would use the [Phase 2 protocol](../phase-2-credential-provider.md): their configuration, hello, and the exchanges for an install, a publish and a rejection, with where a provider author is likely to go wrong. The providers are hypothetical; what they rely on (token lifetimes, scopes, APIs, CLIs) is the vendors' documented behaviour.

| Registry | What it shows |
|---|---|
| [GitLab](gitlab.md) | OAuth with a refresh token in the keychain, project-scoped tokens, `granularity: scope` |
