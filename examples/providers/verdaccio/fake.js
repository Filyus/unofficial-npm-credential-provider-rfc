'use strict'
// A fake Verdaccio for the verdaccio example (examples/verdaccio.md),
// answering from a state the scenario sets and changing it as Verdaccio
// does. The behaviour is the page's: a bearer token names a user; a read-only
// generated token gets 403 on any method but GET; a revoked key gets 403 on
// every call; an anonymous request, and an expired or unknown login token,
// gets 401; what a user may do is decided by the groups of the first
// `packages` rule that matches the package, and a refusal by those rules is a
// 403 that does not say why. Response bodies are minimal; the provider reads
// statuses, and `token` and `key` of the token routes.
//
//   users      { name: { password, groups, tfa } }; `tfa: { mode, otp }` enrols the user in
//              2FA (flag `tfa`, off by default, experimental): `mode` is `auth-only` or
//              `auth-and-writes`, `otp` the one code the fake accepts. Login (after the
//              password is checked, as user.ts does) and token creation (before it, as the
//              route's middleware does) then need the code in `npm-otp`; without it, or with
//              a wrong one, the answer is 401 with `WWW-Authenticate: otp`, `npm-notice`
//              and the body of require-otp.ts. Writes are not modelled
//   rules      [ { pattern: "@acme/*", access, publish, stage } ], group names or
//              $all / $authenticated; the first match wins, no match refuses
//   tokens     { token: { user, readonly, key, dead, login } }, the table of live tokens;
//              `dead` is a revoked key. A token that is a JWT (three dot-separated parts,
//              the middle one JSON with `exp`) is anonymous once `exp` has
//              passed by the provider's clock, as an expired JWT is on master
//   mint       { read: [{ token, key }], full: [...] }: what the next generated
//              tokens are, per tier, in order
//   stages     { id: { package, version, stagedBy } }
// The fake adds: whoami (count), logins (count), otpChallenged and otpAccepted (counts), minted ([{ user, readonly }]),
// revoked (keys), published and staged ([{ package, version, user }]), rejected (ids).

const json = (status, body, headers) => ({ status, json: body, headers })
const UNAUTHORIZED = () => json(401, { error: 'authorization required' }, { 'www-authenticate': 'Bearer' })
const FORBIDDEN = () => json(403, { error: 'forbidden' })

// require-otp.ts: the header npm sets and the challenge it looks for
const OTP_REQUIRED = () =>
  json(401, { error: 'You must provide a one-time pass. Upgrade your client to npm@latest in order to use 2FA.' }, {
    'www-authenticate': 'otp',
    'npm-notice': 'Provide a one-time password from your authenticator app.',
  })

// the claims of a JWT, read without verifying, or null for any other token
const jwtClaims = (token) => {
  const parts = token.split('.')
  if (parts.length !== 3) {
    return null
  }
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

const createFake = (state) => {
  const prefix = state.prefix ?? '/verdaccio'
  state.users ??= {}
  state.rules ??= []
  state.tokens ??= {}
  state.mint ??= {}
  state.stages ??= {}
  state.whoami = 0
  state.logins = 0
  state.otpChallenged = 0
  state.otpAccepted = 0
  state.minted = []
  state.revoked = []
  state.published = []
  state.staged = []
  state.rejected = []
  let loginTokens = 0

  // who the request is: { user, readonly } or null, or { dead: true }
  const identify = ({ token, clock }) => {
    const entry = token && state.tokens[token]
    if (!entry) {
      return null
    }
    if (entry.dead) {
      return { dead: true }
    }
    const claims = jwtClaims(token)
    if (claims && typeof claims.exp === 'number' && claims.exp * 1000 <= clock) {
      return null
    }
    return entry
  }

  const groupsOf = (user) => (user && state.users[user] ? state.users[user].groups : [])
  const allowed = (list, user) =>
    (list || []).some((group) => group === '$all' || (user && (group === '$authenticated' || groupsOf(user).includes(group))))
  const ruleFor = (name) =>
    state.rules.find((rule) => (rule.pattern.endsWith('*') ? name.startsWith(rule.pattern.slice(0, -1)) : rule.pattern === name))

  // The rules' answer for one action on one package: ok, 401 for no user
  // where one is needed, 403 for a user the groups do not admit.
  const decide = (user, name, action) => {
    const rule = ruleFor(name)
    if (rule && allowed(rule[action], user)) {
      return null
    }
    return user ? FORBIDDEN() : UNAUTHORIZED()
  }

  // null where the user needs no code or sent the right one, else the challenge
  const otpGate = (request, name) => {
    const tfa = state.users[name] && state.users[name].tfa
    if (!tfa) {
      return null
    }
    const sent = request.headers && request.headers['npm-otp']
    if (sent && sent === tfa.otp) {
      state.otpAccepted += 1
      return null
    }
    state.otpChallenged += 1
    return OTP_REQUIRED()
  }

  const tokenRoutes = (request, user) => {
    const { method, path, body } = request
    if (method === 'POST' && path === '/-/npm/v1/tokens') {
      const challenge = otpGate(request, user)
      if (challenge) {
        return challenge
      }
      if (!body || state.users[user].password !== body.password) {
        return UNAUTHORIZED()
      }
      const next = (state.mint[body.readonly ? 'read' : 'full'] || []).shift()
      if (!next) {
        return json(500, { error: 'the fake has no token left to mint' })
      }
      state.tokens[next.token] = { user, readonly: Boolean(body.readonly), key: next.key }
      state.minted.push({ user, readonly: Boolean(body.readonly) })
      return json(200, { token: next.token, key: next.key, readonly: Boolean(body.readonly), cidr_whitelist: body.cidr_whitelist || [] })
    }
    const revoke = /^\/-\/npm\/v1\/tokens\/token\/(.+)$/.exec(path)
    if (method === 'DELETE' && revoke) {
      const [token, entry] = Object.entries(state.tokens).find(([, held]) => held.key === revoke[1] && held.user === user) || []
      if (!token) {
        return json(404, { error: 'no such key' })
      }
      entry.dead = true
      state.revoked.push(revoke[1])
      return json(200, {})
    }
    return null
  }

  return (request) => {
    const { method, body, query } = request
    if (!request.path.startsWith(`${prefix}/`)) {
      return null
    }
    request = { ...request, path: request.path.slice(prefix.length) }
    const { path } = request

    const login = /^\/-\/user\/org\.couchdb\.user:(.+)$/.exec(path)
    if (method === 'PUT' && login) {
      const name = decodeURIComponent(login[1])
      const user = state.users[name]
      if (!user || !body || user.password !== body.password) {
        return UNAUTHORIZED()
      }
      const challenge = otpGate(request, name)
      if (challenge) {
        return challenge
      }
      state.logins += 1
      loginTokens += 1
      const token = `login-token-${loginTokens}`
      state.tokens[token] = { user: name, readonly: false, login: true }
      return json(201, { ok: true, token })
    }

    // token-auth.ts runs before every route below
    const who = identify(request)
    if (who && who.dead) {
      return FORBIDDEN()
    }
    if (who && who.readonly && method !== 'GET') {
      return FORBIDDEN()
    }
    const user = who ? who.user : null

    if (method === 'GET' && path === '/-/whoami') {
      state.whoami += 1
      return user ? json(200, { username: user }) : UNAUTHORIZED()
    }
    const tokens = tokenRoutes(request, user)
    if (tokens) {
      return user ? tokens : UNAUTHORIZED()
    }

    // staging: the account that staged a version, or a publisher, may reject it
    const record = /^\/-\/stage\/([^/@]+)$/.exec(path)
    if (record && state.stages[record[1]]) {
      const stage = state.stages[record[1]]
      const publisher = !decide(user, stage.package, 'publish')
      if (method === 'GET') {
        return user && (stage.stagedBy === user || publisher) ? json(200, stage) : json(404, { error: 'not found' })
      }
      if (method === 'DELETE') {
        if (!user) {
          return UNAUTHORIZED()
        }
        if (stage.stagedBy !== user && !publisher) {
          return FORBIDDEN()
        }
        delete state.stages[record[1]]
        state.rejected.push(record[1])
        return json(200, {})
      }
    }
    const stagedPackage = /^\/-\/stage\/(@[^/]+\/[^/]+)$/.exec(path)
    if (method === 'PUT' && stagedPackage) {
      const refused = decide(user, stagedPackage[1], 'stage')
      if (refused) {
        return refused
      }
      state.staged.push({ package: stagedPackage[1], version: body.version, user })
      return json(201, { ok: true })
    }

    const named = /^\/(@[^/]+\/[^/]+)$/.exec(path)
    if (named && (method === 'GET' || method === 'PUT')) {
      const refused = decide(user, named[1], method === 'GET' ? 'access' : 'publish')
      if (refused) {
        return refused
      }
      if (method === 'PUT') {
        state.published.push({ package: named[1], version: query.version, user })
        return json(201, { ok: true })
      }
      return json(200, { name: named[1] })
    }
    return null
  }
}

module.exports = { createFake }
