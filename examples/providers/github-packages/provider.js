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
//   owners           { "@owner": "account" }: the account whose tokens serve that owner (an owner
//                    is compared in lower case, as GitHub names are, so "@Acme" serves @acme)
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
const { loadContext, plain } = require('../lib/context.js')

// npm kills a login, and a `get` that may wait for the person, at 5 minutes and a
// device code lives for 15, so the provider stops first. One budget per request: a
// presence prompt and the device flow that may follow it share it.
const WAIT_MS = 270 * 1000
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
  const owners = Object.fromEntries(Object.entries(ctx.config.owners || {}).map(([owner, account]) => [owner.toLowerCase(), account]))
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

  // GitHub's OAuth endpoints answer in a form unless asked for JSON
  const asJson = { accept: 'application/json' }

  // the person approves a code on github.com; what comes back is { token, scopes }.
  // `deadline` is the request's own, in clock milliseconds
  const deviceFlow = async (scope, deadline) => {
    const device = await ctx.request('POST', `${hosts.web}/login/device/code`, { form: { client_id: ctx.config.clientId, scope }, headers: asJson })
    if (device.json && device.json.error === 'device_flow_disabled') {
      throw new Answer(err('other', 'The OAuth app has the device flow disabled (device_flow_disabled). Enable it in the app settings, or log in with a token.'))
    }
    if (device.status !== 200 || !device.json || !device.json.device_code) {
      throw new Answer(err('other', `GitHub answered ${device.status} to the device authorization request`))
    }
    // with no terminal to show the code on nobody can approve it: stop before polling,
    // with nothing stored; the unused device code expires at GitHub on its own
    if (!ctx.showToPerson(`Open ${plain(device.json.verification_uri)} and enter the code ${plain(device.json.user_code)}`)) {
      throw new Answer(err('other', 'There is no terminal to show the sign-in on; run npm login from a terminal.'))
    }
    let wait = Math.max(1, device.json.interval ?? 5) * 1000
    const until = Math.min(ctx.clockMs() + (device.json.expires_in ?? 900) * 1000, deadline)
    while (ctx.clockMs() + wait <= until) {
      await ctx.sleep(wait)
      const res = await ctx.request('POST', `${hosts.web}/login/oauth/access_token`, {
        form: {
          client_id: ctx.config.clientId,
          device_code: device.json.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        },
        headers: asJson,
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

  const tokensOf = (accounts) => new Set(Object.values(accounts).flatMap((account) => Object.values(account)))

  // Best effort, and only for a token this provider stored: never `gh`'s token or
  // GITHUB_TOKEN, which it never stores. The credentials are already gone locally
  // when this runs, so a slow or failing GitHub costs nothing but the revocation.
  const revoke = async (tokens, what) => {
    if (!tokens.length) {
      return
    }
    try {
      const res = await ctx.request('POST', `${hosts.api}/credentials/revoke`, { body: { credentials: tokens } })
      if (res.status !== 202) {
        log(`${what}: GitHub answered ${res.status} to revoking the tokens; they stay valid until revoked in the settings`)
      }
    } catch {
      log(`${what}: the tokens could not be revoked`)
    }
  }

  // Keeps a token under every tier its scopes cover and returns the tokens it
  // replaced that nothing stored still holds: a token that is no longer kept is
  // one nobody can revoke, so the caller revokes it.
  const keep = (accountName, token, scopes) => {
    const accounts = readAccounts()
    const before = tokensOf(accounts)
    const account = accounts[accountName] || {}
    for (const [tier, scope] of Object.entries(TIER_SCOPES)) {
      if (scopes.includes(scope)) {
        account[`${tier}Token`] = token
      }
    }
    accounts[accountName] = account
    writeAccounts(accounts)
    const after = tokensOf(accounts)
    return [...before].filter((old) => !after.has(old))
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
    // A job is told from the environment, which is as trustworthy as the environment, and
    // the job's token is released with no presence: so only to a request that is not
    // interactive. npm decides that from the process and no CI, and in Actions it is
    // false; a terminal that merely exports GITHUB_ACTIONS and a GITHUB_TOKEN of its own
    // takes the stored token and the presence prompt below.
    const jobToken = !req.interactive && process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_TOKEN
    const jobOwner = (process.env.GITHUB_REPOSITORY_OWNER || '').toLowerCase()
    // the job's token covers its own repository's owner and nothing else; a package
    // with no scope is one GitHub proxies from npmjs.org, which only a read reaches
    if (jobToken && tier !== 'delete' && (req.scope ? req.scope.slice(1).toLowerCase() === jobOwner : tier === 'read')) {
      if (req.retry) {
        return err('other', 'GitHub rejected the job token (GITHUB_TOKEN). Check that the workflow grants it packages access and that the package grants the repository access.')
      }
      return ok('get', {
        auth: { type: 'bearer', token: jobToken },
        cache: 'session',
        operationIndependent: false,
        granularity: tier === 'write' ? 'package' : 'scope',
      })
    }

    const accountName = accountFor(req.scope)
    const account = readAccounts()[accountName] || {}
    const held = account[`${tier}Token`]
    // a write token can be obtained here by a device flow, which needs the person: an
    // interactive request, and the presence prompt below asks first
    const obtainable = tier === 'write' && req.interactive
    // a retry never starts a flow: a 401 or a 403 is no reason to log in, and nothing is stored to check
    if (!held && (!obtainable || req.retry)) {
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
      if (user.status === 401) {
        return err('other', `GitHub rejected the stored token for the ${accountName} account. Run npm logout and npm login for ${registryRoot}.`)
      }
      if (user.status !== 200) {
        // a 5xx, a rate limit or an SSO 403 says nothing about the token: it is not called dead
        return err('other', `GitHub answered ${user.status} when asked whether the stored token for the ${accountName} account is alive, so nothing is known about it. Try again, and run npm logout and npm login for ${registryRoot} only if GitHub then rejects it.`)
      }
      // alive: the 401 came from the URL or the registry, not from the token, and the provider
      // holds no other credential it would release for this request, so handing it out again
      // could only fail the same way
      return err('other', `GitHub says the ${accountName} account's token is still valid, so the 401 did not come from the token but from the registry or the URL. The provider holds no other credential it would release for this request, and no token is handed out again. Check the registry URL and the package's access settings.`)
    }

    // the presence prompt and the device flow that may follow it share one budget, so
    // that the whole `get` ends inside npm's 5 minutes for an interactive request
    const deadline = ctx.clockMs() + WAIT_MS
    if (tier !== 'read') {
      if (!req.interactive) {
        return err('other', 'a write credential needs the person to confirm, and this request is not interactive')
      }
      const what = plain(`${req.scope ? `${req.scope}/` : ''}${req.package}${req.version ? ` ${req.version}` : ''}`)
      const question =
        tier === 'delete'
          ? `Release a token that can delete packages, to delete ${what} (${accountName} account)?`
          : `Release a token that can write packages, for ${what} (${accountName} account)?`
      let answer
      try {
        answer = await ctx.confirmWithin(question, WAIT_MS)
      } catch (error) {
        if (error.syscall === 'open') {
          // the terminal cannot be opened: say so instead of passing the OS error on
          return err('other', 'There is no terminal to ask the person on; run the command from a terminal.')
        }
        throw error
      }
      if (answer === null) {
        return err('other', `The ${req.operation} of ${what} was not confirmed within 4 minutes 30 seconds. No credential was released.`)
      }
      if (!answer) {
        return err('other', `The ${req.operation} of ${what} was not confirmed. No credential was released.`)
      }
    }
    let token = held
    if (!token) {
      const granted = await deviceFlow(TIER_SCOPES[tier], deadline)
      await revoke(keep(accountName, granted.token, granted.scopes), 'get')
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
      granted = await deviceFlow(TIER_SCOPES.read, ctx.clockMs() + WAIT_MS)
    }
    // what the new token replaces is revoked, once the new one is stored
    await revoke(keep(accountName, granted.token, granted.scopes), 'login')
    return ok('login')
  }

  const logout = async (req) => {
    if (!served(req.registry)) {
      return err('url-not-supported')
    }
    const tokens = [...tokensOf(readAccounts())]
    if (!tokens.length) {
      return err('not-found')
    }
    // the credentials go first, as the RFC has it, so that a GitHub that is slow or
    // down cannot keep them: the revocation that follows is a best effort
    writeAccounts({})
    await revoke(tokens, 'logout')
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
