'use strict'
// A reference provider for the GitHub Packages example
// (examples/github-packages.md): classic tokens kept per account and per tier
// (read, write, delete) in the store, the owner of a package mapped to an
// account by the provider's own configuration, the job's GITHUB_TOKEN in
// Actions. GitHub mints nothing narrower than an owner here, so everything it
// answers follows from the store, the environment, the person's presence and
// what GitHub says about a token.
//
// Configuration keys beyond the store and the endpoints:
//   clientId         the OAuth app the device flow runs as
//   owners           { "@owner": "account" }: the account whose tokens serve that owner
//   defaultAccount   the account for any other scope and for unscoped packages
//   loginAccount     the account a login stores into (default: defaultAccount)
//   unpublish        "delete-token" serves `unpublish` with a delete:packages token behind a
//                    presence prompt; unset, `unpublish` is operation-not-supported
//   host             a GitHub Enterprise Server host (also `--host`); unset is github.com
//   subdomainIsolation  false for a GHES instance whose registry is HOST/_registry/npm/
//
// GitHub endpoints used, as the page cites them: GET /user and its
// X-OAuth-Scopes header, POST /credentials/revoke, and the device flow of
// OAuth apps. Recalled, not read, and so unverified here: the device flow's
// paths (/login/device/code and /login/oauth/access_token) and the 200 with an
// `error` member for a pending poll.

const { serve, ok, err, log } = require('../lib/protocol.js')
const { loadContext } = require('../lib/context.js')

// npm kills a login at 5 minutes and a code lives for 15, so the provider stops first
const DEVICE_LIMIT_MS = 270 * 1000
const TIER_SCOPES = { read: 'read:packages', write: 'write:packages', delete: 'delete:packages' }

// A protocol answer raised from deep inside a helper.
class Answer extends Error {
  constructor(answer) {
    super(answer.Err ? answer.Err.kind : 'answer')
    this.answer = answer
  }
}

const scopesOf = (header) => (header || '').split(/[\s,]+/).filter(Boolean)

const start = async (args) => {
  const ctx = loadContext(args.config)
  const host = args.host || ctx.config.host
  const hosts = host
    ? {
        web: `https://${host}`,
        api: `https://${host}/api/v3`,
        registries: ctx.config.subdomainIsolation === false ? [`https://${host}/_registry/npm/`] : [`https://npm.${host}/`],
        label: host,
      }
    : { web: 'https://github.com', api: 'https://api.github.com', registries: ['https://npm.pkg.github.com/'], label: 'github.com' }
  const registryRoot = hosts.registries[0]
  const owners = ctx.config.owners || {}
  const served = (registry) => hosts.registries.some((root) => registry.startsWith(root))

  // what is kept for this registry: { accounts: { name: { readToken, writeToken, deleteToken } } }
  const readAccounts = () => (ctx.readStore()[registryRoot] || {}).accounts || {}
  const writeAccounts = (accounts) => {
    const store = ctx.readStore()
    if (Object.keys(accounts).length) {
      store[registryRoot] = { accounts }
    } else {
      delete store[registryRoot]
    }
    ctx.writeStore(store)
  }

  // GitHub's OAuth endpoints answer in a form unless asked for JSON, and
  // ctx.request sets no header of its own, so this one is made here
  const oauth = async (path, form) => {
    const url = `${hosts.web}${path}`
    const { origin } = new URL(url)
    const mapped = ctx.config.endpoints && ctx.config.endpoints[origin]
    const headers = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }
    if (ctx.config.clock) {
      headers['x-conformance-clock'] = String(ctx.clockMs())
    }
    const response = await fetch(mapped ? mapped + url.slice(origin.length) : url, {
      method: 'POST',
      headers,
      body: new URLSearchParams(form).toString(),
      redirect: 'manual',
    })
    const text = await response.text()
    try {
      return { status: response.status, json: text ? JSON.parse(text) : null }
    } catch {
      return { status: response.status, json: null }
    }
  }

  // the person approves a code on github.com; what comes back is { token, scopes }
  const deviceFlow = async (scope) => {
    const device = await oauth('/login/device/code', { client_id: ctx.config.clientId, scope })
    if (device.json && device.json.error === 'device_flow_disabled') {
      throw new Answer(err('other', 'The OAuth app has the device flow disabled (device_flow_disabled). Enable it in the app settings, or log in with a token.'))
    }
    if (device.status !== 200 || !device.json || !device.json.device_code) {
      throw new Answer(err('other', `GitHub answered ${device.status} to the device authorization request`))
    }
    ctx.showToPerson(`Open ${device.json.verification_uri} and enter the code ${device.json.user_code}`)
    let wait = Math.max(1, device.json.interval ?? 5) * 1000
    const until = ctx.clockMs() + Math.min(device.json.expires_in ?? 900, DEVICE_LIMIT_MS / 1000) * 1000
    while (ctx.clockMs() + wait <= until) {
      await ctx.sleep(wait)
      const res = await oauth('/login/oauth/access_token', {
        client_id: ctx.config.clientId,
        device_code: device.json.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      })
      const json = res.json || {}
      if (json.access_token) {
        return { token: json.access_token, scopes: scopesOf(json.scope) }
      }
      if (json.error === 'slow_down') {
        wait = Math.max(1, json.interval ?? wait / 1000 + 5) * 1000
      } else if (json.error === 'access_denied') {
        throw new Answer(err('other', 'GitHub reported that the sign-in was cancelled in the browser (access_denied). Run npm login again to start a new one.'))
      } else if (json.error === 'expired_token') {
        throw new Answer(err('other', 'The code expired before it was entered (expired_token). Run npm login again.'))
      } else if (json.error !== 'authorization_pending') {
        throw new Answer(err('other', `GitHub refused the sign-in: ${json.error || res.status}`))
      }
    }
    throw new Answer(err('other', 'Stopped waiting for the code to be entered after 4 minutes 30 seconds. Run npm login again.'))
  }

  // keeps a token under every tier its scopes cover
  const keep = (accountName, token, scopes) => {
    const accounts = readAccounts()
    const account = accounts[accountName] || {}
    for (const [tier, scope] of Object.entries(TIER_SCOPES)) {
      if (scopes.includes(scope)) {
        account[`${tier}Token`] = token
      }
    }
    accounts[accountName] = account
    writeAccounts(accounts)
  }

  const accountFor = (scope) => owners[(scope || '').toLowerCase()] || ctx.config.defaultAccount

  // which token an operation takes, or null for one the provider does not serve
  const tierOf = (operation) => {
    if (operation === 'read') {
      return 'read'
    }
    if (operation === 'publish' || operation === 'dist-tag') {
      return 'write'
    }
    return operation === 'unpublish' && ctx.config.unpublish === 'delete-token' ? 'delete' : null
  }

  const get = async (req) => {
    if (!served(req.registry)) {
      return err('url-not-supported')
    }
    const tier = tierOf(req.operation)
    if (!tier) {
      return err('operation-not-supported')
    }
    const ci = process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_TOKEN
    const jobOwner = (process.env.GITHUB_REPOSITORY_OWNER || '').toLowerCase()
    // the job's token covers its own repository's owner and nothing else; a package
    // with no scope is one GitHub proxies from npmjs.org, which only a read reaches
    if (ci && tier !== 'delete' && (req.scope ? req.scope.slice(1).toLowerCase() === jobOwner : tier === 'read')) {
      if (req.retry) {
        return err('other', 'GitHub rejected the job token (GITHUB_TOKEN). Check that the workflow grants it packages access and that the package grants the repository access.')
      }
      return ok('get', {
        auth: { type: 'bearer', token: process.env.GITHUB_TOKEN },
        cache: 'session',
        operationIndependent: false,
        granularity: tier === 'write' ? 'package' : 'scope',
      })
    }

    const accountName = accountFor(req.scope)
    const account = readAccounts()[accountName] || {}
    const held = account[`${tier}Token`]
    // a write token can be asked for here: the sign-in is the person's presence
    const obtainable = tier === 'write' && req.interactive
    if (!held && !obtainable) {
      return req.retry ? err('other', `The ${accountName} account has no ${tier} token stored. Run npm login for ${registryRoot}.`) : err('not-found')
    }
    if (req.retry && req.httpStatus === 403) {
      // the same token has to be authorized, and a wider one would be a widening a 403 sends for free
      const owner = req.scope || 'this package'
      return err('other', `GitHub refused the ${accountName} account's token for ${owner}. The organization may require SSO authorization of the token or may block classic personal access tokens. Authorize it at ${hosts.label}/settings/tokens, then run ${req.command ? `npm ${req.command}` : 'the command'} again.`)
    }
    if (req.retry && req.httpStatus === 401 && held) {
      // erase kept the token, since it is the credential itself: ask GitHub whether it is alive
      const user = await ctx.request('GET', `${hosts.api}/user`, { token: held })
      if (user.status !== 200) {
        return err('other', `GitHub rejected the stored token for the ${accountName} account. Run npm logout and npm login for ${registryRoot}.`)
      }
    }

    if (tier !== 'read') {
      if (!req.interactive) {
        return err('other', 'a write credential needs the person to confirm, and this request is not interactive')
      }
      const what = `${req.scope ? `${req.scope}/` : ''}${req.package}${req.version ? ` ${req.version}` : ''}`
      const question =
        tier === 'delete'
          ? `Release a token that can delete packages, to delete ${what} (${accountName} account)?`
          : `Release a token that can write packages, for ${what} (${accountName} account)?`
      if (!(await ctx.confirm(question))) {
        return err('other', 'the person declined a write credential')
      }
    }
    let token = held
    if (!token) {
      const granted = await deviceFlow(TIER_SCOPES[tier])
      keep(accountName, granted.token, granted.scopes)
      token = granted.token
    }
    return ok('get', {
      auth: { type: 'bearer', token },
      cache: tier === 'delete' ? 'never' : 'session',
      operationIndependent: false,
      granularity: tier === 'read' ? 'scope' : 'package',
    })
  }

  // The stored token is the credential the provider hands out, so there is
  // nothing to replace: erase keeps it, and the retry that follows checks it.
  const erase = async (req) => (served(req.registry) ? ok('erase') : err('url-not-supported'))

  const login = async (req) => {
    if (!served(req.registry)) {
      return err('url-not-supported')
    }
    const accountName = ctx.config.loginAccount || ctx.config.defaultAccount
    let granted
    if (req.token) {
      const user = await ctx.request('GET', `${hosts.api}/user`, { token: req.token })
      if (user.status !== 200) {
        return err('other', `GitHub did not accept the token (HTTP ${user.status}). Nothing was stored.`)
      }
      const scopes = scopesOf(user.headers['x-oauth-scopes'])
      if (!scopes.includes(TIER_SCOPES.read)) {
        return err('other', 'The token lacks the read:packages scope. Nothing was stored.')
      }
      if (scopes.includes('repo')) {
        log('login: the token carries repo, which Packages does not need; a narrower token would do')
      }
      granted = { token: req.token, scopes }
    } else {
      if (!req.interactive) {
        return err('other', 'login needs the person to approve it in a browser')
      }
      granted = await deviceFlow(TIER_SCOPES.read)
    }
    keep(accountName, granted.token, granted.scopes)
    return ok('login')
  }

  const logout = async (req) => {
    if (!served(req.registry)) {
      return err('url-not-supported')
    }
    const accounts = readAccounts()
    const tokens = [...new Set(Object.values(accounts).flatMap((account) => Object.values(account)))]
    if (!tokens.length) {
      return err('not-found')
    }
    // best effort: the credentials go all the same. Only what was stored is revoked,
    // never `gh`'s token or GITHUB_TOKEN, which this provider never stores
    try {
      const res = await ctx.request('POST', `${hosts.api}/credentials/revoke`, { body: { credentials: tokens } })
      if (res.status !== 202) {
        log(`logout: GitHub answered ${res.status} to revoking the tokens; they stay valid until revoked in the settings`)
      }
    } catch {
      log('logout: the tokens could not be revoked')
    }
    writeAccounts({})
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
    hello: { v: [1], registries: hosts.registries, capabilities: ['login', 'logout', 'erase', 'retry-context'] },
    handlers: { get: guarded(get), erase: guarded(erase), login: guarded(login), logout: guarded(logout) },
  }
}

serve(start)
