'use strict'
// A reference provider for the Verdaccio example (examples/verdaccio.md): two
// generated tokens, read-only and full, minted once at login with the
// password and kept in the store (the OS keychain in a real build), and a
// decision on each request which of the two to release. Nothing is refreshed:
// Verdaccio mints only with the password.
//
// What comes from the page: the operation mapping (reads and every
// /-/stage read with the read-only token; every write, and the full token,
// after user presence; `account` read-only first, the full token when a
// write is refused), `operation-not-supported` for `access` and `trust`, the
// `GET /-/whoami` probe on a retry, the answers `other` that name the cure,
// and the operator's provisioning for CI. Verdaccio's routes are the ones the
// page cites: PUT /-/user/org.couchdb.user:<name>, POST /-/npm/v1/tokens and
// DELETE /-/npm/v1/tokens/token/<key>.
//
// The registry is `--registry`, as the page configures it; the conformance
// run passes only `--config`, so the configuration's `registry` stands in.
// Where the person types a username and password, a real build asks on the
// terminal; context.js has no text prompt, so this provider reads them from
// the configuration's `scriptedLogin`. It sends no one-time password either,
// since the context's `request` has no header for `npm-otp`: a registry that
// asks for one is answered `other`. The operator's CI provisioning is
// `ciAccount`, the name of the account whose full token the machine holds.

const { serve, ok, err, log } = require('../lib/protocol.js')
const { loadContext } = require('../lib/context.js')

const CAPABILITIES = ['login', 'logout', 'erase', 'retry-context']
const READS = new Set(['read', 'stage-read'])
const WRITES = new Set(['stage', 'publish', 'stage-reject', 'deprecate', 'dist-tag', 'unpublish', 'owner'])
const TIERS = ['read', 'full']
// How a refused write names itself in a message.
const VERBS = { publish: 'publish to', stage: 'stage to' }
// An unverified `exp` is never trusted past this, nor a token with less than
// this left released: npm stops using an entry a minute before it expires.
const MARGIN_SECONDS = 60
const CEILING_SECONDS = 30 * 24 * 3600

// `exp` of a JWT, read without verifying it, or null for any other token: the
// default tokens are opaque AES strings that never expire.
const expiryOf = (token) => {
  const parts = token.split('.')
  if (parts.length !== 3) {
    return null
  }
  try {
    const { exp } = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return Number.isInteger(exp) ? exp : null
  } catch {
    return null
  }
}

const start = (args) => {
  const ctx = loadContext(args.config)
  const registry = args.registry || ctx.config.registry
  const url = (path) => `${registry}${path}`

  // what this provider keeps for this registry: { account, tokens: { read, full } },
  // each token { token, key }
  const readAccount = () => ctx.readStore()[registry] || null
  const writeAccount = (account) => {
    const store = ctx.readStore()
    if (account) {
      store[registry] = account
    } else {
      delete store[registry]
    }
    ctx.writeStore(store)
  }

  // the in-memory copies of the tokens, which erase drops
  const held = new Map()
  const tokenOf = (tier) => {
    if (!held.has(tier)) {
      const entry = (readAccount() || {}).tokens?.[tier]
      if (!entry) {
        return null
      }
      held.set(tier, entry.token)
    }
    return held.get(tier)
  }

  const whoami = async (token) => {
    const { status, json } = await ctx.request('GET', url('-/whoami'), { token })
    return { status, username: json && json.username }
  }

  const rejected = `The Verdaccio token for ${registry} was rejected. Run npm logout, then npm login.`

  // the answer for a token in hand: `session` for an opaque one, `expires`
  // from a decoded `exp`, clamped
  const release = (req, token, tier) => {
    const exp = expiryOf(token)
    const now = ctx.now()
    if (exp !== null && exp - now <= MARGIN_SECONDS) {
      return err('other', `The Verdaccio token for ${registry} has expired or has less than a minute left. Run npm logout, then npm login.`)
    }
    return ok('get', {
      auth: { type: 'bearer', token },
      ...(exp === null ? { cache: 'session' } : { cache: 'expires', expiresAt: Math.min(exp, now + CEILING_SECONDS) }),
      operationIndependent: false,
      granularity: tier === 'full' && req.package ? 'package' : 'registry',
    })
  }

  const get = async (req) => {
    if (req.registry !== registry) {
      return err('url-not-supported')
    }
    const write = WRITES.has(req.operation)
    if (!write && !READS.has(req.operation) && req.operation !== 'account') {
      // `access`, `trust` and what no version knows: before any prompt, and no credential is released
      return err('operation-not-supported')
    }
    const retry = req.retry === true
    const account = readAccount()
    if (!account) {
      // nothing held: `not-found` lets the chain go on, but not on a retry, where something was handed out
      return retry ? err('other', `No Verdaccio token is stored for ${registry}. Run npm login.`) : err('not-found')
    }

    let tier = write ? 'full' : 'read'
    let probed = null
    if (retry) {
      // The retry says only the status. A 401 on a token that still answers
      // whoami was specific to the request or the node: no token goes again,
      // since the same one could only fail the same way. A 403 does not say why, so whoami decides: 200 means the
      // registry's rules (or, for a read, nothing a bigger token changes);
      // anything else means the key is revoked or the address is outside its list.
      const current = tokenOf(tier)
      if (current) {
        probed = await whoami(current)
        if (probed.status !== 200) {
          return err('other', rejected)
        }
        if (req.httpStatus === 401) {
          // alive: the 401 was specific to the request or the node, not to the token, and no
          // other token is released for this request, so the same one again could only fail the same way
          return err('other', `Verdaccio says the token for ${registry} is still valid, so the 401 did not come from the token but from the registry or the URL. The provider holds no other credential it would release for this request, and no token is handed out again.`)
        }
        if (req.httpStatus === 403) {
          if (req.operation !== 'account') {
            return err('other', `Verdaccio refused ${req.operation} for this user at ${registry}; the token is alive, so the registry's rules refuse it and another token would not change that.`)
          }
          tier = 'full'
          probed = null
        }
      }
    }

    const token = tokenOf(tier)
    if (tier === 'read' || (tier === 'full' && req.interactive)) {
      if (!token) {
        return err('other', `No ${tier === 'full' ? 'full' : 'read-only'} Verdaccio token is stored for ${registry}. Run npm login.`)
      }
      if (tier === 'read') {
        return release(req, token, tier)
      }
    }

    if (!req.interactive) {
      const provisioned = token && ctx.config.ciAccount && account.account === ctx.config.ciAccount
      if (!provisioned) {
        return err('other', `${VERBS[req.operation] || `${req.operation} on`} ${registry} needs a full Verdaccio token and a user to approve it; none is available in CI`)
      }
      // the operator named the account; the token must be that account's
      const who = probed || (await whoami(token))
      if (who.status !== 200 || who.username !== ctx.config.ciAccount) {
        return err('other', `The full Verdaccio token on this machine is not a live token of ${ctx.config.ciAccount} at ${registry}.`)
      }
      return release(req, token, tier)
    }

    const subject = req.package ? ` ${req.scope ? `${req.scope}/` : ''}${req.package}${req.version ? `@${req.version}` : ''}` : ''
    if (!(await ctx.confirm(`Release the full Verdaccio token to ${req.operation}${subject} at ${registry}?`))) {
      return err('other', `The person did not approve the full Verdaccio token for ${req.operation}${subject}.`)
    }
    return release(req, token, tier)
  }

  // Drops the copy that was handed out. The tokens stay in the store, since
  // they are what is handed out and only logout removes them; `stage-read` is
  // served by the read-only token that `read` is still bound to.
  const erase = async (req) => {
    if (req.registry !== registry) {
      return err('url-not-supported')
    }
    if (req.operation === 'account') {
      TIERS.forEach((tier) => held.delete(tier))
    } else if (req.operation === 'read') {
      held.delete('read')
    } else if (WRITES.has(req.operation)) {
      held.delete('full')
    }
    return ok('erase')
  }

  // Revokes the generated tokens of an account, the read-only one first, with
  // the full one. Best effort: what fails is said on stderr and never stops
  // the rest.
  const revokeAll = async (account) => {
    const tokens = account.tokens || {}
    for (const tier of TIERS) {
      const entry = tokens[tier]
      if (!entry || !entry.key || !tokens.full) {
        log(`verdaccio: the ${tier} token was not revoked at the registry: it has no key, or there is no full token to authenticate the revocation`)
        continue
      }
      try {
        const { status } = await ctx.request('DELETE', url(`-/npm/v1/tokens/token/${encodeURIComponent(entry.key)}`), { token: tokens.full.token })
        if (status !== 200) {
          log(`verdaccio: the ${tier} token was not revoked at the registry (HTTP ${status})`)
        }
      } catch (error) {
        log(`verdaccio: could not reach the registry to revoke the ${tier} token: ${error.message}`)
      }
    }
  }

  const mintToken = async (loginToken, password, readonly) => {
    const { status, json } = await ctx.request('POST', url('-/npm/v1/tokens'), {
      token: loginToken,
      body: { password, readonly, ...(ctx.config.cidrWhitelist ? { cidr_whitelist: ctx.config.cidrWhitelist } : {}) },
    })
    if (status !== 200 || !json || !json.token) {
      throw new Error(`Verdaccio did not generate a ${readonly ? 'read-only' : 'full'} token at ${registry} (HTTP ${status}). Nothing was stored.`)
    }
    return { token: json.token, key: json.key }
  }

  const login = async (req) => {
    if (req.registry !== registry) {
      return err('url-not-supported')
    }
    if (!req.interactive) {
      return err('other', 'Signing in needs a terminal, and none is available.')
    }
    const previous = readAccount()
    if (req.token) {
      // the static-token flow: its tier and key cannot be learned without a write probe
      writeAccount({ tokens: { full: { token: req.token } } })
      held.clear()
      // the tokens this replaces are revoked, as a password login revokes its
      // predecessor's (unless the user hands back the very token already held)
      if (previous && !(previous.tokens && previous.tokens.full && previous.tokens.full.token === req.token)) {
        await revokeAll(previous)
      }
      return ok('login')
    }
    const typed = ctx.config.scriptedLogin
    if (!typed) {
      throw new Error('this reference provider has no terminal prompt for a password; the configuration gives it as scriptedLogin')
    }
    const { username, password } = typed
    const put = await ctx.request('PUT', url(`-/user/org.couchdb.user:${encodeURIComponent(username)}`), { body: { name: username, password } })
    if (put.status === 401 && /otp/i.test(put.headers['www-authenticate'] || '')) {
      return err('other', `Verdaccio asks for a one-time password at ${registry}; this provider cannot send one. Nothing was stored.`)
    }
    if (put.status === 401) {
      return err('other', `Verdaccio refused the login at ${registry}: bad username or password. Nothing was stored. Run npm login again.`)
    }
    if (!put.json || !put.json.token || (put.status !== 200 && put.status !== 201)) {
      return err('other', `Verdaccio did not accept the login at ${registry} (HTTP ${put.status}). Nothing was stored.`)
    }
    // the login token only authenticates the two calls below; it is discarded
    const loginToken = put.json.token
    const minted = {}
    try {
      minted.read = await mintToken(loginToken, password, true)
      minted.full = await mintToken(loginToken, password, false)
    } catch (error) {
      if (minted.read) {
        // the one generated token must not outlive the login that failed
        await ctx.request('DELETE', url(`-/npm/v1/tokens/token/${encodeURIComponent(minted.read.key)}`), { token: loginToken })
      }
      return err('other', error.message)
    }
    if (previous) {
      await revokeAll(previous)
    }
    writeAccount({ account: username, tokens: minted })
    held.clear()
    return ok('login')
  }

  const logout = async (req) => {
    if (req.registry !== registry) {
      return err('url-not-supported')
    }
    const account = readAccount()
    if (account) {
      await revokeAll(account)
      // only a password login made a login token; a supplied token made none
      if (account.account) {
        log('verdaccio: the login token cannot be revoked (DELETE /-/user/token/* does nothing); it works until the password or the server secret changes')
      }
      writeAccount(null)
      held.clear()
    }
    return ok('logout')
  }

  return {
    hello: { v: [1], capabilities: CAPABILITIES, registries: [registry] },
    handlers: { get, erase, login, logout },
  }
}

serve(start)
