'use strict'
// A reference provider for the GitLab example (examples/gitlab.md): an OAuth
// refresh token in the store, project deploy tokens minted from it, the
// job token in CI. Everything it answers follows from the store, the
// clock, the environment, the person's presence and what GitLab says.
//
// GitLab endpoints, as the page cites them: POST /projects/:id/deploy_tokens
// and DELETE /projects/:id/deploy_tokens/:token_id (deploy tokens API), and
// the OAuth token endpoint with a refresh_token grant (OAuth 2.0 API).
// Recalled when it was written, and since tried against GitLab CE 19.5.1
// (examples/gitlab.md, "Against a real GitLab"): the device authorization
// endpoint `POST /oauth/authorize_device` and its response fields, the
// device-code grant type on `/oauth/token`, `POST /oauth/revoke`, the
// `api` scope a deploy-token call needs, and `expires_at` as a bare date.
// All of them answered as this provider takes them to.

const crypto = require('node:crypto')
const { serve, ok, err, log } = require('../lib/protocol.js')
const { loadContext, plain } = require('../lib/context.js')

// The provider's own limit on a read token, seconds from now. GitLab's
// expiry is a date, so it is only the backstop (see the page).
const READ_LIFETIME = 3600
// An access token with less than this left is refreshed before use.
const ACCESS_MARGIN = 60
// Inside npm's 5-minute budget for `login` and an interactive `get`: the
// provider ends a login or a presence prompt itself, first.
const WAIT_MS = 4.5 * 60 * 1000
const WRITE_OPERATIONS = new Set(['publish', 'dist-tag'])
const READ_OPERATIONS = new Set(['read'])

// A protocol answer raised from deep inside a helper.
class Answer extends Error {
  constructor(answer) {
    super(answer.Err ? answer.Err.kind : 'answer')
    this.answer = answer
  }
}

// The project a registry URL names, or null for any other URL: another
// instance, `http:`, or a group or instance level endpoint.
const parseTarget = (registry, instance) => {
  let url
  try {
    url = new URL(registry)
  } catch {
    return null
  }
  if (url.origin !== new URL(instance).origin) {
    return null
  }
  const match = /^\/api\/v4\/projects\/(\d+)\/packages\/npm\//.exec(url.pathname)
  return match ? { host: url.host, projectId: match[1] } : null
}

// What a minted token is kept under, so that erase finds what a get made.
const mintedKey = (registry, tier, granularity, scope, pkg) => {
  if (granularity === 'package') {
    return `${registry}|${tier}|${scope ? `${scope}/` : ''}${pkg}`
  }
  if (granularity === 'scope') {
    return `${registry}|${tier}|${scope || ''}`
  }
  return `${registry}|${tier}`
}

// First 00:00 UTC strictly after the limit, as GitLab's date-only expiry.
const expiryDate = (limit) => new Date((Math.floor(limit / 86400) + 1) * 86400 * 1000).toISOString().slice(0, 10)

// Inside the timeout npm gives each kind of request (RFC, Session lifecycle),
// with room to answer: an interactive `get` and `login` wait for a person.
const budgetMs = (req) => {
  if (req.kind === 'erase') {
    return 8 * 1000
  }
  if (req.kind === 'logout' || (req.kind === 'get' && !req.interactive)) {
    return 25 * 1000
  }
  return WAIT_MS
}

const start = async (args) => {
  const ctx = loadContext(args.config)
  // `--instance https://host/` and `https://host` are one instance
  const instance = String(args.instance || ctx.config.instance).replace(/\/+$/, '')
  const clientId = ctx.config.clientId
  const apiUrl = (path) => `${instance}/api/v4${path}`
  // the time (on the context's clock) by which the request in hand must be
  // answered; every call to GitLab is held to it
  let deadline = Infinity
  const call = (method, url, options) => ctx.request(method, url, { ...options, until: deadline === Infinity ? undefined : deadline })
  // an account the logout has already removed from the store: what is done
  // with it afterwards (deleting its deploy tokens, revoking) writes nothing back
  const detached = new WeakSet()

  // what this provider keeps for this instance: { oauth, minted, signIn }, `signIn`
  // being the id of the login that made the entry
  const readAccount = () => ctx.readStore()[instance] || {}
  const writeAccount = (account) => {
    if (detached.has(account)) {
      return
    }
    const store = ctx.readStore()
    if (account && (account.oauth || Object.keys(account.minted || {}).length)) {
      store[instance] = account
    } else {
      delete store[instance]
    }
    ctx.writeStore(store)
  }

  // What a call changed in an account object it read earlier (a long install: a
  // refresh and a mint take time, and `npm logout` or `npm login` may run in
  // another process meanwhile). The store is read again and only the part the call
  // changed is written onto what it holds, and only if that is still the same
  // login: an entry that was removed stays removed, and one that another login
  // replaced is not overwritten with the stale one. `minted` names the one record
  // of `account.minted` that changed (merged, so another call's records stay).
  // Returns whether anything was written.
  const persist = (account, { oauth = false, minted } = {}) => {
    if (detached.has(account)) {
      return false
    }
    const store = ctx.readStore()
    const current = store[instance]
    if (!current || current.signIn !== account.signIn) {
      return false
    }
    if (oauth) {
      current.oauth = account.oauth
    }
    if (minted !== undefined) {
      current.minted = { ...current.minted }
      if (account.minted && account.minted[minted]) {
        current.minted[minted] = account.minted[minted]
      } else {
        delete current.minted[minted]
      }
    }
    ctx.writeStore(store)
    return true
  }

  const refresh = async (account) => {
    const res = await call('POST', `${instance}/oauth/token`, {
      form: { client_id: clientId, grant_type: 'refresh_token', refresh_token: account.oauth.refreshToken },
    })
    // only the OAuth error that says the grant is dead proves the login is: a 5xx, or a
    // 200 without tokens, says nothing about it, and `npm login` would not help
    if (res.status === 400 && res.json && res.json.error === 'invalid_grant') {
      throw new Answer(err('other', 'GitLab did not accept the stored login; run npm login'))
    }
    if (res.status !== 200 || !res.json || !res.json.access_token || !res.json.refresh_token) {
      throw new Answer(err('other', `GitLab answered ${res.status} to refreshing the stored login; try again, and run npm login only if it keeps failing`))
    }
    // the refresh replaces both tokens: the new refresh token is stored
    // before anything else is done with the access token
    account.oauth = {
      refreshToken: res.json.refresh_token,
      accessToken: res.json.access_token,
      accessExpiresAt: ctx.now() + (res.json.expires_in ?? 7200),
    }
    persist(account, { oauth: true })
  }

  const accessToken = async (account) => {
    if (!account.oauth.accessToken || account.oauth.accessExpiresAt - ctx.now() < ACCESS_MARGIN) {
      await refresh(account)
    }
    return account.oauth.accessToken
  }

  // one call with the access token; a 401 is checked once with a refresh
  // before it is believed
  const api = async (account, method, path, body) => {
    let res = await call(method, apiUrl(path), { token: await accessToken(account), body })
    if (res.status === 401) {
      await refresh(account)
      res = await call(method, apiUrl(path), { token: account.oauth.accessToken, body })
    }
    return res
  }

  const mint = async (account, projectId, tier, limit) => {
    const res = await api(account, 'POST', `/projects/${projectId}/deploy_tokens`, {
      name: `npm-credential-provider ${tier} ${ctx.now()}`,
      scopes: [tier === 'write' ? 'write_package_registry' : 'read_package_registry'],
      expires_at: expiryDate(limit),
    })
    if (res.status === 403) {
      throw new Answer(err('other', `GitLab refused a deploy token for project ${projectId}; Maintainer or Owner is needed`))
    }
    if (res.status !== 201 || !res.json || !res.json.token) {
      throw new Answer(err('other', `GitLab answered ${res.status} to a deploy token for project ${projectId}`))
    }
    return res.json
  }

  // deletes the token kept under `key`, if any; a token already gone (404)
  // is as deleted as one just removed
  const release = async (account, key) => {
    const held = account.minted && account.minted[key]
    if (!held) {
      return
    }
    const res = await api(account, 'DELETE', `/projects/${held.projectId}/deploy_tokens/${held.id}`)
    if (res.status !== 204 && res.status !== 404) {
      throw new Answer(err('other', `GitLab answered ${res.status} to deleting a deploy token; it stays recorded`))
    }
    delete account.minted[key]
    persist(account, { minted: key })
  }

  // user presence for a write, as every write credential of this provider is
  // released only on it where a person is there to give it: null once given,
  // else the answer to send
  const presence = async (question) => {
    const answer = await ctx.confirmWithin(question, WAIT_MS)
    if (answer === null) {
      return err('other', 'the person did not answer within 4 minutes 30 seconds')
    }
    return answer ? null : err('other', 'the person declined a write credential')
  }

  const get = async (req) => {
    const target = parseTarget(req.registry, instance)
    if (!target) {
      return err('url-not-supported')
    }
    const write = WRITE_OPERATIONS.has(req.operation)
    if (!write && !READ_OPERATIONS.has(req.operation)) {
      return err('operation-not-supported')
    }
    const what = plain(`${req.scope ? `${req.scope}/` : ''}${req.package}${req.version ? `@${req.version}` : ''}`)

    if (process.env.CI_JOB_TOKEN) {
      // the job's own project on the job's own host, and nothing else
      if (process.env.CI_SERVER_HOST !== target.host || process.env.CI_PROJECT_ID !== target.projectId) {
        return err('not-found', 'the job token serves only its own project')
      }
      // the job token is the only credential here: one GitLab has just refused is not
      // handed out again, since the retry could only fail the same way
      if (req.retry) {
        return err('other', `GitLab refused the job token with ${req.httpStatus}; the provider has no other credential to release for this request`)
      }
      // a pipeline authorizes its own publish and has nobody to ask. A request that
      // says a person is there is not a pipeline's: the variable is the environment's,
      // and a write on its strength needs the presence every other write here needs
      if (write && req.interactive) {
        const refused = await presence(`Use the CI job token to write packages to project ${target.projectId}, for ${req.operation} of ${what}?`)
        if (refused) {
          return refused
        }
      }
      return ok('get', {
        auth: { type: 'bearer', token: process.env.CI_JOB_TOKEN },
        cache: 'session',
        operationIndependent: false,
        granularity: write ? 'package' : 'registry',
      })
    }

    const account = readAccount()
    if (!account.oauth) {
      // a retry is never `not-found`: what the rejected credential came from is gone
      return req.retry ? err('other', 'no login is stored any more for this request; run npm login') : err('not-found')
    }
    if (write) {
      if (!req.interactive) {
        return err('other', 'a write credential needs the person to confirm, and this request is not interactive')
      }
      const refused = await presence(`Create a deploy token that can write packages to project ${target.projectId}, for ${req.operation} of ${what}?`)
      if (refused) {
        return refused
      }
    }

    const tier = write ? 'write' : 'read'
    const granularity = write ? 'package' : req.scope ? 'scope' : 'registry'
    const key = mintedKey(req.registry, tier, granularity, req.scope, req.package)
    // the token held for this context is deleted before another is made, whether
    // the get is a second one, a retry after a 403 (no erase came) or one after a 401
    // (the erase deleted it, and the record with it). One whose deletion failed
    // stays recorded, so it is tried again here and never overwritten and lost.
    await release(account, key)
    const limit = ctx.now() + READ_LIFETIME
    const minted = await mint(account, target.projectId, tier, limit)
    account.minted = { ...account.minted, [key]: { id: minted.id, projectId: target.projectId } }
    persist(account, { minted: key })
    return ok('get', {
      auth: { type: 'bearer', token: minted.token },
      ...(write ? { cache: 'never' } : { cache: 'expires', expiresAt: limit }),
      operationIndependent: false,
      granularity,
    })
  }

  const erase = async (req) => {
    if (!parseTarget(req.registry, instance)) {
      return err('url-not-supported')
    }
    // an operation this provider never answers a `get` for has nothing to erase,
    // and is never taken for a read
    const write = WRITE_OPERATIONS.has(req.operation)
    if (!write && !READ_OPERATIONS.has(req.operation)) {
      return err('operation-not-supported')
    }
    // the refresh token stays: that is logout's
    await release(readAccount(), mintedKey(req.registry, write ? 'write' : 'read', req.granularity, req.scope, req.package))
    return ok('erase')
  }

  const login = async (req) => {
    if (!parseTarget(req.registry, instance)) {
      return err('url-not-supported')
    }
    // a token the person supplied is not something this provider can use: it
    // turns an OAuth login into deploy tokens, and a pasted token is neither. It is
    // said, not dropped while a browser login is started in its place.
    if (req.token) {
      return err('other', 'this provider takes no pasted token: it mints deploy tokens from an OAuth login; run npm login without one')
    }
    if (!req.interactive) {
      return err('other', 'login needs the person to approve it in a browser')
    }
    const device = await call('POST', `${instance}/oauth/authorize_device`, {
      form: { client_id: clientId, scope: 'api' },
    })
    if (device.status !== 200 || !device.json || !device.json.device_code) {
      return err('other', `GitLab answered ${device.status} to the device authorization request`)
    }
    // with no terminal to show the code on nobody can approve it: stop before polling,
    // with nothing stored; the unused device code expires at GitLab on its own
    if (!ctx.showToPerson(`Open ${plain(device.json.verification_uri)} and enter the code ${plain(device.json.user_code)}`)) {
      return err('other', 'There is no terminal to show the sign-in on; run npm login from a terminal.')
    }
    let wait = (device.json.interval ?? 5) * 1000
    // the device code lives as long as the server says, and npm gives a login
    // five minutes; polling past either is no use
    const until = ctx.clockMs() + Math.min((device.json.expires_in ?? 300) * 1000, WAIT_MS)
    for (let attempt = 0; attempt < 120 && ctx.clockMs() + wait <= until; attempt += 1) {
      await ctx.sleep(wait)
      // a poll that hangs is cut at 15 s, so the last one, which can start at the
      // login's 4:30, ends inside npm's 5 minutes
      const res = await ctx.request('POST', `${instance}/oauth/token`, {
        timeoutMs: 15000,
        form: {
          client_id: clientId,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: device.json.device_code,
        },
      })
      if (res.status === 200 && res.json && res.json.refresh_token) {
        const account = readAccount()
        account.oauth = {
          refreshToken: res.json.refresh_token,
          accessToken: res.json.access_token,
          accessExpiresAt: ctx.now() + (res.json.expires_in ?? 7200),
        }
        account.signIn = crypto.randomUUID()
        writeAccount(account)
        return ok('login')
      }
      const code = res.json && res.json.error
      if (code === 'slow_down') {
        wait += 5000
      } else if (code !== 'authorization_pending') {
        return err('other', `GitLab refused the login: ${code || res.status}`)
      }
    }
    return err('other', 'the login was not approved in time')
  }

  const logout = async (req) => {
    if (!parseTarget(req.registry, instance)) {
      return err('url-not-supported')
    }
    const account = readAccount()
    if (!account.oauth && !Object.keys(account.minted || {}).length) {
      return err('not-found')
    }
    // the local credentials go first, so that nothing the vendor does or fails to do
    // keeps them: what is left to do, deleting the deploy tokens and revoking the
    // OAuth tokens, is done with a copy that writes nothing back, and is best effort
    // throughout. A deploy token whose deletion fails is not recorded anywhere
    // afterwards, since nothing could authorize deleting it once the login is
    // revoked; it ends on its own date, and the log line says so.
    const held = structuredClone(account)
    detached.add(held)
    writeAccount(null)
    for (const key of Object.keys(held.minted || {})) {
      try {
        await release(held, key)
      } catch (error) {
        log('logout: a deploy token could not be deleted; it expires on its own date')
      }
    }
    for (const [hint, token] of [
      ['access_token', held.oauth && held.oauth.accessToken],
      ['refresh_token', held.oauth && held.oauth.refreshToken],
    ]) {
      if (!token) {
        continue
      }
      try {
        const res = await call('POST', `${instance}/oauth/revoke`, {
          form: { client_id: clientId, token, token_type_hint: hint },
        })
        if (res.status !== 200) {
          log(`logout: GitLab answered ${res.status} to revoking the ${hint}`)
        }
      } catch {
        log(`logout: the ${hint} could not be revoked`)
      }
    }
    return ok('logout')
  }

  // an answer raised from a helper is that handler's answer
  const guarded = (handler) => async (req) => {
    deadline = ctx.clockMs() + budgetMs(req)
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
    hello: {
      v: [1],
      capabilities: ['login', 'logout'],
      registries: [`${instance}/api/v4/projects/`],
    },
    handlers: { get: guarded(get), erase: guarded(erase), login: guarded(login), logout: guarded(logout) },
  }
}

serve(start)
