'use strict'
// A fake Verdaccio for the verdaccio example (examples/verdaccio.md),
// answering from a state the scenario sets and changing it as Verdaccio
// does. The behaviour is the page's: a bearer token names a user; a read-only
// generated token gets 403 on any method but GET; a revoked key gets 403 on
// every call; an anonymous request, and an expired or unknown login token,
// gets 401; what a user may do is decided by the groups of the first
// `packages` rule that matches the package, and a refusal by those rules is a
// 403 that does not say why. Response bodies carry the keys a real Verdaccio's
// do and little else; the provider reads statuses, and `token` and `key` of the
// token routes.
//
// What a real server answers is checked by examples/providers/live/verdaccio.js,
// which runs the provider against Verdaccio 6.10.6 and the 7.x line and fails on
// any difference (statuses, the headers a client reads, the keys of a body) that
// live/verdaccio-divergences.json does not list. These come from there, not from
// the page: a bare PUT of the login route is the add-user path, which answers 409
// for a user that exists, and the login is the same call with the password in
// Basic; a token create answers the user, key, cidr, readonly and created; the
// token list exists; revoking a key nobody holds is a 200; a packument has a
// `_rev`, a publish answers `ok` and `success`; every answer has `Vary:
// Accept-Encoding` and a 401 has `WWW-Authenticate: Basic, Bearer`.
//
//   users      { name: { password, groups, tfa } }; `tfa: { mode, otp }` enrols the user in
//              2FA (flag `tfa`, off by default, experimental): `mode` is `auth-only` or
//              `auth-and-writes`, `otps` the codes the fake accepts, each once (Verdaccio's
//              TfaStore refuses a TOTP step it has accepted, `lastUsedStep`, so a replayed
//              code is a challenge again; `otp`, one code, is the same with a list of one). The
//              login (the Basic call, after the password is checked, as user.ts does) and token
//              creation (before it, as the route's middleware does) then need the code in
//              `npm-otp`; without it, or with a wrong one, the answer is 401 with
//              `WWW-Authenticate: otp`, `npm-notice` and the body of require-otp.ts. Writes are
//              not modelled
//   rules      [ { pattern: "@acme/*", access, publish, stage } ], group names or
//              $all / $authenticated; the first match wins, no match refuses
//   tokens     { token: { user, readonly, key, dead, login } }, the table of live tokens;
//              `dead` is a revoked key. A token that is a JWT (three dot-separated parts,
//              the middle one JSON with `exp`) is anonymous once `exp` has
//              passed by the provider's clock, as an expired JWT is on master
//   mint       { read: [{ token, key }], full: [...] }: what the next generated
//              tokens are, per tier, in order
//   stages     { id: { package, version, stagedBy } }, served only with `flags.stage`
//   flags      { stage }: the 7.x line's staging routes (`/-/stage`), absent from 6.x
//   registration  'closed' (the default: a bare PUT of the login route answers 409 whatever the
//              password) or 'open' (Verdaccio's default: it registers an unknown user, answers
//              409 for a known one with the right password and 401 for the wrong one)
//   packages   { name: [versions] }: what the registry holds; DEFAULT_PACKAGES when absent
// The fake adds: whoami (count), logins (count), otpChallenged and otpAccepted (counts), minted ([{ user, readonly }]),
// revoked (keys), published and staged ([{ package, version, user }]), rejected (ids).

// The test package the registry holds unless a scenario says otherwise; the live run
// publishes the same one to a real server before the scenario starts.
const DEFAULT_PACKAGES = { '@acme/widget': ['2.4.0'] }

const COMMON = { vary: 'Accept-Encoding' }
const json = (status, body, headers) => ({ status, json: body, headers: { ...COMMON, ...headers } })
const NO_STORE = { 'cache-control': 'no-cache, no-store' }
const UNAUTHORIZED = () => json(401, { error: 'Unauthorized' }, { 'www-authenticate': 'Basic, Bearer' })
const FORBIDDEN = () => json(403, { error: 'unauthorized access' })

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

// `Authorization: Basic base64(name:password)`, or null
const basicOf = (request) => {
  const header = (request.headers && request.headers.authorization) || ''
  if (!/^Basic /i.test(header)) {
    return null
  }
  const text = Buffer.from(header.slice(6), 'base64').toString('utf8')
  const at = text.indexOf(':')
  return at < 0 ? null : { name: text.slice(0, at), password: text.slice(at + 1) }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const createFake = (state) => {
  const prefix = state.prefix ?? '/verdaccio'
  state.users ??= {}
  state.rules ??= []
  state.tokens ??= {}
  state.mint ??= {}
  state.stages ??= {}
  state.flags ??= {}
  state.packages ??= structuredClone(DEFAULT_PACKAGES)
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
  let created = 0

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
    const used = (tfa.used ??= [])
    if (sent && (tfa.otps || [tfa.otp]).includes(sent) && !used.includes(sent)) {
      used.push(sent)
      state.otpAccepted += 1
      return null
    }
    state.otpChallenged += 1
    return OTP_REQUIRED()
  }

  const mask = (token) => `${token.slice(0, 5)}...${token.slice(-5)}`

  const tokenRoutes = (request, user) => {
    const { method, path, body } = request
    if (path === '/-/npm/v1/tokens' && !user) {
      return UNAUTHORIZED()
    }
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
      created += 1
      return json(200, { token: next.token, user, key: next.key, cidr: body.cidr_whitelist || [], readonly: Boolean(body.readonly), created: new Date(created * 1000).toISOString() }, NO_STORE)
    }
    if (method === 'GET' && path === '/-/npm/v1/tokens') {
      const objects = Object.entries(state.tokens)
        .filter(([, entry]) => entry.user === user && entry.key && !entry.dead)
        .map(([token, entry]) => ({ user, token: mask(token), key: entry.key, cidr: [], readonly: Boolean(entry.readonly), created: new Date(0).toISOString() }))
      return json(200, { objects, urls: {} })
    }
    const revoke = /^\/-\/npm\/v1\/tokens\/token\/(.+)$/.exec(path)
    if (method === 'DELETE' && revoke) {
      // a key the caller does not hold is not an error: nothing is removed and the answer is 200
      const key = decodeURIComponent(revoke[1])
      const [token, entry] = Object.entries(state.tokens).find(([, held]) => held.key === key && held.user === user) || []
      if (token) {
        entry.dead = true
        state.revoked.push(key)
      }
      return json(200, {})
    }
    return null
  }

  // the packument of a package the registry holds
  const packumentOf = (name) => ({
    _id: name,
    _rev: '1-0',
    name,
    readme: '',
    time: {},
    users: {},
    'dist-tags': {},
    versions: {},
    _attachments: {},
  })

  // `/@scope%2fname` as npm sends it, or `/@scope/name`
  const packageOf = (path) => {
    const match = /^\/(@[^/%]+(?:%2f|\/)[^/%]+)$/i.exec(path)
    return match ? match[1].replace(/%2f/i, '/') : null
  }

  const route = (request) => {
    const { method, body } = request
    const { path } = request

    // the login route: a bare PUT is the add-user path, and a PUT with the password in Basic is the login
    const login = /^\/-\/user\/org\.couchdb\.user:([^/]+)(?:\/-rev\/[^/]+)?$/.exec(path)
    if (method === 'PUT' && login) {
      const name = decodeURIComponent(login[1])
      const basic = basicOf(request)
      if (basic && basic.name === name && body && body.name === name && state.users[name] && state.users[name].password === basic.password) {
        const challenge = otpGate(request, name)
        if (challenge) {
          return challenge
        }
        state.logins += 1
        loginTokens += 1
        const token = `login-token-${loginTokens}`
        state.tokens[token] = { user: name, readonly: false, login: true }
        return json(201, { ok: `you are authenticated as '${name}'`, token }, NO_STORE)
      }
      const user = state.users[name]
      if (state.registration === 'open') {
        if (!user && body && body.name === name) {
          state.users[name] = { password: body.password, groups: [] }
          state.logins += 1
          loginTokens += 1
          const token = `login-token-${loginTokens}`
          state.tokens[token] = { user: name, readonly: false, login: true }
          return json(201, { ok: `user '${name}' created`, token }, NO_STORE)
        }
        if (user && body && user.password !== body.password) {
          return json(401, { error: 'unauthorized access' }, { 'www-authenticate': 'Basic, Bearer' })
        }
        return json(409, { error: 'username is already registered' })
      }
      return json(409, { error: 'user registration disabled' })
    }

    // token-auth.ts runs before every route below
    const basic = basicOf(request)
    const who = identify(request)
    if (who && who.dead) {
      return FORBIDDEN()
    }
    if (who && who.readonly && method !== 'GET') {
      return FORBIDDEN()
    }
    const user = who ? who.user : basic && state.users[basic.name] && state.users[basic.name].password === basic.password ? basic.name : null

    if (method === 'GET' && path === '/-/ping') {
      return json(200, {})
    }
    if (method === 'GET' && path === '/-/whoami') {
      state.whoami += 1
      return user ? json(200, { username: user }) : UNAUTHORIZED()
    }
    const tokens = tokenRoutes(request, user)
    if (tokens) {
      return user ? tokens : UNAUTHORIZED()
    }

    // staging, behind `flags.stage` (the 7.x line): the account that staged a version, or a
    // publisher, may see and reject it; the id is a UUID
    if (state.flags.stage && path.startsWith('/-/stage/')) {
      const staged = /^\/-\/stage\/package\/(.+)$/.exec(path)
      if (method === 'POST' && staged) {
        if (!user) {
          return UNAUTHORIZED()
        }
        const name = decodeURIComponent(staged[1])
        const refused = decide(user, name, 'stage')
        if (refused) {
          return refused
        }
        state.staged.push({ package: name, version: Object.keys((body && body.versions) || {})[0], user })
        return json(201, { message: 'Package version staged successfully.', stageId: '00000000-0000-4000-8000-000000000002' })
      }
      const record = /^\/-\/stage\/([^/]+)$/.exec(path)
      if (record && UUID.test(record[1])) {
        if (!user) {
          return UNAUTHORIZED()
        }
        const stage = state.stages[record[1]]
        const publisher = stage && !decide(user, stage.package, 'publish')
        const visible = stage && (stage.stagedBy === user || publisher)
        if (!visible) {
          return json(404, { error: 'no such staged package version' })
        }
        if (method === 'GET') {
          return json(200, stage)
        }
        if (method === 'DELETE') {
          delete state.stages[record[1]]
          state.rejected.push(record[1])
          return { status: 204, headers: COMMON }
        }
      }
    }

    const name = packageOf(path)
    if (name && (method === 'GET' || method === 'PUT')) {
      const refused = decide(user, name, method === 'GET' ? 'access' : 'publish')
      if (refused) {
        return refused
      }
      if (method === 'PUT') {
        const version = Object.keys((body && body.versions) || {})[0]
        if (state.packages[name] && state.packages[name].includes(version)) {
          return json(409, { error: 'this package is already present' })
        }
        state.published.push({ package: name, version, user })
        ;(state.packages[name] ??= []).push(version)
        return json(201, { ok: 'created new package', success: true })
      }
      return state.packages[name] ? json(200, packumentOf(name)) : json(404, { error: 'no such package available' })
    }
    return null
  }

  return (request) => {
    if (!request.path.startsWith(`${prefix}/`)) {
      return null
    }
    return route({ ...request, path: request.path.slice(prefix.length) }) || json(404, { error: 'no such package available' })
  }
}

module.exports = { createFake, DEFAULT_PACKAGES }
