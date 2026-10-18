'use strict'
// A reference provider for the corporate SSO gateway of
// examples/corporate-sso.md: an OIDC device-code login at the company IdP,
// a refresh token kept in the store (the OS keychain in a real build), and
// short-lived tokens minted by the gateway per request scope.
//
// What comes from the page: the policy (read per scope, publish per package
// and version with user presence and a step-up no older than 5 minutes, CI
// with a service identity and the npm-publisher role), the messages, and the
// choice of `other` over `not-found` when a credential is withheld.
// ILLUSTRATIVE, invented for the example: the IdP's endpoint paths under the
// configured `idp` origin (conventional OIDC names), the client id, the
// gateway's `-/sso/token` endpoint with its request and response fields
// (`token`, `expires_at` in Unix seconds, `groups`), and the `roles` claim.

const fs = require('node:fs')
const path = require('node:path')
const { serve, ok, err, log } = require('../lib/protocol.js')
const { loadContext } = require('../lib/context.js')

const REGISTRIES = ['https://npm.corp.example.com/', 'https://npm-eu.corp.example.com/']
const CAPABILITIES = ['login', 'logout', 'erase', 'retry-context']
const CLIENT_ID = 'corp-npm-credential-provider'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const STEP_UP_SECONDS = 5 * 60
const ACCESS_MARGIN_SECONDS = 60
// inside npm's 5-minute budget for `login` and an interactive `get`
const WAIT_MS = 4.5 * 60 * 1000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const minutes = (ms) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const start = (args) => {
  const ctx = loadContext(args.config)
  const idp = ctx.config.idp
  // the endpoints come from this configuration, never from a URL npm sends
  const tokenUrl = `${idp}/token`
  // the groups each minted token was issued for, to tell a changed
  // entitlement from an unchanged one on a 403 retry
  const mintedGroups = new Map()
  let identityGrant = null

  const readSession = () => ctx.readStore().session || null
  // `null` stands for a deleted entry in this file store
  const saveSession = (session) => ctx.writeStore({ ...ctx.readStore(), session })

  const nameOf = (req) => (req.scope ? `${req.scope}/${req.package}` : req.package)

  const expiredMessage = (req) =>
    `The corporate SSO session has expired. Run 'npm login --registry ${req.registry}' in a terminal.`

  // --- device flow (RFC 8628, sections 3.1 to 3.5) -------------------------

  const deviceLogin = async () => {
    const started = await ctx.request('POST', `${idp}/device_authorization`, {
      form: { client_id: CLIENT_ID, scope: 'openid offline_access' },
    })
    if (started.status !== 200 || !started.json) {
      throw new Error(`The identity provider did not start a sign-in (HTTP ${started.status}).`)
    }
    const { device_code: deviceCode, user_code: userCode, verification_uri: uri } = started.json
    let interval = started.json.interval ?? 5
    const budget = Math.min((started.json.expires_in ?? 270) * 1000, WAIT_MS)
    const deadline = Date.now() + budget
    ctx.showToPerson(`Open ${uri} and enter the code ${userCode}\nWaiting for approval (${minutes(budget)} left) ...`)
    for (;;) {
      await sleep(Math.min(interval * 1000, Math.max(0, deadline - Date.now())))
      const polled = await ctx.request('POST', tokenUrl, {
        form: { grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: CLIENT_ID },
      })
      if (polled.status === 200 && polled.json) {
        return polled.json
      }
      const code = polled.json && polled.json.error
      if (code === 'access_denied') {
        throw new Error('The sign-in was denied at the identity provider.')
      }
      if (code === 'expired_token') {
        throw new Error('The sign-in code expired before it was approved.')
      }
      if (code === 'slow_down') {
        interval += 5
      } else if (code !== 'authorization_pending') {
        throw new Error(`The identity provider refused the sign-in (HTTP ${polled.status}).`)
      }
      if (Date.now() >= deadline) {
        throw new Error('Stopped waiting for the sign-in after 4 minutes 30 seconds.')
      }
    }
  }

  // a device login: the person has just confirmed at the IdP
  const signIn = async () => {
    const granted = await deviceLogin()
    const now = ctx.now()
    saveSession({
      refreshToken: granted.refresh_token,
      accessToken: granted.access_token,
      accessExpiresAt: now + granted.expires_in,
      interactiveAt: now,
    })
    return granted.access_token
  }

  // --- IdP access tokens ---------------------------------------------------

  // The access token of the stored session: the cached one while it has
  // time left, else a refresh. `invalid_grant` means the login is dead:
  // a device flow where a person is there, `other` where not.
  const sessionAccess = async (req, { force = false } = {}) => {
    const session = readSession()
    const now = ctx.now()
    if (!force && session.accessToken && session.accessExpiresAt - now > ACCESS_MARGIN_SECONDS) {
      return session.accessToken
    }
    const refreshed = await ctx.request('POST', tokenUrl, {
      form: { grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: CLIENT_ID },
    })
    if (refreshed.status === 200 && refreshed.json) {
      saveSession({
        ...session,
        refreshToken: refreshed.json.refresh_token ?? session.refreshToken,
        accessToken: refreshed.json.access_token,
        accessExpiresAt: now + refreshed.json.expires_in,
      })
      return refreshed.json.access_token
    }
    if (refreshed.json && refreshed.json.error === 'invalid_grant') {
      if (!req.interactive) {
        throw new Error(expiredMessage(req))
      }
      return signIn()
    }
    throw new Error(`The identity provider could not renew the session (HTTP ${refreshed.status}).`)
  }

  // CI: the service identity file is the image's, named by this
  // configuration; never the environment or a project file
  const serviceIdentity = () => {
    const file = ctx.config.serviceIdentity
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

  const identityAccess = async (identity, { force = false } = {}) => {
    if (identityGrant && !force) {
      return identityGrant
    }
    const granted = await ctx.request('POST', tokenUrl, {
      form: { grant_type: 'client_credentials', client_id: identity.client_id, client_secret: identity.client_secret },
    })
    if (granted.status !== 200 || !granted.json) {
      throw new Error(`The identity provider refused the service identity (HTTP ${granted.status}).`)
    }
    identityGrant = { token: granted.json.access_token, roles: granted.json.roles || [] }
    return identityGrant
  }

  // --- gateway ---------------------------------------------------------------

  const mint = async (req, access, renew) => {
    const url = new URL('-/sso/token', req.registry).href
    const body = { operation: req.operation, scope: req.scope, package: req.package, version: req.version }
    let answered = await ctx.request('POST', url, { token: access, body })
    if (answered.status === 401) {
      // the IdP access token may have been revoked; one renewal, no login
      answered = await ctx.request('POST', url, { token: await renew(), body })
    }
    if (answered.status === 403) {
      throw new Error(`The gateway would not issue a ${req.operation} token for ${nameOf(req)}.`)
    }
    const minted = answered.json
    if (answered.status !== 200 || !minted || !minted.token) {
      throw new Error(`The gateway did not issue a token (HTTP ${answered.status}).`)
    }
    // Unix seconds; a millisecond value would be a token npm never expires
    if (!Number.isInteger(minted.expires_at) || minted.expires_at >= 1e11) {
      throw new Error('The gateway gave an expiry that is not in Unix seconds.')
    }
    mintedGroups.set(req.scope ?? '', JSON.stringify([...(minted.groups || [])].sort()))
    return ok('get', {
      auth: { type: 'bearer', token: minted.token },
      cache: 'expires',
      expiresAt: minted.expires_at,
      operationIndependent: false,
      granularity: req.operation === 'publish' ? 'package' : 'scope',
    })
  }

  // --- presence ----------------------------------------------------------------

  const confirmWithin = (question, ms) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(null), ms)
      ctx.confirm(question).then(
        (answer) => {
          clearTimeout(timer)
          resolve(answer)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })

  // --- handlers ----------------------------------------------------------------

  const get = async (req) => {
    if (!REGISTRIES.includes(req.registry)) {
      return err('url-not-supported')
    }
    if (req.operation !== 'read' && req.operation !== 'publish') {
      return err('operation-not-supported')
    }
    const publish = req.operation === 'publish'
    const name = nameOf(req)
    if (publish && !req.version) {
      return err('other', `A publish request for ${name} must name a version.`)
    }
    const label = publish ? `${name}@${req.version}` : name

    const identity = serviceIdentity()
    if (identity) {
      let granted = await identityAccess(identity)
      if (publish && !granted.roles.includes('npm-publisher')) {
        return err('other', `The service identity lacks the npm-publisher role that publishing ${label} needs.`)
      }
      return mint(req, granted.token, async () => (granted = await identityAccess(identity, { force: true })).token)
    }

    if (!readSession()) {
      // nobody ever signed in here: nothing to withhold, and no login opened
      return err('not-found')
    }
    if (publish) {
      if (!req.interactive) {
        return err(
          'other',
          `Publishing ${label} needs a device-code confirmation, and no terminal is available. Run npm publish from a terminal, or from the release runner.`,
        )
      }
      if (ctx.now() - (readSession().interactiveAt ?? 0) > STEP_UP_SECONDS) {
        await signIn()
      }
    }

    // a 403 says the entitlement may have changed: renew the IdP claims first
    const rejected = req.retry === true && req.httpStatus === 403
    const access = await sessionAccess(req, { force: rejected })
    if (rejected) {
      const info = await ctx.request('GET', `${idp}/userinfo`, { token: access })
      const current = JSON.stringify([...((info.json && info.json.groups) || [])].sort())
      if (info.status === 200 && mintedGroups.get(req.scope ?? '') === current) {
        return err('other', `The identity provider still gives no access to ${name}; the gateway's refusal stands.`)
      }
    }

    if (publish) {
      const question = `Publish ${label} to ${new URL(req.registry).host}?`
      const answer = await confirmWithin(question, WAIT_MS)
      if (answer === null) {
        return err('other', `Publishing ${label} was not confirmed within 4 minutes 30 seconds.`)
      }
      if (!answer) {
        return err('other', `Publishing ${label} was not confirmed.`)
      }
    }
    return mint(req, access, () => sessionAccess(req, { force: true }))
  }

  // Drops what was handed to npm and the access token kept for it; the
  // refresh token is `login`'s and only `logout` removes it.
  const erase = async () => {
    const session = readSession()
    if (session) {
      saveSession({ ...session, accessToken: null, accessExpiresAt: null })
    }
    return ok('erase')
  }

  const login = async (req) => {
    if (!REGISTRIES.includes(req.registry)) {
      return err('url-not-supported')
    }
    if (!req.interactive) {
      return err('other', 'Signing in needs a terminal, and none is available.')
    }
    await signIn()
    return ok('login')
  }

  // best effort at the IdP (RFC 7009), then the entry is gone for both hosts
  const logout = async (req) => {
    if (!REGISTRIES.includes(req.registry)) {
      return err('url-not-supported')
    }
    const session = readSession()
    if (session) {
      try {
        const revoked = await ctx.request('POST', `${idp}/revoke`, {
          form: { token: session.refreshToken, client_id: CLIENT_ID },
        })
        if (revoked.status !== 200) {
          log(`could not revoke the session at the identity provider (HTTP ${revoked.status})`)
        }
      } catch (error) {
        log(`could not reach the identity provider to revoke the session: ${error.message}`)
      }
      saveSession(null)
    }
    return ok('logout')
  }

  return {
    hello: { v: [1], capabilities: CAPABILITIES, registries: REGISTRIES },
    handlers: { get, erase, login, logout },
  }
}

serve(start)
