# Reference providers

Three of the [examples](../README.md) have a provider that runs: [GitLab](gitlab/provider.js), [npmjs.com](npmjs/provider.js) and the [corporate SSO gateway](corporate-sso/provider.js). Each is a Node program with no dependencies that speaks the [Phase 2 protocol](../../phase-2-credential-provider.md) on stdin and stdout, and each produces, from its own state, every answer its example's transcripts record. They show what the pages describe as code: where a provider keeps a refresh token, when it mints and deletes, when it asks for presence and when it answers `other` instead.

```sh
node examples/providers/run.js            # every provider against every transcript of its example
node examples/providers/run.js gitlab     # one provider
```

## How a run works

[`run.js`](run.js) starts the provider as npm would, with `--npm-credential-provider` and the provider's own `--config`, and feeds it the client lines of each `examples/<name>/*.jsonl`. Every provider line must equal the recorded one. A scenario per transcript, `<name>/scenarios/<t>.json`, gives what the answers must follow from:

| Field | What it sets |
|---|---|
| `store` | what the provider has stored: a JSON file standing in for the OS keychain |
| `state`, `hosts` | the vendor API's state, served by the provider's `fake.js` on 127.0.0.1 for those origins |
| `now`, `clock` | the clock, fixed, or one time per client request, since a retry comes when a token has lapsed |
| `env` | the environment beyond `PATH`; CI variables, for instance |
| `presence` | the person's answers to presence prompts, in order; each one must be asked for |
| `config` | further keys of the provider's own configuration |
| `expect.store`, `expect.state` | what must hold afterwards, as a subset; `null` means absent |

Every transcript of an example must have a scenario, so an exchange added to a page without code behind it fails the run. CI runs it with the rest of the conformance material.

[`lib/`](lib) holds what the three share: the provider side of the protocol ([`protocol.js`](lib/protocol.js)), the provider's own context ([`context.js`](lib/context.js): the store, the clock, the vendor API, presence on the controlling terminal or scripted), and the fake API server ([`fake-server.js`](lib/fake-server.js)).

## What the fakes are

The fakes answer as the vendors document their APIs, where the pages cite them; a call the provider's author recalled rather than read is marked so in a comment in the provider. The corporate gateway is invented, as on its page. None of this has run against a live registry: no secret is needed, and none is in the repository.

## What the transcripts do not pin

Writing the providers showed behaviour the recorded exchanges leave open, so a change to it passes the run:

- **GitLab:** a job token offered for another project (no transcript has one), and the delete on `erase` alone, since the retry's `get` deletes the same token before minting.
- **npmjs.com:** `not-found` against `other` for a provider with nothing stored, a 403 retry from a stage-only token, and a token pasted into `npm login`.
- **Corporate SSO:** the 403 retry when the user's groups are unchanged, and a CI identity without the publisher role.

`Retry-After` on a login poll cannot be expressed: the fake sends no headers, and the npmjs provider polls at the interval its configuration sets.
