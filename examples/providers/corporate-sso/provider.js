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
const { loadContext, plain } = require('../lib/context.js')

const REGISTRIES = ['https://npm.corp.example.com/', 'https://npm-eu.corp.example.com/']
const CAPABILITIES = ['login', 'logout', 'erase']
const CLIENT_ID = 'corp-npm-credential-provider'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const STEP_UP_SECONDS = 5 * 60
const ACCESS_MARGIN_SECONDS = 60
// inside npm's 5-minute budget for `login` and an interactive `get`: one
// deadline per request, shared by a device sign-in and a presence prompt
const WAIT_MS = 4.5 * 60 * 1000
// What the gateway's publish policy covers: user presence and a step-up no
// older than 5 minutes (the npm-publisher role in CI), and a token bound to
// the package. The page says `dist-tag`, `deprecate` and `unpublish` follow
// it; every other operation (`stage`, `trust`, `access`, ...) is not in the
// gateway.
const WRITE_VERBS = {
  publish: 'Publish',
  'dist-tag': 'Change the dist-tags of',
  deprecate: 'Deprecate',
  unpublish: 'Unpublish',
}

// A device or refresh grant that answers 200 must answer with what a session is
// made of; a missing field would be stored as `undefined` and an expiry of NaN.
const hasTokens = (granted, withRefresh) =>
  granted &&
  typeof granted.access_token === 'string' &&
  granted.access_token !== '' &&
  Number.isFinite(granted.expires_in) &&
  granted.expires_in > 0 &&
  (!withRefresh || (typeof granted.refresh_token === 'string' && granted.refresh_token !== ''))

// Inside the timeout npm gives each kind of request (RFC, Session lifecycle): an
// interactive `get` and `login` wait for a person, the others do not.
const budgetMs = (req) => {
  if (req.kind === 'erase') {
    return 8 * 1000
  }
  if (req.kind === 'logout' || (req.kind === 'get' && !req.interactive)) {
    return 25 * 1000
  }
  return WAIT_MS
}

const minutes = (ms) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// 270000 -> "4 minutes 30 seconds"
const spoken = (ms) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const part = (n, unit) => (n ? [`${n} ${unit}${n === 1 ? '' : 's'}`] : [])
  return [...part(Math.floor(seconds / 60), 'minute'), ...part(seconds % 60, 'second')].join(' ') || '0 seconds'
}

const start = (args) => {
  const ctx = loadContext(args.config)
  const idp = ctx.config.idp
  // the IdP's endpoints come from this configuration, never from a URL npm sends
  const tokenUrl = `${idp}/token`
  // the time (on the context's clock) by which the request in hand must be
  // answered; every call to the IdP or the gateway is held to it
  let deadline = Infinity
  const call = (method, url, options) => ctx.request(method, url, { ...options, until: deadline === Infinity ? undefined : deadline })
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

  // `until`: the request's deadline, in clock milliseconds
  const deviceLogin = async (req, until) => {
    const started = await call('POST', `${idp}/device_authorization`, {
      form: { client_id: CLIENT_ID, scope: 'openid offline_access' },
    })
    if (started.status !== 200 || !started.json) {
      throw new Error(`The identity provider did not start a sign-in (HTTP ${started.status}).`)
    }
    const { device_code: deviceCode, user_code: userCode, verification_uri: uri } = started.json
    let interval = started.json.interval ?? 5
    const budget = Math.min((started.json.expires_in ?? 270) * 1000, Math.max(0, until - ctx.clockMs()))
    // a request that has no time left shows nothing and polls nothing
    if (budget <= 0) {
      throw new Error('There was no time left in this request to sign in.')
    }
    const flowEnd = ctx.clockMs() + budget
    // nobody can finish a sign-in that was not shown: stop before the first
    // poll, with nothing stored (the unused device code lapses at the IdP)
    if (!ctx.showToPerson(`Open ${plain(uri)} and enter the code ${plain(userCode)}\nWaiting for approval (${minutes(budget)} left) ...`)) {
      throw new Error(`There is no terminal to show the sign-in on; run 'npm login --registry ${req.registry}' from a terminal.`)
    }
    for (;;) {
      await ctx.sleep(Math.min(interval * 1000, Math.max(0, flowEnd - ctx.clockMs())))
      // a poll that hangs is cut at 15 s, so the last one, which can start at the end of
      // the request's budget, still ends inside npm's 5 minutes
      const polled = await ctx.request('POST', tokenUrl, {
        timeoutMs: 15000,
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
      if (ctx.clockMs() >= flowEnd) {
        throw new Error(`Stopped waiting for the sign-in after ${spoken(budget)}.`)
      }
    }
  }

  // a device login: the person has just confirmed at the IdP
  const signIn = async (req, until) => {
    const granted = await deviceLogin(req, until ?? ctx.clockMs() + WAIT_MS)
    if (!hasTokens(granted, true)) {
      throw new Error('The identity provider approved the sign-in but did not send a complete session; nothing was stored.')
    }
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
  // `login: false`: a dead login is `other` even where a person is there, for a renewal
  // that comes after the person has already been asked something
  const sessionAccess = async (req, { force = false, until, login = true } = {}) => {
    const session = readSession()
    const now = ctx.now()
    if (!force && session.accessToken && session.accessExpiresAt - now > ACCESS_MARGIN_SECONDS) {
      return session.accessToken
    }
    const refreshed = await call('POST', tokenUrl, {
      form: { grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: CLIENT_ID },
    })
    if (refreshed.status === 200 && hasTokens(refreshed.json, false)) {
      saveSession({
        ...session,
        refreshToken: typeof refreshed.json.refresh_token === 'string' && refreshed.json.refresh_token ? refreshed.json.refresh_token : session.refreshToken,
        accessToken: refreshed.json.access_token,
        accessExpiresAt: now + refreshed.json.expires_in,
      })
      return refreshed.json.access_token
    }
    if (refreshed.json && refreshed.json.error === 'invalid_grant') {
      if (!req.interactive || !login) {
        throw new Error(expiredMessage(req))
      }
      return signIn(req, until)
    }
    throw new Error(
      refreshed.status === 200
        ? 'The identity provider renewed the session without a usable access token.'
        : `The identity provider could not renew the session (HTTP ${refreshed.status}).`,
    )
  }

  // CI: the service identity file is the image's, named by this
  // configuration; never the environment or a project file. The environment
  // only says that this is a CI run (`CI` is set, as npm's own detection
  // reads it), so a developer machine with the setting does not use it.
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
    const granted = await call('POST', tokenUrl, {
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
    // `req.registry` is one of REGISTRIES here (get checked it), so this is a constant of
    // the provider's: the gateway is never at an address that came from npm
    const url = new URL('-/sso/token', req.registry).href
    const body = { operation: req.operation, scope: req.scope, package: req.package, version: req.version }
    let answered = await call('POST', url, { token: access, body })
    if (answered.status === 401) {
      // the IdP access token may have been revoked; one renewal, no login
      answered = await call('POST', url, { token: await renew(), body })
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
      granularity: req.operation === 'read' ? 'scope' : 'package',
    })
  }

  // --- presence ----------------------------------------------------------------

  // --- handlers ----------------------------------------------------------------

  const get = async (req) => {
    if (!REGISTRIES.includes(req.registry)) {
      return err('url-not-supported')
    }
    const write = Object.hasOwn(WRITE_VERBS, req.operation)
    if (req.operation !== 'read' && !write) {
      return err('operation-not-supported')
    }
    const name = nameOf(req)
    if (req.operation === 'publish' && !req.version) {
      return err('other', `A publish request for ${name} must name a version.`)
    }
    // `dist-tag`, `deprecate` and `unpublish` may come without a version
    const label = write && req.version ? `${name}@${req.version}` : name
    const what = req.operation === 'publish' ? `publishing ${label}` : `${req.operation} of ${label}`
    const subject = req.operation === 'publish' ? `Publishing ${label}` : `The ${req.operation} of ${label}`
    // the name as the terminal is shown it
    const shown = plain(label)

    // one deadline for everything in this request that waits on the person: a
    // device sign-in, then the prompt
    const until = deadline

    const identity = serviceIdentity()
    if (identity) {
      let granted = await identityAccess(identity)
      if (write && !granted.roles.includes('npm-publisher')) {
        return err('other', `The service identity lacks the npm-publisher role that ${what} needs.`)
      }
      return mint(req, granted.token, async () => (granted = await identityAccess(identity, { force: true })).token)
    }

    if (!readSession()) {
      // nobody ever signed in here: nothing to withhold, and no login opened
      return err('not-found')
    }
    if (write) {
      if (!req.interactive) {
        return err(
          'other',
          `${subject} needs a device-code confirmation, and no terminal is available. Run npm ${req.operation} from a terminal, or from the release runner.`,
        )
      }
      if (ctx.now() - (readSession().interactiveAt ?? 0) > STEP_UP_SECONDS) {
        await signIn(req, until)
      }
    }

    // a 403 says the entitlement may have changed: renew the IdP claims first
    const rejected = req.retry === true && req.httpStatus === 403
    const access = await sessionAccess(req, { force: rejected, until })
    if (rejected) {
      const info = await call('GET', `${idp}/userinfo`, { token: access })
      const current = JSON.stringify([...((info.json && info.json.groups) || [])].sort())
      if (info.status === 200 && mintedGroups.get(req.scope ?? '') === current) {
        return err('other', `The identity provider still gives no access to ${name}; the gateway's refusal stands.`)
      }
    }

    if (write) {
      const question = `${WRITE_VERBS[req.operation]} ${shown} ${req.operation === 'publish' ? 'to' : 'on'} ${new URL(req.registry).host}?`
      // a sign-in that has used the budget leaves nothing to ask in
      const left = until - ctx.clockMs()
      const answer = left > 0 ? await ctx.confirmWithin(question, left) : null
      if (answer === null) {
        return err('other', `${subject} was not confirmed within 4 minutes 30 seconds.`)
      }
      if (!answer) {
        return err('other', `${subject} was not confirmed.`)
      }
    }
    // a gateway 401 after the person has confirmed: one renewal, and no login
    return mint(req, access, () => sessionAccess(req, { force: true, until, login: false }))
  }

  // Drops what was handed to npm and the access token kept for it; the
  // refresh token is `login`'s and only `logout` removes it.
  const erase = async (req) => {
    if (!REGISTRIES.includes(req.registry)) {
      return err('url-not-supported')
    }
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
    // the gateway takes tokens it mints from an IdP session, and a pasted token is not
    // one: it is said, not dropped while a device flow is started in its place
    if (req.token) {
      return err('other', "This provider takes no pasted token: it signs in at the identity provider. Run 'npm login' without one.")
    }
    if (!req.interactive) {
      return err('other', 'Signing in needs a terminal, and none is available.')
    }
    await signIn(req, ctx.clockMs() + WAIT_MS)
    return ok('login')
  }

  // the entry is gone for both hosts, then a best effort at the IdP (RFC 7009)
  const logout = async (req) => {
    if (!REGISTRIES.includes(req.registry)) {
      return err('url-not-supported')
    }
    const session = readSession()
    if (!session) {
      // nothing was stored for either host: nothing to remove
      return err('not-found')
    }
    // the entry goes first, so that nothing the IdP does or fails to do keeps it: the
    // revocation is a best effort with the token in hand, and is cut at its budget
    saveSession(null)
    try {
      const revoked = await call('POST', `${idp}/revoke`, {
        form: { token: session.refreshToken, client_id: CLIENT_ID },
      })
      if (revoked.status !== 200) {
        log(`could not revoke the session at the identity provider (HTTP ${revoked.status})`)
      }
    } catch (error) {
      log(`could not reach the identity provider to revoke the session: ${error.message}`)
    }
    return ok('logout')
  }

  return {
    hello: { v: [1], capabilities: CAPABILITIES, registries: REGISTRIES },
    // every request is held to the time npm gives its kind
    handlers: Object.fromEntries(
      Object.entries({ get, erase, login, logout }).map(([kind, handler]) => [
        kind,
        (req) => {
          deadline = ctx.clockMs() + budgetMs(req)
          return handler(req)
        },
      ]),
    ),
  }
}

serve(start)
