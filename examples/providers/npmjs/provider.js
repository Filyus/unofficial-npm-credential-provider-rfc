'use strict'
// A reference npmjs.com credential provider, written from examples/npmjs.md.
// It mints nothing: it hands out tokens the user created (kept in the store
// as `tokens`, one entry per token with its tier and the packages it selects)
// and the session token its own web login stored.
//
// Store layout (stands in for the OS keychain):
//   { tokens: [ { tier, token, selects, issuedAt } ] }
//   tier: read | stage-read | stage-only | publish | session
//   selects: { all: true } | { scopes: ['@acme'] } | { packages: ['@acme/widgets'] }
//
// API paths: /-/whoami, /-/v1/login (+ its doneUrl) and DELETE
// /-/user/token/<token> are the ones examples/npmjs.md cites. The response
// shapes (whoami answers 200 with a username and 401 for a bad token; the
// done poll answers 202 until the person finishes) are recalled, not read.

const { serve, ok, err, log } = require('../lib/protocol.js')
const { loadContext } = require('../lib/context.js')

const REGISTRY = 'https://registry.npmjs.org/'
const SESSION_SECONDS = 7200 // the session token's two hours; the API gives no expiry

const HELLO = {
  v: [1],
  capabilities: ['login', 'logout', 'erase', 'retry-context'],
  registries: [REGISTRY],
}

// Which token tiers serve which operation. `write` operations get the
// presence policy; stage-only tokens are the ones the user pre-authorized
// for CI (examples/npmjs.md, CI). A token never serves a tier it is not
// listed for, so the read token is never handed out for a publish and the
// stage-read token never for a read.
const OPERATIONS = {
  read: { tiers: ['read'], write: false },
  'stage-read': { tiers: ['stage-read'], write: false },
  stage: { tiers: ['stage-only'], write: true },
  deprecate: { tiers: ['stage-only'], write: true },
  'dist-tag': { tiers: ['stage-only'], write: true },
  publish: { tiers: ['publish'], write: true },
  unpublish: { tiers: ['publish', 'session'], write: true },
  owner: { tiers: ['session'], write: true },
  'stage-reject': { tiers: ['session'], write: true },
  access: { tiers: ['session'], write: true },
  account: { tiers: ['session'], write: true },
}

const fullName = (request) => (request.package ? `${request.scope ? `${request.scope}/` : ''}${request.package}` : null)

// How narrowly an entry's selection covers the request; null when it does not.
const coverage = (entry, request) => {
  const selects = entry.selects || { all: true }
  const name = fullName(request)
  if (name && (selects.packages || []).includes(name)) {
    return 'package'
  }
  if (request.scope && (selects.scopes || []).includes(request.scope)) {
    return 'scope'
  }
  if (selects.all) {
    return 'registry'
  }
  return null
}
const RANK = { package: 0, scope: 1, registry: 2 }

const sessionExpiresAt = (entry) => entry.issuedAt + SESSION_SECONDS

const create = async (args) => {
  const ctx = loadContext(args.config)
  // What was handed out per context, so a 403 retry can tell whether the
  // first token was stage-only (the retry names the context, not the token).
  const handedOut = new Map()
  const contextKey = (request) => `${request.operation}|${request.scope || ''}|${request.package || ''}`

  const candidates = (tiers, request) =>
    (ctx.readStore().tokens || [])
      .filter((entry) => tiers.includes(entry.tier))
      .map((entry) => ({ entry, covers: coverage(entry, request) }))
      .filter(({ covers }) => covers)
      .sort((a, b) => RANK[a.covers] - RANK[b.covers])

  const answerFor = ({ entry, covers }, request) => {
    if (entry.tier === 'session') {
      // a session token is the user's full permissions: bind it to the
      // package a write names, to the registry otherwise
      return ok('get', {
        auth: { type: 'bearer', token: entry.token },
        cache: 'expires',
        expiresAt: sessionExpiresAt(entry),
        operationIndependent: false,
        granularity: request.package ? 'package' : 'registry',
      })
    }
    return ok('get', {
      auth: { type: 'bearer', token: entry.token },
      cache: 'session',
      operationIndependent: false,
      granularity: covers,
    })
  }

  const describe = (request) => {
    const name = fullName(request)
    return `${request.operation}${name ? ` ${name}${request.version ? ` ${request.version}` : ''}` : ''}`
  }

  // The whoami check before declaring a login dead: the 401 may be one a
  // lockfile chose, so ask the registry about the token itself.
  const tokenIsLive = async (token) => {
    const { status } = await ctx.request('GET', `${REGISTRY}-/whoami`, { token })
    return status !== 401
  }

  const release = async (request, tiers) => {
    const op = OPERATIONS[request.operation]
    const found = candidates(tiers, request)
    if (!found.length) {
      return err('not-found')
    }
    const pick = found[0]
    if (pick.entry.tier === 'session' && ctx.now() >= sessionExpiresAt(pick.entry)) {
      return err('other', 'The stored session token has expired. Run npm login.')
    }
    if (op.write) {
      if (request.interactive) {
        const granted = await ctx.confirm(`Allow ${describe(request)} on ${REGISTRY}?`)
        if (!granted) {
          return err('other', `Presence was declined for ${describe(request)}.`)
        }
      } else if (pick.entry.tier !== 'stage-only') {
        return err('other', `${describe(request)} needs user presence, and this request is not interactive.`)
      }
    }
    handedOut.set(contextKey(request), pick.entry.tier)
    return answerFor(pick, request)
  }

  const get = async (request) => {
    const op = OPERATIONS[request.operation]
    if (!op) {
      return err('operation-not-supported')
    }
    if (request.retry && request.httpStatus === 401) {
      const found = candidates(op.tiers, request)
      if (found.length && !(await tokenIsLive(found[0].entry.token))) {
        return err(
          'other',
          `The stored ${request.operation} token${request.scope ? ` for ${request.scope}` : ''} was rejected. Run npm logout and npm login.`,
        )
      }
    } else if (request.retry && request.httpStatus === 403) {
      // widen only a publish, only from a token that was not stage-only, only
      // to the session token, under the write policy and a new presence prompt
      const first = handedOut.get(contextKey(request)) || (candidates(op.tiers, request)[0] || {}).entry?.tier
      const widens = ['publish', 'unpublish'].includes(request.operation) && first !== 'stage-only' && first !== 'session'
      if (!widens) {
        return err('other', `${request.operation} was refused with 403 and no other credential is released for it.`)
      }
      return release(request, ['session'])
    }
    return release(request, op.tiers)
  }

  const erase = async (request) => {
    // drops what was handed out, never what login stored; the stored token
    // is what is handed out, so it stays and the rejection is reported
    handedOut.delete(contextKey(request))
    log(`npmjs: a ${request.operation} credential was rejected; if it is no longer valid, run npm logout and npm login`)
    return ok('erase')
  }

  const login = async (request) => {
    if (request.token) {
      return err('other', 'A pasted token has no label here; add granular tokens with the provider command line, not login.')
    }
    if (!request.interactive) {
      return err('other', 'A web login needs the person at the terminal; this request is not interactive.')
    }
    const started = await ctx.request('POST', `${REGISTRY}-/v1/login`, { body: {} })
    const { loginUrl, doneUrl } = started.json || {}
    if (started.status !== 200 || !loginUrl || !doneUrl) {
      return err('other', `The registry did not start a web login (status ${started.status}).`)
    }
    // the poll goes to the registry only, with no credential attached
    if (new URL(doneUrl).origin !== REGISTRY.slice(0, -1)) {
      return err('other', 'The registry named a doneUrl outside its own origin; not following it.')
    }
    ctx.showToPerson(`Open ${loginUrl} to log in to npmjs.com`)
    // Retry-After is not visible through ctx.request, so the wait is fixed
    const wait = ctx.config.pollMs ?? 2000
    for (let attempt = 0; attempt < (ctx.config.pollLimit ?? 300); attempt += 1) {
      const polled = await ctx.request('GET', doneUrl)
      if (polled.status === 200 && polled.json && polled.json.token) {
        const store = ctx.readStore()
        const tokens = (store.tokens || []).filter((entry) => entry.tier !== 'session')
        tokens.push({ tier: 'session', token: polled.json.token, selects: { all: true }, issuedAt: ctx.now() })
        ctx.writeStore({ ...store, tokens })
        return ok('login')
      }
      if (polled.status !== 202) {
        return err('other', `The web login ended with status ${polled.status}.`)
      }
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
    return err('other', 'The web login was not completed in time.')
  }

  const logout = async () => {
    const store = ctx.readStore()
    const tokens = store.tokens || []
    if (!tokens.length) {
      return err('not-found')
    }
    for (const entry of tokens.filter((t) => t.tier === 'session')) {
      try {
        await ctx.request('DELETE', `${REGISTRY}-/user/token/${encodeURIComponent(entry.token)}`, { token: entry.token })
      } catch {
        log('npmjs: could not revoke the session token; it expires on its own')
      }
    }
    const granular = tokens.filter((t) => t.tier !== 'session').length
    if (granular) {
      log(`npmjs: removed ${granular} granular token(s) locally; revoke them on npmjs.com, which needs a one-time password`)
    }
    ctx.writeStore({ ...store, tokens: [] })
    return ok('logout')
  }

  // url-not-supported is decided from the registry alone, first
  const only = (handler) => async (request) =>
    request.registry === REGISTRY ? handler(request) : err('url-not-supported')

  return {
    hello: HELLO,
    handlers: { get: only(get), erase: only(erase), login: only(login), logout: only(logout) },
  }
}

serve(create)
