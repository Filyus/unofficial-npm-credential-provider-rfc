'use strict'
// A reference provider for the JFrog Artifactory example
// (examples/jfrog-artifactory.md): one identity, a plain user, whose
// long-lived login (an identity token, or a web-login access token with its
// refresh token) is kept in the store and traded for short tokens that carry
// all the user's rights, so the operation split protects nothing and the
// provider asks for no presence. In CI it exchanges the CI's ID token at
// JFrog's OIDC endpoint instead.
//
// Endpoints, as the page cites them: POST /access/api/v1/tokens (create and
// refresh), POST /access/api/v1/oidc/token, and the CLI web login at
// /access/api/v2/authentication/jfrog_client_login/request and .../token/<id>
// (login.go, weblogin.go). Read in the REST reference: `DELETE /access/api/v1/tokens/{id}`
// ("Revoke Token by ID"), where `me` revokes the token that makes the call and which "requires
// a valid token": users can revoke only their own tokens, admins any. Logout uses it, with
// the stored access or identity token as the bearer. `DELETE /access/api/v1/tokens/revoke`
// (by value, the token in a JSON body field `token`) is not used: the page says it needs admin
// privileges, so a plain user's logout would get 403. A web login's refresh token is not
// revoked: the pages read say nothing of presenting one as a bearer or of revoking an access
// token ending its refresh, so it is left to expire and logout says so on stderr. Also read:
// the OIDC page's example of the token exchange, whose grant and token type
// names the provider sends. Recalled, not read, and so unverified here: the request and response
// fields of the other calls, GitHub's `audience` query parameter, and `GET /access/api/v1/users/me`,
// which only names the user in the message of a 403. Invented for the
// example: that a mint refused with 403 means the user may not create tokens,
// and the identity token is then what the registry gets, as it is.

const crypto = require('node:crypto')
const { serve, ok, err, log } = require('../lib/protocol.js')
const { loadContext, plain } = require('../lib/context.js')

const CAPABILITIES = ['login', 'logout', 'erase']
const API_PREFIX = '/artifactory/api/npm/'
// the lifetime of every token this provider mints, always sent: the platform's
// default may be an hour or a year
const EXPIRES_IN = 3600
// a token with less than this left is minted again
const MARGIN = 60
const POLL_MS = 3000
// inside npm's 5-minute budget for `login`; the CLI's own limit is 5 minutes
const WAIT_MS = 4.5 * 60 * 1000
const SERVED = new Set(['read', 'publish', 'dist-tag', 'deprecate', 'unpublish'])
// what each operation needs on the repository, and how a 403 names it
const NEEDS = {
  read: ['Read', 'this request reads'],
  publish: ['Deploy', 'receives this publish'],
  'dist-tag': ['Deploy', 'receives this dist-tag change'],
  deprecate: ['Deploy', 'receives this deprecation'],
  unpublish: ['Delete', 'holds this package'],
}

class Answer extends Error {
  constructor(answer) {
    super(answer.Err ? answer.Err.kind : 'answer')
    this.answer = answer
  }
}

const start = async (args) => {
  const ctx = loadContext(args.config)
  // the platform root comes from configuration, never from a registry URL
  const root = (args.url || ctx.config.url).replace(/\/+$/, '')
  const prefix = new URL(root).pathname.replace(/\/+$/, '') + API_PREFIX
  const registryKey = `${new URL(root).origin}${prefix}`
  const oidcProvider = ctx.config.oidcProvider

  // what the provider holds for this instance: { login }, where login is
  // { type: 'identity', token } or { type: 'refresh', accessToken, refreshToken }
  const readLogin = () => (ctx.readStore()[root] || {}).login || null
  const writeLogin = (login) => {
    const store = ctx.readStore()
    if (login) {
      store[root] = { login }
    } else {
      delete store[root]
    }
    ctx.writeStore(store)
  }

  // The credential this session handed out, in memory only: the tokens it
  // mints last an hour, below the persistency threshold, so nothing of them is stored.
  // `identity` marks the stored identity token handed out as it is.
  let held = null
  let identityRejected = false

  // the registries of this instance, at a segment boundary
  const served = (registry) => {
    let url
    try {
      url = new URL(registry)
    } catch {
      return false
    }
    return url.origin === new URL(root).origin && url.pathname.startsWith(prefix)
  }

  const fresh = (token) => token && (token.expiresAt === undefined || token.expiresAt - ctx.now() > MARGIN)

  // `requestedAt` is the clock when the request went out: the platform counts `expires_in`
  // from when it issued the token, so the time the answer took to come back is not the token's
  const fromResponse = (json, requestedAt) => ({
    token: json.access_token,
    ...(json.expires_in === undefined ? {} : { expiresAt: requestedAt + json.expires_in }),
  })

  const rejectedIdentity = (req) =>
    err('other', `Artifactory rejected the stored identity token. Run npm logout and npm login for ${req.registry}.`)

  const mint = async (req, login) => {
    const common = { expires_in: EXPIRES_IN, refreshable: false }
    const requestedAt = ctx.now()
    const res = login.type === 'refresh'
      ? await ctx.request('POST', `${root}/access/api/v1/tokens`, {
        form: { grant_type: 'refresh_token', refresh_token: login.refreshToken, access_token: login.accessToken, ...common },
      })
      : await ctx.request('POST', `${root}/access/api/v1/tokens`, {
        token: login.token,
        form: { grant_type: 'client_credentials', scope: 'applied-permissions/user', ...common },
      })
    if (res.status === 200 && res.json && res.json.access_token) {
      // a refresh may rotate the refresh token: the new one is stored before anything else
      if (login.type === 'refresh' && res.json.refresh_token) {
        writeLogin({ ...login, refreshToken: res.json.refresh_token })
      }
      return { auth: fromResponse(res.json, requestedAt) }
    }
    if (res.status === 401) {
      throw new Answer(err('other', `Artifactory refused the stored login. Run npm login for ${req.registry}.`))
    }
    if (res.status === 403 && login.type === 'identity') {
      // no right to create tokens: the identity token is all there is, unless the
      // registry has just refused it, and then it is not handed out again
      if (identityRejected) {
        throw new Answer(rejectedIdentity(req))
      }
      return { identity: login.token }
    }
    throw new Answer(err('other', `Artifactory answered ${res.status} to creating a token`))
  }

  // the CI's ID token, from GitHub Actions' own endpoint, for JFrog's exchange
  const exchange = async () => {
    const asked = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL)
    if (ctx.config.oidcAudience) {
      asked.searchParams.set('audience', ctx.config.oidcAudience)
    }
    const idToken = await ctx.request('GET', asked.toString(), { token: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN })
    if (idToken.status !== 200 || !idToken.json || !idToken.json.value) {
      throw new Answer(err('other', `The CI did not give an ID token (HTTP ${idToken.status})`))
    }
    const requestedAt = ctx.now()
    const res = await ctx.request('POST', `${root}/access/api/v1/oidc/token`, {
      body: {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        subject_token: idToken.json.value,
        provider_name: oidcProvider,
      },
    })
    if (res.status !== 200 || !res.json || !res.json.access_token) {
      throw new Answer(err('other', `Artifactory refused the OIDC exchange for provider ${oidcProvider} (HTTP ${res.status})`))
    }
    return { auth: fromResponse(res.json, requestedAt) }
  }

  const answerWith = (credential) => {
    if (credential.identity) {
      return ok('get', {
        auth: { type: 'bearer', token: credential.identity },
        cache: 'session',
        operationIndependent: true,
        granularity: 'registry',
      })
    }
    const { token, expiresAt } = credential.auth
    return ok('get', {
      auth: { type: 'bearer', token },
      ...(expiresAt === undefined ? { cache: 'session' } : { cache: 'expires', expiresAt }),
      operationIndependent: true,
      granularity: 'registry',
    })
  }

  const whoami = async () => {
    const token = held && (held.identity || (held.auth && held.auth.token))
    if (!token) {
      return null
    }
    try {
      const res = await ctx.request('GET', `${root}/access/api/v1/users/me`, { token })
      return res.status === 200 && res.json && res.json.username ? res.json.username : null
    } catch {
      return null
    }
  }

  const get = async (req) => {
    if (!served(req.registry)) {
      return err('url-not-supported')
    }
    if (!SERVED.has(req.operation)) {
      return err(
        'operation-not-supported',
        req.operation.startsWith('stage')
          ? 'Artifactory has no staged publishing for npm'
          : `Artifactory has no npm endpoint for ${req.operation}`,
      )
    }
    if (req.retry && req.httpStatus === 403) {
      // permissions are the user's, not the token's: nothing wider to move to
      const [permission, where] = NEEDS[req.operation]
      const user = await whoami()
      return err('other', `${user ? `User ${user}` : 'The user'} has no ${permission} permission on the repository that ${where}. The provider holds no other identity.`)
    }
    if (req.retry && identityRejected) {
      return rejectedIdentity(req)
    }
    if (req.retry) {
      held = null
    }
    if (held && (held.identity || fresh(held.auth))) {
      return answerWith(held)
    }
    const login = readLogin()
    const ciExchange = oidcProvider && process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    if (ciExchange) {
      held = await exchange()
    } else if (login) {
      held = await mint(req, login)
    } else if (req.retry) {
      return err('other', `Nothing is stored to mint a token from. Run npm login for ${req.registry}.`)
    } else {
      return err('not-found', 'No OIDC provider is configured and no login is stored')
    }
    return answerWith(held)
  }

  const erase = async (req) => {
    if (!served(req.registry)) {
      return err('url-not-supported')
    }
    // the login stays: it is logout's. A stored identity token that was itself
    // the rejected credential is not handed out again, by the retry or by any
    // later `get`, until a `login` stores another
    identityRejected = Boolean(held && held.identity)
    held = null
    return ok('erase')
  }

  const login = async (req) => {
    if (!served(req.registry)) {
      return err('url-not-supported')
    }
    if (req.token) {
      writeLogin({ type: 'identity', token: req.token })
      identityRejected = false
      return ok('login')
    }
    if (!req.interactive) {
      return err('other', 'login needs the person to confirm it in a browser')
    }
    const session = crypto.randomUUID()
    const base = `${root}/access/api/v2/authentication/jfrog_client_login`
    const started = await ctx.request('POST', `${base}/request`, { body: { session } })
    if (started.status !== 200) {
      return err('other', 'This Artifactory did not start a web login (7.64.0 or later has it). Run npm login with an identity token from the Artifactory UI.')
    }
    if (!ctx.showToPerson(`Open ${root}/ui/login?jfClientSession=${session} and check that the code is ${session.slice(-4)}`)) {
      // the session started at Artifactory is left to lapse; nothing was stored
      return err('other', 'There is no terminal to show the web login on; run npm login from a terminal.')
    }
    const until = ctx.clockMs() + WAIT_MS
    while (ctx.clockMs() + POLL_MS <= until) {
      await ctx.sleep(POLL_MS)
      const res = await ctx.request('GET', `${base}/token/${session}`)
      if (res.status === 200 && res.json && res.json.access_token) {
        writeLogin(res.json.refresh_token
          ? { type: 'refresh', accessToken: res.json.access_token, refreshToken: res.json.refresh_token }
          : { type: 'identity', token: res.json.access_token })
        identityRejected = false
        return ok('login')
      }
      if (res.status !== 400) {
        return err('other', `Artifactory answered ${res.status} to the web login`)
      }
    }
    return err('other', 'Stopped waiting for the web login after 4 minutes 30 seconds. Run npm login again.')
  }

  const logout = async (req) => {
    if (!served(req.registry)) {
      return err('url-not-supported')
    }
    const stored = readLogin()
    if (!stored) {
      return err('not-found')
    }
    // The login goes first, as the RFC has it, so that an Artifactory that is slow or down
    // cannot keep it; the revocation that follows is a best effort, and what cannot be
    // revoked is warned about. The token revokes itself (`me`), which a plain user may do.
    const bearer = stored.type === 'refresh' ? stored.accessToken : stored.token
    writeLogin(null)
    held = null
    try {
      const res = await ctx.request('DELETE', `${root}/access/api/v1/tokens/me`, { token: bearer })
      if (res.status !== 200) {
        log(`logout: Artifactory answered ${res.status} to revoking the stored login; it stays valid until it expires`)
      }
    } catch {
      log('logout: the stored login could not be revoked')
    }
    if (stored.type === 'refresh') {
      log('logout: the refresh token is not revoked, since no documented call revokes it; it stays valid until its refresh period ends')
    }
    return ok('logout')
  }

  const guarded = (handler) => async (req) => {
    try {
      return await handler(req)
    } catch (error) {
      if (error instanceof Answer) {
        return error.answer
      }
      throw error
    }
  }

  return {
    hello: { v: [1], capabilities: CAPABILITIES, registries: [registryKey] },
    handlers: { get: guarded(get), erase: guarded(erase), login: guarded(login), logout: guarded(logout) },
  }
}

serve(start)
