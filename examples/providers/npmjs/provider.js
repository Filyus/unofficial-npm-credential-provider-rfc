'use strict'
// A reference npmjs.com credential provider, written from examples/npmjs.md.
// It mints nothing: it hands out tokens the user created (kept in the store
// as `tokens`, one entry per token with its tier and the packages it selects)
// and the session token its own web login stored.
//
// Store layout (stands in for the OS keychain):
//   { tokens: [ { tier, token, selects, issuedAt } ] }
//   tier: read | stage-read | stage-only | publish | trust | session
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
// inside npm's 5-minute budget for `login` and an interactive `get`: the provider
// ends a presence prompt itself, first
const WAIT_MS = 4.5 * 60 * 1000
const WAIT_TEXT = '4 minutes 30 seconds'

// What the person's terminal is shown from outside the provider (a package name
// in a prompt, the registry's `loginUrl`): a control character in it could move
// the cursor or rewrite the line above, so each becomes `?`.
const plain = (text) => String(text).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, '?')

// The time npm gives a `logout` is 30 seconds; the calls it makes end inside it.
const LOGOUT_MS = 25 * 1000

// What a pasted token's selection may name: a scope or a package, as the npm
// registry spells them (lowercase, no control characters or spaces).
const SCOPE_NAME = /^@[a-z0-9~-][a-z0-9._~-]*$/
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/

const HELLO = {
  v: [1],
  capabilities: ['login', 'logout', 'erase', 'retry-context'],
  registries: [REGISTRY],
}

// Which token tiers serve which operation. `write` operations get the
// presence policy; stage-only tokens are the ones the user pre-authorized
// for CI (examples/npmjs.md, CI). A token never serves a tier it is not
// listed for, so the read token is never handed out for a publish and the
// stage-read token never for a read. `escalatesTo` is the one tier a 403 may
// move an operation up to: where an operation spans two tiers, the RFC lets a
// provider start with the lower credential and move up on a 403 "under the
// same policy and its presence checks" (Operations). It is not a tier the
// first answer comes from, and it needs a new presence prompt.
const OPERATIONS = {
  read: { tiers: ['read'], write: false },
  'stage-read': { tiers: ['stage-read'], write: false },
  stage: { tiers: ['stage-only'], write: true },
  deprecate: { tiers: ['stage-only'], write: true },
  'dist-tag': { tiers: ['stage-only'], write: true },
  publish: { tiers: ['publish'], escalatesTo: ['session'], write: true },
  // a granular token, not the session token that serves `access`: as
  // documented, the session token does not serve `trust`
  trust: { tiers: ['trust'], write: true },
  unpublish: { tiers: ['publish', 'session'], escalatesTo: ['session'], write: true },
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
      // a trusted-publisher credential is bound to the package it is asked for,
      // whatever the token selects
      granularity: request.operation === 'trust' ? 'package' : covers,
    })
  }

  const describe = (request) => {
    const name = fullName(request)
    return plain(`${request.operation}${name ? ` ${name}${request.version ? ` ${request.version}` : ''}` : ''}`)
  }

  // The whoami check before declaring a login dead: the 401 may be one a
  // lockfile chose, so ask the registry about the token itself. `true`: it
  // knows the token; `false`: it says it does not (401); `null`: it did not
  // say (a 5xx, a 403, no answer), which proves nothing either way.
  const tokenIsLive = async (token) => {
    try {
      const { status } = await ctx.request('GET', `${REGISTRY}-/whoami`, { token })
      if (status === 200) {
        return true
      }
      return status === 401 ? false : null
    } catch {
      return null
    }
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
        const granted = await ctx.confirmWithin(`Allow ${describe(request)} on ${REGISTRY}?`, WAIT_MS)
        if (granted === null) {
          return err('other', `Presence was not given for ${describe(request)} within ${WAIT_TEXT}.`)
        }
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
    // own properties only: an operation named `constructor` is not a tier
    const op = Object.hasOwn(OPERATIONS, request.operation) ? OPERATIONS[request.operation] : null
    if (!op) {
      return err('operation-not-supported')
    }
    if (request.retry && request.httpStatus === 401) {
      const found = candidates(op.tiers, request)
      const what = `${request.operation} token${request.scope ? ` for ${request.scope}` : ''}`
      if (!found.length) {
        // a retry is never `not-found`: what was rejected has been removed from the store since
        return err('other', `No stored ${what} is left for this request; run npm login.`)
      }
      const live = await tokenIsLive(found[0].entry.token)
      if (live === false) {
        return err('other', `The stored ${what} was rejected. Run npm logout and npm login.`)
      }
      if (live === null) {
        return err('other', `The registry would not say whether the stored ${what} is valid, so nothing was concluded; try again.`)
      }
      // alive: the 401 came from the URL or the registry, not from the token, and no other
      // credential is released for this request, so the same token again could only fail the same way
      return err(
        'other',
        `npm says the stored ${what} is still valid, so the 401 did not come from the token but from the registry or the URL. No other credential is released for this request, and no token is handed out again.`,
      )
    } else if (request.retry && request.httpStatus === 403) {
      // widen only an operation that names a tier to escalate to (a publish or an unpublish),
      // only from a token that was neither stage-only nor the session token, only to that
      // tier, under the write policy and a new presence prompt
      const first = handedOut.get(contextKey(request)) || (candidates(op.tiers, request)[0] || {}).entry?.tier
      const widens = Boolean(op.escalatesTo) && first !== 'stage-only' && first !== 'session'
      if (!widens) {
        return err('other', `${request.operation} was refused with 403 and no other credential is released for it.`)
      }
      const widened = await release(request, op.escalatesTo)
      // nothing wider is stored: the retry could only fail the same way
      return widened.Err && widened.Err.kind === 'not-found'
        ? err('other', `${request.operation} was refused with 403 and no other credential is released for it.`)
        : widened
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

  // A pasted granular token comes with no label, and the session-only token
  // list can tell neither its tier nor its package selection, so the person is
  // asked what it is for and what it selects; a write token stored as the read
  // credential would go out with every install, and one stored for the whole
  // registry would be reused by npm for every scope though the registry answers
  // 404 outside the selection. The selection is typed (a scope, a package, a
  // list of them, empty for all packages) and is what `granularity` follows.
  // A read-only token that selects all packages may also be kept for the
  // staged-version lookup only, and not for installs: that lookup names no
  // package, so only such a token can serve it.
  const PASTED_TIERS = [
    ['read', 'a read-only token'],
    ['stage-only', 'a stage-only token'],
    ['publish', 'a publish-and-stage token'],
  ]
  // `null` for no answer in time, a `selects` for an answer, `false` for one that names nothing valid
  const parseSelection = (line) => {
    const names = line.split(',').map((name) => name.trim()).filter(Boolean)
    if (!names.length) {
      return { all: true }
    }
    const scopes = names.filter((name) => SCOPE_NAME.test(name))
    const packages = names.filter((name) => !SCOPE_NAME.test(name) && PACKAGE_NAME.test(name))
    if (scopes.length + packages.length !== names.length) {
      return false
    }
    return { ...(scopes.length ? { scopes } : {}), ...(packages.length ? { packages } : {}) }
  }
  const storePasted = async (request) => {
    if (!request.interactive) {
      return err('other', 'A pasted token is stored only after the person says what it is for; this request is not interactive.')
    }
    // one deadline for the questions of this request
    const until = ctx.clockMs() + WAIT_MS
    const ask = (question) => {
      const left = until - ctx.clockMs()
      return left > 0 ? ctx.confirmWithin(question, left) : null
    }
    const askLine = (question) => {
      const left = until - ctx.clockMs()
      return left > 0 ? ctx.askWithin(question, left) : null
    }
    const unanswered = () => err('other', `The pasted token was not stored: nobody answered within ${WAIT_TEXT}.`)
    for (const [asked, label] of PASTED_TIERS) {
      const answer = await ask(`Is the pasted token ${label}?`)
      if (answer === null) {
        return unanswered()
      }
      if (answer) {
        const line = await askLine('Which scopes or packages does the token select (@acme, @acme/widgets, separated by commas)? Empty for all packages:')
        if (line === null) {
          return unanswered()
        }
        const selects = parseSelection(line)
        if (!selects) {
          return err('other', `The pasted token was not stored: ${plain(line.trim())} is not a list of scopes (@acme) and package names.`)
        }
        let tier = asked
        if (asked === 'read' && selects.all) {
          const aside = await ask('Is it to be kept for the lookup of staged versions only, not for installs?')
          if (aside === null) {
            return unanswered()
          }
          tier = aside ? 'stage-read' : 'read'
        }
        const store = ctx.readStore()
        const tokens = [...(store.tokens || []), { tier, token: request.token, selects, issuedAt: ctx.now() }]
        ctx.writeStore({ ...store, tokens })
        return ok('login')
      }
    }
    return err('other', 'The pasted token was not stored: it is none of the kinds this provider hands out.')
  }

  const login = async (request) => {
    if (request.token) {
      return storePasted(request)
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
    // nobody can finish a login that was not shown: stop before the first poll,
    // with nothing stored (the unused login at the registry lapses on its own)
    if (!ctx.showToPerson(`Open ${plain(loginUrl)} to log in to npmjs.com`)) {
      return err('other', 'There is no terminal to show the login on; run npm login --registry https://registry.npmjs.org/ from a terminal.')
    }
    // the registry's Retry-After decides the wait; without one, the interval.
    // `pollMs`, `loginSeconds` and `pollLimit` are knobs of the configuration
    // for a run (a poll of 20 ms, a shorter login); the page does not name them
    const interval = ctx.config.pollMs ?? 2000
    // npm gives a login five minutes; a poll that must wait longer than what is left
    // would fail anyway, and a delay beyond 2^31 ms makes a timer fire at once
    const until = ctx.clockMs() + (ctx.config.loginSeconds ?? 270) * 1000
    for (let attempt = 0; attempt < (ctx.config.pollLimit ?? 300); attempt += 1) {
      // a poll that hangs is cut at 15 s, so the last one still ends inside npm's 5 minutes
      const polled = await ctx.request('GET', doneUrl, { timeoutMs: 15000 })
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
      const retryAfter = Number(polled.headers['retry-after'])
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : interval
      if (ctx.clockMs() + wait > until) {
        return err('other', `The registry asked for ${Math.ceil(wait / 1000)} seconds before the next poll, longer than this login has left.`)
      }
      await ctx.sleep(wait)
    }
    return err('other', 'The web login was not completed in time.')
  }

  const logout = async () => {
    const store = ctx.readStore()
    const tokens = store.tokens || []
    if (!tokens.length) {
      return err('not-found')
    }
    // the local tokens go first, so that nothing the registry does or fails to do keeps
    // them: the revocation is a best effort with the token in hand, cut at its budget
    ctx.writeStore({ ...store, tokens: [] })
    const until = ctx.clockMs() + LOGOUT_MS
    for (const entry of tokens.filter((t) => t.tier === 'session')) {
      try {
        await ctx.request('DELETE', `${REGISTRY}-/user/token/${encodeURIComponent(entry.token)}`, { token: entry.token, until })
      } catch {
        log('npmjs: could not revoke the session token; it expires on its own')
      }
    }
    const granular = tokens.filter((t) => t.tier !== 'session').length
    if (granular) {
      log(`npmjs: removed ${granular} granular token(s) locally; revoke them on npmjs.com, which needs a one-time password`)
    }
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
