# GitLab

A hypothetical `npm-credential-provider-gitlab` that uses GitLab's fine-grained tokens.

**One-time setup:**

```bash
npm install -g npm-credential-provider-gitlab
# add to ~/.npmrc:
# //gitlab.example.com/:credentialProvider[]=npm-credential-provider-gitlab --instance https://gitlab.example.com
npm login --registry https://gitlab.example.com/
# opens a browser for GitLab OAuth; the provider keeps its refresh token in the OS keychain
```

**On `npm install`:**

1. npm needs `@scope/package` from `gitlab.example.com`, finds nothing cached, and spawns the provider, which sends `{"v":[1],"capabilities":["login","logout","erase"]}`.
2. npm sends `{"v":1,"kind":"get","registry":"https://gitlab.example.com/api/v4/projects/42/packages/npm/","scope":"@scope","package":"package","operation":"read","command":"install","interactive":true}` (from a developer's terminal).
3. The provider reads its refresh token from the keychain and obtains a short-lived token scoped to project 42 with `read_package_registry`.
4. It answers `{"Ok":{"kind":"get","auth":{"type":"bearer","token":"glpat-short-lived"},"cache":"expires","expiresAt":1744201800,"granularity":"scope"}}`.
5. Every other `@scope/*` package is a cache hit. If the install outlasts the token, the next lookup is another `get`, and the provider refreshes on its own side.
6. npm closes stdin; the provider exits.

The developer configured it once; no token ever reached a file npm reads.
