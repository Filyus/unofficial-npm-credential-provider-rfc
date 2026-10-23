# RFC draft: npm credential providers

This document was split by phase after revision 28, its last combined one; both parts begin at revision 29. Its content now lives in:

- **[Phase 1a: `tokenHelper`](phase-1a-token-helper.md):** the pnpm-compatible per-registry helper, the motivation, and the trust rule both phases follow.
- **[Phase 1b: credential hardening](phase-1b-credential-hardening.md):** how every credential travels, written after the split; it holds nothing of the old document.
- **[Phase 2: credential provider protocol](phase-2-credential-provider.md):** the protocol, its security model, rationale, prior art and open questions.
- **[Examples](examples/README.md):** how providers for real registries would answer.

Where the old sections went:

| Old section | New place |
|---|---|
| Summary, Motivation, Scope | [Phase 1a](phase-1a-token-helper.md#summary), and for the protocol [Phase 2](phase-2-credential-provider.md#summary) |
| Trust | [Phase 1a: Trust](phase-1a-token-helper.md#trust) |
| Phase 1a: `tokenHelper` | [Phase 1a: The setting](phase-1a-token-helper.md#the-setting) and the sections after it |
| Phase 2: `credentialProvider`, sections 1–7 | [Phase 2: Detailed Explanation](phase-2-credential-provider.md#detailed-explanation) |
| 8. Example: GitLab provider | [examples/gitlab.md](examples/gitlab.md) |
| Rationale and Alternatives | [Phase 2](phase-2-credential-provider.md#rationale-and-alternatives); environment variables in [Phase 1a](phase-1a-token-helper.md#rationale-and-alternatives) |
| Implementation, Configuration | [Phase 1a](phase-1a-token-helper.md#implementation) and [Phase 2](phase-2-credential-provider.md#implementation) |
| Prior Art, open decisions for the npm maintainers, Appendix | [Phase 2](phase-2-credential-provider.md#prior-art) |
| Migration Plan | [Phase 1a](phase-1a-token-helper.md#migration-plan) and [Phase 2](phase-2-credential-provider.md#migration-plan) |
