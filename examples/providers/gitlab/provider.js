'use strict'
// A reference provider for the GitLab example (examples/gitlab.md): an OAuth
// refresh token in the store, project deploy tokens minted from it, the
// job token in CI. Everything it answers follows from the store, the
// clock, the environment, the person's presence and what GitLab says.
//
// GitLab endpoints, as the page cites them: POST /projects/:id/deploy_tokens
// and DELETE /projects/:id/deploy_tokens/:token_id (deploy tokens API), and
// the OAuth token endpoint with a refresh_token grant (OAuth 2.0 API).
// Recalled, not read, and so unverified here: the device authorization
// endpoint `POST /oauth/authorize_device` and its response fields, the
// device-code grant type on `/oauth/token`, `POST /oauth/revoke`, the
// `api` scope a deploy-token call needs, and `expires_at` as a bare date.

const { serve, ok, err, log } = require('../lib/protocol.js')
const { loadContext } = require('../lib/context.js')

// The provider's own limit on a read token, seconds from now. GitLab's
// expiry is a date, so it is only the backstop (see the page).
const READ_LIFETIME = 3600
// An access token with less than this left is refreshed before use.
const ACCESS_MARGIN = 60
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

const start = async (args) => {
  const ctx = loadContext(args.config)
  const instance = args.instance || ctx.config.instance
  const clientId = ctx.config.clientId
  const apiUrl = (path) => `${instance}/api/v4${path}`

  // what this provider keeps for this instance: { oauth, minted }
  const readAccount = () => ctx.readStore()[instance] || {}
  const writeAccount = (account) => {
    const store = ctx.readStore()
    if (account && (account.oauth || Object.keys(account.minted || {}).length)) {
      store[instance] = account
    } else {
      delete store[instance]
    }
    ctx.writeStore(store)
  }

  const refresh = async (account) => {
    const res = await ctx.request('POST', `${instance}/oauth/token`, {
      form: { client_id: clientId, grant_type: 'refresh_token', refresh_token: account.oauth.refreshToken },
    })
    if (res.status !== 200 || !res.json || !res.json.access_token || !res.json.refresh_token) {
      throw new Answer(err('other', 'GitLab did not accept the stored login; run npm login'))
    }
    // the refresh replaces both tokens: the new refresh token is stored
    // before anything else is done with the access token
    account.oauth = {
      refreshToken: res.json.refresh_token,
      accessToken: res.json.access_token,
      accessExpiresAt: ctx.now() + (res.json.expires_in ?? 7200),
    }
    writeAccount(account)
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
    let res = await ctx.request(method, apiUrl(path), { token: await accessToken(account), body })
    if (res.status === 401) {
      await refresh(account)
      res = await ctx.request(method, apiUrl(path), { token: account.oauth.accessToken, body })
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
    writeAccount(account)
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

    if (process.env.CI_JOB_TOKEN) {
      // the job's own project on the job's own host, and nothing else
      if (process.env.CI_SERVER_HOST !== target.host || process.env.CI_PROJECT_ID !== target.projectId) {
        return err('not-found', 'the job token serves only its own project')
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
      return err('not-found')
    }
    if (write) {
      if (!req.interactive) {
        return err('other', 'a write credential needs the person to confirm, and this request is not interactive')
      }
      const what = `${req.scope ? `${req.scope}/` : ''}${req.package}`
      if (!(await ctx.confirm(`Create a deploy token that can write packages to project ${target.projectId} (${what})?`))) {
        return err('other', 'the person declined a write credential')
      }
    }

    const tier = write ? 'write' : 'read'
    const granularity = write ? 'package' : req.scope ? 'scope' : 'registry'
    const key = mintedKey(req.registry, tier, granularity, req.scope, req.package)
    // a retry after a rejection that sent no erase (a 403), or a second get
    // for the same context: the token held for it is not handed out again.
    // A 401 retry follows the erase that already deleted it.
    if (!(req.retry && req.httpStatus === 401)) {
      await release(account, key)
    }
    const limit = ctx.now() + READ_LIFETIME
    const minted = await mint(account, target.projectId, tier, limit)
    account.minted = { ...account.minted, [key]: { id: minted.id, projectId: target.projectId } }
    writeAccount(account)
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
    const tier = WRITE_OPERATIONS.has(req.operation) ? 'write' : 'read'
    const granularity = req.granularity || (tier === 'write' ? 'package' : req.scope ? 'scope' : 'registry')
    // the refresh token stays: that is logout's
    await release(readAccount(), mintedKey(req.registry, tier, granularity, req.scope, req.package))
    return ok('erase')
  }

  const login = async (req) => {
    if (!parseTarget(req.registry, instance)) {
      return err('url-not-supported')
    }
    if (!req.interactive) {
      return err('other', 'login needs the person to approve it in a browser')
    }
    const device = await ctx.request('POST', `${instance}/oauth/authorize_device`, {
      form: { client_id: clientId, scope: 'api' },
    })
    if (device.status !== 200 || !device.json || !device.json.device_code) {
      return err('other', `GitLab answered ${device.status} to the device authorization request`)
    }
    ctx.showToPerson(`Open ${device.json.verification_uri} and enter the code ${device.json.user_code}`)
    let wait = (device.json.interval ?? 5) * 1000
    // the device code lives as long as the server says; polling past it is no use
    const until = ctx.clockMs() + (device.json.expires_in ?? 300) * 1000
    for (let attempt = 0; attempt < 120 && ctx.clockMs() + wait <= until; attempt += 1) {
      await ctx.sleep(wait)
      const res = await ctx.request('POST', `${instance}/oauth/token`, {
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
    // best effort throughout: what cannot be done is warned about, and the
    // local credentials go all the same
    for (const key of Object.keys(account.minted || {})) {
      try {
        await release(account, key)
      } catch (error) {
        log('logout: a deploy token could not be deleted; it expires on its own date')
      }
    }
    for (const [hint, token] of [
      ['access_token', account.oauth && account.oauth.accessToken],
      ['refresh_token', account.oauth && account.oauth.refreshToken],
    ]) {
      if (!token) {
        continue
      }
      try {
        const res = await ctx.request('POST', `${instance}/oauth/revoke`, {
          form: { client_id: clientId, token, token_type_hint: hint },
        })
        if (res.status !== 200) {
          log(`logout: GitLab answered ${res.status} to revoking the ${hint}`)
        }
      } catch {
        log(`logout: the ${hint} could not be revoked`)
      }
    }
    writeAccount(null)
    return ok('logout')
  }

  // an answer raised from a helper is that handler's answer
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
    hello: {
      v: [1],
      capabilities: ['login', 'logout', 'erase', 'retry-context'],
      registries: [`${instance}/api/v4/projects/`],
    },
    handlers: { get: guarded(get), erase: guarded(erase), login: guarded(login), logout: guarded(logout) },
  }
}

serve(start)
