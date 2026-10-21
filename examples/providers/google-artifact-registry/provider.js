'use strict'
// A reference provider for the Google Artifact Registry example
// (examples/google-artifact-registry.md): a sign-in kept in a private gcloud
// configuration (a JSON file here, the provider's own CLOUDSDK_CONFIG
// directory in a real build), and short-lived access tokens made out of it by
// impersonating a reader or a writer service account; in CI the federated
// identity the job holds, exchanged at the Security Token Service.
//
// What comes from the page: the policy (reader for `read`, writer for
// `publish` and `deprecate` after a presence prompt and only when
// `interactive` is true, no prompt for a machine identity in CI), the refusal
// of every other operation, no revoke on `erase` (`logout` revokes the
// provider's own sign-in only), no widening on a 403, a
// lapsed sign-in answered `other`, and the expiry taken from Google's answer,
// never from `now + 3600`.
// SIMPLIFIED, so that it can run without gcloud (the page says so, under
// Configuration): the page has the provider run `gcloud auth login` and
// `gcloud auth application-default login` against its own configuration; here
// one sign-in, the one a token is made from (the second's), is Google's
// OAuth 2.0 flow for desktop apps against the configured endpoints: the
// authorization URL is shown on the controlling terminal, the redirect comes
// to a listener on 127.0.0.1 on a random port, PKCE (S256) protects the code,
// and the code is exchanged at the token endpoint. A token is made through a
// refresh grant of the stored sign-in (the library call the page names) and
// the IAM Credentials API. In CI only the federated identity of a credentials
// file the configuration names is used, not the metadata server's, and a 403
// retry is answered `other` for every operation: there is no `repoAdmin`
// identity to move up to. Read in Google's "OAuth 2.0 for Desktop Apps" page:
// the authorization endpoint and its parameters, the loopback redirect, the
// token request's fields and the revoke endpoint (`client_secret` is optional
// there, and the provider sends the one its configuration holds, if any).
// Not confirmed: that Google puts `state` in the query of a loopback redirect
// (the page's `state` entry says fragment, which no listener receives) and
// the exact `error` Google gives for a code that is spent or expired; the
// other paths and fields are recalled, not read (see fake.js); the client id
// is invented.

const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { serve, ok, err, log } = require('../lib/protocol.js')
const { loadContext, plain } = require('../lib/context.js')

const CAPABILITIES = ['erase', 'login', 'logout', 'retry-context']
const CLIENT_ID = 'example-gar-provider-client'
const EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform'
const OAUTH = 'https://oauth2.googleapis.com'
const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth'
const IAM = 'https://iamcredentials.googleapis.com'
const STS = 'https://sts.googleapis.com'
const ACCESS_MARGIN_SECONDS = 60
// inside npm's 5-minute budget for `login` and an interactive `get`
const WAIT_MS = 4.5 * 60 * 1000
const WRITE_VERBS = { publish: 'Publish', deprecate: 'Deprecate' }
const SERVED = new Set(['read', ...Object.keys(WRITE_VERBS)])
// What the pages read describe nothing for (an absence, not a refusal)
const ABSENT = {
  owner: 'owners',
  access: 'access settings',
  trust: 'trusted publishers',
  account: 'accounts',
  stage: 'staging',
  'stage-read': 'staging',
  'stage-reject': 'staging',
}

class Lapsed extends Error {}
class Failed extends Error {}

const start = (args) => {
  const ctx = loadContext(args.config)
  const repositories = ctx.config.repositories || {}
  // what this process handed out or fetched, dropped by `erase`
  const readTokens = new Map()
  let userAccess = null

  const gcloud = () => ctx.readStore().gcloud || null

  const lapsedMessage = (req) =>
    `The sign-in behind this provider has lapsed and needs a new one. Run npm login for ${req.registry}.`

  // --- the person's sign-in ----------------------------------------------------

  // The client the provider signs in as. A desktop client's secret is not one: Google's page calls
  // desktop apps public clients that cannot keep a secret, and marks `client_secret` optional, so
  // it is sent when the configuration holds one.
  const client = () => ({ client_id: CLIENT_ID, ...(ctx.config.clientSecret ? { client_secret: ctx.config.clientSecret } : {}) })

  // Google's flow for desktop apps, for the sign-in `npm login` needs, inside the deadline of the
  // login request: a listener on the loopback address, the authorization URL shown on the
  // controlling terminal, then the code the redirect brings exchanged for tokens. What comes back
  // is the refresh token.
  const loopbackFlow = async (deadline) => {
    const failed = (reason) => new Failed(`The sign-in did not finish: ${reason}. Nothing was stored. Run npm login again.`)
    const verifier = crypto.randomBytes(48).toString('base64url')
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
    const state = crypto.randomBytes(16).toString('base64url')
    let arrive
    const arrived = new Promise((resolve) => {
      arrive = resolve
    })
    // Only the answer to this request counts: whatever else reaches the port (a stray request, a
    // page that guessed it) is refused, since the redirect address can be guessed and `state` is
    // what ties an answer to the request
    const server = http.createServer((req, res) => {
      const query = new URL(req.url, 'http://127.0.0.1').searchParams
      if (req.method !== 'GET' || query.get('state') !== state || !(query.has('code') || query.has('error'))) {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end('This is not the answer to the sign-in npm started.\n')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('You can close this window and return to the terminal.\n')
      arrive({ code: query.get('code'), error: query.get('error') })
    })
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
    } catch (error) {
      throw new Failed(`The sign-in could not listen on the loopback address (${plain(error.code || error.message)}). Nothing was stored.`)
    }
    const redirectUri = `http://127.0.0.1:${server.address().port}`
    let outcome
    try {
      const url = `${AUTHORIZE}?${new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: CLOUD_PLATFORM,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      })}`
      if (!ctx.showToPerson(`Open ${plain(url)} to sign in`, { browse: url })) {
        // nothing the person could finish: no request has been made, and nothing is waiting at Google
        throw new Failed('There is no terminal to show the sign-in on, so no sign-in was started. Nothing was stored. Run npm login from a terminal.')
      }
      outcome = await ctx.withDeadline(() => arrived, Math.max(0, deadline - ctx.clockMs()))
    } finally {
      server.closeAllConnections()
      server.close()
    }
    if (outcome === null) {
      throw failed('no sign-in was completed in 4 minutes 30 seconds')
    }
    if (outcome.error === 'access_denied') {
      throw failed('the sign-in was denied')
    }
    if (outcome.error || !outcome.code) {
      throw failed(`Google refused the sign-in (${plain(outcome.error || 'no code')})`)
    }
    const exchanged = await ctx.request('POST', `${OAUTH}/token`, {
      form: { ...client(), code: outcome.code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' },
    })
    if (exchanged.status !== 200 || !exchanged.json) {
      const code = exchanged.json && exchanged.json.error
      throw failed(`Google refused the authorization code (${code ? plain(code) : `HTTP ${exchanged.status}`})`)
    }
    if (!exchanged.json.refresh_token) {
      // an access token alone would be lost within the hour: there is nothing to store
      throw failed('Google approved the sign-in but gave no refresh token')
    }
    return exchanged.json.refresh_token
  }

  // The access token of the stored sign-in: the held one while it has time
  // left, else a refresh grant. A refusal means the login has lapsed (Google
  // lets an organization end a session after a set time).
  const userToken = async ({ force }) => {
    const adc = gcloud() && gcloud().adc
    if (!adc) {
      throw new Lapsed()
    }
    const now = ctx.now()
    if (!force && userAccess && userAccess.expiresAt - now > ACCESS_MARGIN_SECONDS) {
      return userAccess.token
    }
    const refreshed = await ctx.request('POST', `${OAUTH}/token`, {
      form: { grant_type: 'refresh_token', refresh_token: adc.refreshToken, ...client() },
    })
    // Google refuses a refresh grant that has ended with 400 (invalid_grant) or 401; any
    // other answer, a 5xx or a 429, is no refusal and says nothing about the sign-in
    if (refreshed.status === 400 || refreshed.status === 401) {
      throw new Lapsed()
    }
    if (refreshed.status !== 200 || !refreshed.json || !refreshed.json.access_token || !Number.isInteger(refreshed.json.expires_in)) {
      throw new Failed(`Google answered ${refreshed.status} to refreshing the sign-in, so nothing is known about it. Try again, and run npm login only if Google then refuses it.`)
    }
    userAccess = { token: refreshed.json.access_token, expiresAt: now + refreshed.json.expires_in }
    return userAccess.token
  }

  // --- tokens ------------------------------------------------------------------

  // Impersonation through the IAM Credentials API: the expiry is the one
  // Google gives back.
  const impersonate = async (identity, force) => {
    const access = await userToken({ force })
    const url = `${IAM}/v1/projects/-/serviceAccounts/${encodeURIComponent(identity.serviceAccount)}:generateAccessToken`
    const minted = await ctx.request('POST', url, {
      token: access,
      body: { scope: [CLOUD_PLATFORM], lifetime: `${identity.lifetime}s` },
    })
    if (minted.status === 401) {
      throw new Lapsed()
    }
    const expiresAt = minted.json && Math.floor(Date.parse(minted.json.expireTime) / 1000)
    if (minted.status !== 200 || !minted.json || !minted.json.accessToken || !Number.isInteger(expiresAt)) {
      throw new Failed(
        `Google would not issue a token for ${identity.serviceAccount} (HTTP ${minted.status}). Check that the sign-in may impersonate it.`,
      )
    }
    return { token: minted.json.accessToken, expiresAt }
  }

  // CI: the federated identity the job holds, named by this configuration and
  // never by the environment's GOOGLE_APPLICATION_CREDENTIALS. The variable
  // `CI` does switch it on, and with it the end of the presence prompt, so the
  // identity is used only if the file the configuration names exists: on a
  // workstation it must not, and a `CI=true` that a script exports then gets
  // nothing from here.
  const federatedIdentity = () => {
    const file = ctx.config.adc
    if (!file || !process.env.CI || process.env.CI === 'false') {
      return null
    }
    try {
      return JSON.parse(fs.readFileSync(path.resolve(__dirname, file), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  const exchange = async (federated) => {
    const now = ctx.now()
    const answered = await ctx.request('POST', `${STS}/v1/token`, {
      form: {
        grant_type: EXCHANGE_GRANT,
        audience: federated.audience,
        subject_token: federated.subject_token,
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        scope: CLOUD_PLATFORM,
      },
    })
    if (answered.status !== 200 || !answered.json || !answered.json.access_token || !Number.isInteger(answered.json.expires_in)) {
      throw new Failed(`The job's federated identity could not be exchanged for a token (HTTP ${answered.status}). Check the workload identity setup of the job.`)
    }
    return { token: answered.json.access_token, expiresAt: now + answered.json.expires_in }
  }

  // --- handlers ----------------------------------------------------------------

  const get = async (req) => {
    if (!Object.hasOwn(repositories, req.registry)) {
      return err('url-not-supported')
    }
    if (!SERVED.has(req.operation)) {
      if (Object.hasOwn(ABSENT, req.operation)) {
        return err('operation-not-supported', `The Artifact Registry pages describe no npm ${ABSENT[req.operation]}; this provider serves none.`)
      }
      return err('operation-not-supported', `Whether Artifact Registry serves npm ${req.operation} is not documented; this provider does not map it.`)
    }
    const write = Object.hasOwn(WRITE_VERBS, req.operation)
    const name = req.scope ? `${req.scope}/${req.package}` : req.package
    // A machine identity is released with no presence, and the CI variable that selects it
    // is the environment's, which a terminal can set too: so only a request that is not
    // interactive (npm decides that from the process and no CI) may take it. An
    // interactive one takes the person's sign-in and the presence prompt.
    const federated = req.interactive ? null : federatedIdentity()
    const tier = repositories[req.registry][write ? 'write' : 'read']
    if (!federated && !tier) {
      return err('other', `This provider has no ${write ? 'writer' : 'reader'} identity configured for ${req.registry}.`)
    }

    // A 403 follows no erase and no other token would help: a role, a grant
    // not yet applied, a perimeter. It names the principal, never the token.
    if (req.retry === true && req.httpStatus === 403) {
      const principal = federated ? "the job's federated identity" : tier.serviceAccount
      return err('other', `The registry refused the ${req.operation} for ${principal}. Check its roles on the repository; a grant can take a few minutes to apply.`)
    }

    const forced = req.retry === true
    try {
      if (federated) {
        // a machine identity: no presence, whatever `interactive` says
        const held = readTokens.get(req.registry)
        const minted = !write && !forced && held && held.expiresAt - ctx.now() > ACCESS_MARGIN_SECONDS ? held : await exchange(federated)
        if (!write) {
          readTokens.set(req.registry, minted)
        }
        return granted(minted)
      }

      if (!gcloud()) {
        // nobody ever signed in here: nothing to withhold, and no login opened
        return forced
          ? err('other', `This provider holds no sign-in. Run npm login for ${req.registry}.`)
          : err('not-found')
      }
      if (write) {
        if (!req.interactive) {
          return err(
            'other',
            `The ${req.operation} of ${name} needs a presence prompt, and no terminal is available. Run npm ${req.operation} from a terminal, or from CI under a machine identity.`,
          )
        }
        const label = req.version ? `${name}@${req.version}` : name
        const question = `${WRITE_VERBS[req.operation]} ${plain(label)} ${req.operation === 'publish' ? 'to' : 'in'} ${new URL(req.registry).host}${new URL(req.registry).pathname}?`
        let answer
        try {
          answer = await ctx.confirmWithin(question, WAIT_MS)
        } catch (error) {
          if (error.syscall === 'open') {
            // the terminal cannot be opened: say so instead of passing the OS error on
            return err('other', `The ${req.operation} of ${name} needs a presence prompt, and the terminal cannot be opened. Run npm ${req.operation} from a terminal, or from CI under a machine identity.`)
          }
          throw error
        }
        if (answer === null) {
          return err('other', `The ${req.operation} of ${name} was not confirmed within 4 minutes 30 seconds. No credential was released.`)
        }
        if (!answer) {
          return err('other', `The ${req.operation} of ${name} was not confirmed. No credential was released.`)
        }
      } else {
        const held = readTokens.get(req.registry)
        if (!forced && held && held.expiresAt - ctx.now() > ACCESS_MARGIN_SECONDS) {
          return granted(held)
        }
      }
      const minted = await impersonate(tier, forced)
      if (!write) {
        readTokens.set(req.registry, minted)
      }
      return granted(minted)
    } catch (error) {
      if (error instanceof Lapsed) {
        return err('other', lapsedMessage(req))
      }
      if (error instanceof Failed) {
        return err('other', error.message)
      }
      throw error
    }
  }

  // `operationIndependent: false` on every answer: the writes are bound to their
  // operation anyway, and a `read` answer left at the default would be found by a
  // later `publish` on the same repository, which a reader token cannot serve
  // (and which, for a person, would skip the presence prompt)
  const granted = (minted) =>
    ok('get', {
      auth: { type: 'bearer', token: minted.token },
      cache: 'expires',
      expiresAt: minted.expiresAt,
      granularity: 'registry',
      operationIndependent: false,
    })

  // Google's revoke endpoint: the token in a form. Best effort.
  const revoke = async (token, what) => {
    try {
      const res = await ctx.request('POST', `${OAUTH}/revoke`, { form: { token } })
      if (res.status !== 200) {
        log(`${what}: Google answered ${res.status} to revoking the sign-in; it stays valid until revoked at myaccount.google.com`)
      }
    } catch {
      log(`${what}: the sign-in could not be revoked`)
    }
  }

  // Drops what this process holds. No revoke call: revoking an access token
  // that has a refresh token behind it would sign the user out of gcloud, and
  // the stored sign-in is `login`'s, which only `logout` removes.
  const erase = async (req) => {
    if (!Object.hasOwn(repositories, req.registry)) {
      return err('url-not-supported')
    }
    readTokens.clear()
    userAccess = null
    return ok('erase')
  }

  const login = async (req) => {
    if (!Object.hasOwn(repositories, req.registry)) {
      return err('url-not-supported')
    }
    if (req.token !== undefined) {
      return err('other', 'A token given to npm login is a one-hour access token and not worth storing; this provider signs the person in itself, so run npm login with no token.')
    }
    if (!req.interactive) {
      return err('other', 'Signing in needs a terminal, and none is available.')
    }
    const deadline = ctx.clockMs() + WAIT_MS
    let refreshToken
    try {
      refreshToken = await loopbackFlow(deadline)
    } catch (error) {
      if (error instanceof Failed) {
        return err('other', error.message)
      }
      throw error
    }
    const replaced = gcloud() && gcloud().adc && gcloud().adc.refreshToken
    ctx.writeStore({ ...ctx.readStore(), gcloud: { adc: { refreshToken } } })
    readTokens.clear()
    userAccess = null
    // a sign-in that is no longer kept is one nobody can revoke later
    if (replaced && replaced !== refreshToken) {
      await revoke(replaced, 'login')
    }
    return ok('login')
  }

  // Removes only what the provider created: its own sign-in, here the `gcloud` entry of its
  // store and in a real build its own configuration directory. Never `gcloud auth revoke`
  // on the shared configuration, never the user's own ADC file. The sign-in is the
  // provider's own grant, so revoking its refresh token at Google signs the user out of
  // nothing else. The entry goes first, so that a slow Google cannot keep it, and the
  // revocation is a best effort.
  const logout = async (req) => {
    if (!Object.hasOwn(repositories, req.registry)) {
      return err('url-not-supported')
    }
    const { gcloud: removed, ...rest } = ctx.readStore()
    if (!removed) {
      // nothing was ever signed in here: nothing to remove, which is what `not-found` says
      return err('not-found')
    }
    ctx.writeStore(rest)
    readTokens.clear()
    userAccess = null
    if (removed.adc && removed.adc.refreshToken) {
      await revoke(removed.adc.refreshToken, 'logout')
    }
    return ok('logout')
  }

  return {
    hello: { v: [1], capabilities: CAPABILITIES, registries: Object.keys(repositories) },
    handlers: { get, erase, login, logout },
  }
}

serve(start)
