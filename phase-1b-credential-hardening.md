# RFC draft: credential hardening for npm (Phase 1b)

> Status: Draft
> Revision: 1
> Date: 2026-10-22

> Phase 1b of an unofficial proposal building on the [npm/rfcs#850](https://github.com/npm/rfcs/pull/850) discussion. [Phase 1a](phase-1a-token-helper.md) adds `tokenHelper`; [Phase 2](phase-2-credential-provider.md) adds a protocol. This document changes how npm sends a credential, whatever its source: a stored `_authToken`, a helper's token or a provider's.

## Summary

npm sends a registry credential wherever the request goes and by whatever route the configuration names, and a project can influence both. A repository's `.npmrc` can choose the proxy and the certificates a credentialed request uses, npm hands that same configuration to every child npm it starts, a redirect can carry the credential to a different port, and a registry served over `http:` receives it in the clear.

This proposal makes credentials travel under one rule, for stored tokens, helpers and providers alike:

- A credential goes only over `https:`, or `http:` to a loopback address.
- A credentialed request takes its transport settings only from config a project cannot write, child npm processes included.
- A redirect keeps the credential only for the same host and port and an allowed scheme.
- The credential stays out of the HTTP cache index and out of registry error responses.
- A project `.npmrc` cannot choose the user or global config file.

It ships as one opt-in setting in a minor release, `strict-credentials`, and is the default in the next major.

## Motivation

[Phase 1a](phase-1a-token-helper.md) already refuses two of these routes for a helper's credential, plain `http:` except to this machine and a proxy or CA that a project chose, because a helper mints a fresh, often broad token. Its runner can decide that before the program starts, from the request's URL and from which layer a setting came from. This proposal extends the same two rules to every credential, a stored `_authToken` included, and adds what is the library's to do after a credential is sent.

The weaknesses below are today's behaviour for a stored `_authToken`. A helper or provider inherits those that 1a does not refuse (redirects, the cache index, error responses, `noproxy` and `local-address`) until this proposal lands.

- **A project chooses the route.** A request carrying a credential takes `proxy`, `https-proxy`, `noproxy`, `ca`, `cafile`, `strict-ssl` and `local-address` from any config layer, a repository's `.npmrc` among them. That `.npmrc` can send the credential through its own proxy, or past a certificate it chose.
- **A child npm reads the project's config as its environment.** When npm starts a script, it exports its resolved config, project values included, as `npm_config_*` variables ([sources.md](sources.md#external-facts)). A child npm reads them as its environment layer, which ranks above every file, so a transport setting the parent took from the repository reaches the child as if the user had set it, and a rule applied only to files is bypassed by `npm run`.
- **`http:` and redirects.** A stored token's key carries no scheme, so a lockfile `resolved` URL over `http:` on the registry's host carries the token. A redirect on the same host name can change the port.
- **The cache index.** make-fetch-happen writes to its cache index every request header a response names in `Vary`, `Authorization` included ([sources.md](sources.md#external-facts)).
- **Error responses.** A registry that echoes the request in a non-2xx body puts the credential into npm's error, the debug log and CI output.
- **The user and global file can be moved.** A project `.npmrc` can set `userconfig`, `globalconfig` or `prefix` (the global file lives under it), so a repository file loads in the place of the user's.

## Detailed Explanation

### The setting

`strict-credentials` is a boolean, default `false` in a minor release and `true` from the next major. It can be set in any config layer, since it can only add protection; a project `.npmrc` that sets it to `false` is not honoured (only user, global, environment and command-line values may turn it off).

With it `false`, npm warns for what the rules below would change and behaves as today.

### Where a credential may go

A request carries a credential only when its URL is `https:`, or `http:` to a loopback address (`localhost`, `127.0.0.1`, `::1`). Otherwise npm sends the request without it and warns at the default log level, once per registry, naming the registry key and the remedy: serve the registry over `https:`. The warning is not left to `verbose`: a registry that answers 401 with nothing in the request to say why is what a silent withhold looks like.

The same rule covers the credential's source: a stored token, a helper and a provider all pass through it. A loopback request with a credential does not go through a proxy, so a local registry is reached directly and the credential never leaves the machine.

### Which settings a credentialed request may take from a project

A request that carries a credential takes `proxy`, `https-proxy`, `noproxy`, `ca`, `cafile`, `strict-ssl` and `local-address` only from config a project cannot write: the command line, the user and global files, the environment as the user's shell set it, and the built-in defaults. A project `.npmrc` and `publishConfig` do not count. Requests without a credential keep taking them from every layer.

**Child npm processes.** The parent knows which values came from a project, and the child, which reads its parent's config as `npm_config_*`, cannot tell. The parent therefore exports a marker naming the transport keys whose value came from a project, and the child ignores those environment values for credentialed requests. A value the user set in the shell is not marked and is honoured. The marker is set only when a credential could be sent, and only for the keys that came from a project.

A check that runs a script which calls `npm` against a repository whose `.npmrc` sets a proxy covers the child case end to end.

### Redirects

npm follows a redirect of a credentialed request itself, one hop at a time, and keeps the credential only when the target has the same host and port as the request and a scheme allowed above. Comparing `host` and not `hostname` is the fix: `host` includes the port. A hop to another host or port continues without the credential, and a redirect from `https:` to `http:` on a non-loopback address does too.

### The HTTP cache

`Authorization` is never written to make-fetch-happen's cache index, whatever a response's `Vary` says. This is a change to make-fetch-happen 16.x, which writes every header a response names in `Vary` ([sources.md](sources.md#external-facts)), and is proposed there separately. Until it ships, a registry that sends `Vary: Authorization` leaves the credential in the index. registry.npmjs.org does not send it on a packument; no other registry was checked ([sources.md](sources.md#not-verified)).

### Error responses

The error npm-registry-fetch raises for a non-2xx answer loses the credential npm sent on that request: its `message`, `body` and `headers`. A JSON body is walked key by key and string by string to a bounded depth, and any other body is searched as text; each occurrence of the exact credential, in the forms a registry echoes it (as it is, JSON-escaped, percent-encoded), is replaced by `***`. The walk is linear in the size of the body. A successful response is the caller's data and is not touched.

What this does not do is hide a credential from a registry that is meant to receive it, or recognise a token by its shape: only the credential npm sent is removed.

### Project config cannot choose the user or global file

A project `.npmrc` cannot set `userconfig` or `globalconfig`. In a minor release with `strict-credentials` false, npm warns and still applies the value; with it true, and in the next major by default, npm refuses the setting with an error naming the file and the line.

A project-set `prefix` is not refused: it still applies to installs, which is what a repository that sets `prefix` relies on. npm does not use it to locate the global config file, which is found only from the user's, environment, command-line or built-in `prefix`. The global file therefore cannot move into the repository, and `prefix` alone moves nothing the credential rules depend on.

This covers the project's own choice only. [Phase 1a's trust rule](phase-1a-token-helper.md#where-it-may-be-set) keeps its location rule for a file whose path the command line or the environment chose (`npm ci --prefix sub`, `NPM_CONFIG_USERCONFIG=$CI_PROJECT_DIR/.npmrc`): such a file is refused when a directory from its own up holds a `package.json` or a `.git`. A CI job, not the user, writes those values, so no refusal of a `.npmrc` setting reaches them, and 1b leaves them to that rule. With 1b, the clause of 1a's rule about `userconfig`, `globalconfig` and `prefix` in a project `.npmrc` holds by construction; the location rule stays.

## Threat model

| Attacker | Action | Today | With Phase 1b |
|---|---|---|---|
| A repository's `.npmrc` | Sets `https-proxy`, `proxy`, `ca`, `cafile` or `strict-ssl=false` | The credential goes through the proxy or past the certificate | A credentialed request ignores them |
| A repository, through `npm run` | Relies on the child npm reading `npm_config_*` | The child applies the project's transport as its environment | The marked keys are ignored by the child for credentialed requests |
| A lockfile or `.npmrc` | Names an `http:` registry or tarball URL | The credential is sent in the clear | Withheld, with a warning; loopback excepted |
| A registry or tarball host | Redirects to another port of the same host | Followed with the credential | Followed without it |
| A host on the path | Sends `Vary: Authorization` | The credential is in the cache index | Never written there once make-fetch-happen changes |
| A registry | Echoes the request in an error | The credential reaches the log | Removed from the error |
| A repository's `.npmrc` | Sets `userconfig`, `globalconfig` or `prefix` | A repository file loads as the user's | `userconfig` and `globalconfig` refused; a project `prefix` no longer locates the global file |

Out of scope, as in [Phase 1a](phase-1a-token-helper.md#scope): code that already runs as the user, and a registry the user chose that is itself hostile.

## Rationale and Alternatives

**One rule for every credential.** A stricter rule for helpers alone leaves `_authToken`, the credential that leaks today, unchanged, and makes helpers harder to adopt than the token they replace for anyone whose registry is served over `http:` on a network address. Phase 1a takes that cost for the two rules its runner can enforce, because a helper's token is fresh and broad; the rest, and the same rules for stored tokens, wait here. Splitting 1a from this proposal lets the helper ship without a change that affects every user.

**Opt-in first.** Each rule can break a setup that works: an `_authToken` for an `http:` registry on a private network, or a project-selected config file. `strict-credentials` lets those users see the warnings for a release before anything is refused.

**Why a marker and not a different export.** Not exporting transport keys to a child would break scripts that rely on the proxy settings reaching a child npm. A marker keeps what the user set and drops only what a project set.

**Refusing project-set `userconfig` and `globalconfig`, and ignoring a project `prefix` for the global file's location,** instead of detecting where a file lies, for the project's own choice: a refusal has no spelling to get past.

For a file chosen on the command line or in the environment there is no setting to refuse, and 1a detects where the file lies by a walk over its real path's directories for a mark, which needs no identity and is not fooled by a spelling; its limits are in [phase-1a-implementation.md](phase-1a-implementation.md#limits). A project `prefix` is kept for installs because refusing it would break repositories that use it for that, while the one thing it could do to a credential, move the global file, is cut off.

## Prior implementation

Much of this was prototyped for the helper alone on the branch `token-helper-hardened` (npm-registry-fetch 0fcdbb7, npm-cli 7836c74): the check for what may carry a credential, the redirect loop, the transport taken from layers a project cannot write, the redaction of error responses and the end-to-end transport checks. This proposal generalises them to every credential and adds the child-process case. The same branch holds heavier machinery that this proposal does not use: containment by filesystem identity and the masking of fourteen encodings. [phase-1b-implementation.md](phase-1b-implementation.md) lists the submissions, each rule with the submission that carries it, and what the branch showed.

## Migration Plan

| Release | Ships | Done when |
|---|---|---|
| A minor | `strict-credentials`, default `false`; a default-level warning wherever it would change behaviour; the make-fetch-happen change proposed upstream | A user can set it and see what it would change |
| The next major | `strict-credentials` is `true` by default; a project `.npmrc` setting `userconfig` or `globalconfig` is an error | No credential travels outside the rules above unless the user turned them off |

## Compatibility

Who breaks when `strict-credentials` is on:

| Who | What stops working | Mitigation |
|---|---|---|
| An `_authToken` for an `http:` registry that is not loopback | The request goes out without the token and the registry answers 401 | Serve the registry over `https:`, or tunnel it to a loopback address |
| A project that selects a config file with `userconfig` or `globalconfig` in its `.npmrc` | The setting is refused | Pass the option on the command line or in the environment, where the user, not the repository, sets it |
| A project whose `.npmrc` sets `prefix` and expects a global config file under it | The global file is looked up under the user's prefix | Set `globalconfig` on the command line or in the environment |
| A project whose `.npmrc` sets a proxy or CA that registry traffic needs | A credentialed request ignores it | Put the setting in the user or global file, or in the environment |
| A redirect to another port of the registry host | The target gets no credential | Configure the registry's real address |

`strict-credentials=false` restores today's behaviour in the next major, in the user or global file, for a setup that cannot change.

## Open decisions for the npm maintainers

None of the rules is left open. The maintainers are asked to confirm in a design note the name `strict-credentials` and the release it first appears in.
