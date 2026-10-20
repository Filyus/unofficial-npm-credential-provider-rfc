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
// of every other operation, no revoke on `erase`, no widening on a 403, a
// lapsed sign-in answered `other`, and the expiry taken from Google's answer,
// never from `now + 3600`.
// SIMPLIFIED, so that it can run without gcloud: the page has the provider
// run `gcloud auth login` and `gcloud auth application-default login` against
// its own configuration; here each is Google's device authorization flow
// against the configured endpoints, and a token is made through a refresh
// grant of the stored sign-in (the library call the page names) and the IAM
// Credentials API. The endpoint paths and fields are recalled, not read
// (see fake.js); the client id is invented.

const fs = require('node:fs')
const path = require('node:path')
const { serve, ok, err } = require('../lib/protocol.js')
const { loadContext } = require('../lib/context.js')

const CAPABILITIES = ['erase', 'login', 'logout', 'retry-context']
const CLIENT_ID = 'example-gar-provider-client'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange'
const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform'
const OAUTH = 'https://oauth2.googleapis.com'
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
    `The sign-in behind this provider's gcloud configuration has lapsed and needs a new one. Run npm login for ${req.registry}.`

  // --- the person's sign-in ----------------------------------------------------

  // Google's device flow, for one of the two sign-ins `npm login` needs. Both
  // share the deadline of the login request.
  const deviceFlow = async (command, deadline) => {
    const failed = (reason) => new Failed(`${command} did not finish: ${reason}. Nothing was stored. Run npm login again.`)
    const started = await ctx.request('POST', `${OAUTH}/device/code`, {
      form: { client_id: CLIENT_ID, scope: CLOUD_PLATFORM },
    })
    if (started.status !== 200 || !started.json) {
      throw failed(`Google did not start a sign-in (HTTP ${started.status})`)
    }
    const { device_code: deviceCode, user_code: userCode, verification_url: url } = started.json
    let interval = started.json.interval ?? 5
    ctx.showToPerson(`Open ${url} and enter the code ${userCode}`)
    for (;;) {
      await ctx.sleep(Math.min(interval * 1000, Math.max(0, deadline - ctx.clockMs())))
      const polled = await ctx.request('POST', `${OAUTH}/token`, {
        form: { grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: CLIENT_ID },
      })
      if (polled.status === 200 && polled.json) {
        return polled.json.refresh_token
      }
      const code = polled.json && polled.json.error
      if (code === 'access_denied') {
        throw failed('the sign-in was denied')
      }
      if (code === 'expired_token') {
        throw failed('the sign-in code expired before it was approved')
      }
      if (code === 'slow_down') {
        interval += 5
      } else if (code !== 'authorization_pending') {
        throw failed(`Google refused the sign-in (HTTP ${polled.status})`)
      }
      if (ctx.clockMs() >= deadline) {
        throw failed('no sign-in was completed in 4 minutes 30 seconds, so gcloud was stopped')
      }
    }
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
      form: { grant_type: 'refresh_token', refresh_token: adc.refreshToken, client_id: CLIENT_ID },
    })
    if (refreshed.status !== 200 || !refreshed.json || !refreshed.json.access_token) {
      throw new Lapsed()
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
    if (minted.status !== 200 || !minted.json.accessToken || !Number.isInteger(expiresAt)) {
      throw new Failed(
        `Google would not issue a token for ${identity.serviceAccount} (HTTP ${minted.status}). Check that the sign-in may impersonate it.`,
      )
    }
    return { token: minted.json.accessToken, expiresAt }
  }

  // CI: the federated identity the job holds, named by this configuration and
  // never by the environment's GOOGLE_APPLICATION_CREDENTIALS. The variable
  // `CI` only says that nobody is at a terminal.
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

  const confirmWithin = (question, ms) => ctx.withDeadline((signal) => ctx.confirm(question, signal), ms)

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
    if (req.operation === 'publish' && !req.version) {
      return err('other', `A publish request for ${name} must name a version.`)
    }
    const federated = federatedIdentity()
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
        return granted(minted, write)
      }

      if (!gcloud()) {
        // nobody ever signed in here: nothing to withhold, and no login opened
        return forced
          ? err('other', `This provider's gcloud configuration holds no sign-in. Run npm login for ${req.registry}.`)
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
        const question = `${WRITE_VERBS[req.operation]} ${label} ${req.operation === 'publish' ? 'to' : 'in'} ${new URL(req.registry).host}${new URL(req.registry).pathname}?`
        const answer = await confirmWithin(question, WAIT_MS)
        if (answer === null) {
          return err('other', `The ${req.operation} of ${name} was not confirmed within 4 minutes 30 seconds.`)
        }
        if (!answer) {
          return err('other', `The ${req.operation} of ${name} was not confirmed.`)
        }
      } else {
        const held = readTokens.get(req.registry)
        if (!forced && held && held.expiresAt - ctx.now() > ACCESS_MARGIN_SECONDS) {
          return granted(held, false)
        }
      }
      const minted = await impersonate(tier, forced)
      if (!write) {
        readTokens.set(req.registry, minted)
      }
      return granted(minted, write)
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

  const granted = (minted, write) =>
    ok('get', {
      auth: { type: 'bearer', token: minted.token },
      cache: 'expires',
      expiresAt: minted.expiresAt,
      granularity: 'registry',
      ...(write ? { operationIndependent: false } : {}),
    })

  // Drops what this process holds. No revoke call: revoking an access token
  // that has a refresh token behind it would sign the user out of gcloud, and
  // the stored sign-in is `login`'s, which only `logout` removes.
  const erase = async () => {
    readTokens.clear()
    userAccess = null
    return ok('erase')
  }

  const login = async (req) => {
    if (!Object.hasOwn(repositories, req.registry)) {
      return err('url-not-supported')
    }
    if (req.token !== undefined) {
      return err('other', 'A token given to npm login is a one-hour access token and not worth storing; this provider signs in with gcloud.')
    }
    if (!req.interactive) {
      return err('other', 'Signing in needs a terminal, and none is available.')
    }
    const deadline = ctx.clockMs() + WAIT_MS
    try {
      const credentials = await deviceFlow('gcloud auth login', deadline)
      const adc = await deviceFlow('gcloud auth application-default login', deadline)
      ctx.writeStore({ ...ctx.readStore(), gcloud: { credentials: { refreshToken: credentials }, adc: { refreshToken: adc } } })
    } catch (error) {
      if (error instanceof Failed) {
        return err('other', error.message)
      }
      throw error
    }
    readTokens.clear()
    userAccess = null
    return ok('login')
  }

  // Removes only what the provider created: its own configuration. Never
  // `gcloud auth revoke`, never the user's own ADC file.
  const logout = async (req) => {
    if (!Object.hasOwn(repositories, req.registry)) {
      return err('url-not-supported')
    }
    const { gcloud: removed, ...rest } = ctx.readStore()
    if (removed) {
      ctx.writeStore(rest)
    }
    readTokens.clear()
    userAccess = null
    return ok('logout')
  }

  return {
    hello: { v: [1], capabilities: CAPABILITIES, registries: Object.keys(repositories) },
    handlers: { get, erase, login, logout },
  }
}

serve(start)
