# Which npmjs.com tokens read `/-/stage`

A live test for the one question the RFC leaves to evidence: which token tiers npmjs.com accepts on the staged-publishing reads. The answer sets a provider's default `stage-read` mapping on npmjs.com ([Operations](rfc-credential-provider.md#4-operations)); it changes nothing in the protocol. The documentation names no tier: the API lists granular tokens on every `/-/stage` path and documents 401 as the only refusal on the list, and 401 and 404 on the record and the tarball ([API](https://api-docs.npmjs.com/)).

It needs an npmjs.com account and real tokens, so it is run by hand.

## Setup

- An npmjs.com account with 2FA.
- A package P the account already maintains, preferably a throwaway scoped one, so no public placeholder is created; and a second maintained package Q.
- Note P's publishing-access setting. If possible, run T2 and T3 twice: with "Require 2FA" alone and with "Require 2FA and disallow tokens", staging S (below) before switching to the second, since a token presumably cannot stage under it.

## Tokens

Bypass-2FA off unless stated:

| Token | Kind |
|---|---|
| T1 | Session token from `npm login` (web flow) |
| T2 | Granular, packages read-only, selected to P |
| T3 | Granular, read and write (stage only), P |
| T4 | Granular, read and write (publish and stage), P |
| T5 | Granular, read-only, selected to Q only |
| T6 | Granular with no package access, if the site allows one; otherwise note that it does not |
| T3b | Optional: T3 with bypass-2FA on |

## Stage one version

In P, run `npm stage publish` with T3 through a throwaway userconfig, which gives a stage id S. Note whether it asks for a one-time password. Confirm S with `npm stage list` under T4. The staged version need not be a real build: `node poc/stage-tiers/run.js pack <dir> <P> 0.0.0-tokentest.1` writes a package whose README says not to approve it, under the dist-tag `tokentest`. If P's publishing access disallows tokens, T3 cannot stage; stage under T1 and note it.

## Requests

Keep each token out of argv and shell history: put `Authorization: Bearer <token>` in a file `hdr.txt` written with an editor (or under `umask 077`), never with `echo` and the token on the command line, then run `curl -sS -D- -H @hdr.txt <url>`.

| Request | URL |
|---|---|
| R1 | `https://registry.npmjs.org/-/stage?page=0&perPage=100` |
| R2 | R1 plus `&package=<P, URL-encoded>` |
| R3 | `https://registry.npmjs.org/-/stage/S` |
| R4 | `https://registry.npmjs.org/-/stage/S/tarball` (with `-o /dev/null`) |

For each token and request, record the status, the item count or error body, and every `WWW-Authenticate` header. Control: R1–R4 with no `Authorization`, expected 401.

`node poc/stage-tiers/run.js check <token-dir> S <P>` does all of this: it reads each token from its own file (`T2.txt`, or the `T1.npmrc` that `npm login --userconfig` writes), sends it only to registry.npmjs.org, follows no redirect, redacts it from every body, and writes the table to `results.json` in that directory.

## Reading the results

- **T3 and T4** should give 200 with S on R1–R4. If T3 fails where T4 passes, a stage-only token cannot read its own staged versions. The RFC never answers `stage-read` with a credential that can publish directly, so provider users on npmjs.com then cannot run `stage list`, `view`, `download`, `approve` or `reject`: record that as a gap to report to npm, not as a default.
- **T2** decides it:
  - 200 with S on R1–R4: providers map `stage-read` to a separate read-only token, with no presence check, and it works in CI.
  - 401 or 403: write-capable tokens only, and the RFC's write-policy rule applies. Note which of the two arrives; a 403 is what a provider may widen on.
  - 200 with an empty list, and 404 on R3 and R4: the visibility filter works by tier; same conclusion, and it confirms the RFC's "a 401, a 404 or an empty list".
- **A 401 with `WWW-Authenticate: otp`** on any read is a one-time-password challenge, not a tier refusal ([erase table](rfc-credential-provider.md#erase-a-credential-was-rejected)), and changes how the T2 row reads.
- **T1:** 200 means session tokens work despite the API's security list; 401 means providers need a granular token.
- **T5:** provided Q has no staged versions, expected an empty list and 404, confirming that a token selected to other packages fails as 404 or an empty list, not 403.
- **T6:** record the outcome. **T3b** against T3: expected the same.

## Cleanup

`npm stage reject S` under T1 or T4 with a one-time password (do not approve it); revoke T2–T6 and T3b; `npm logout` for T1; delete `hdr.txt` and the throwaway userconfig.
