'use strict'
// The Verdaccio reference provider against a real Verdaccio server.
//
//   node examples/providers/live/verdaccio.js [--version 6.10.6] [--install-dir <dir>] [--only <scenario>,...]
//
// The fake of examples/providers/verdaccio/fake.js is written from the page and the
// source, so a provider and its fake can share one mistake (a wrong method, a status
// a real server does not send) and agree. This run puts the provider in front of the
// real thing: Verdaccio, installed from npm and started as a Node process on 127.0.0.1
// from a generated configuration, set up for each scenario through its own API (users
// registered, a test package published, tokens minted, a key revoked), with the provider
// talking to it through a recording proxy. Each scenario that can run against a real
// server runs twice, once on the fake as run.js does and once here:
//
//  - the provider must answer as the transcript records (the tokens a real server minted
//    standing in for the scenario's), leave what `expect.store` says, and make the calls
//    `expect.state` counts (a whoami, a login, a mint, a revocation);
//  - what npm would send with a released credential is sent too (a packument read, a
//    publish, a token create), to the fake and to the real server;
//  - the two runs must make the same calls and get the same answers, in status, in the
//    headers a client may read (WWW-Authenticate, Vary, Cache-Control, npm-notice,
//    Content-Type) and in the names of the body's keys. A difference is a divergence,
//    printed with the request, the fake's answer and the real one, and it fails the run
//    unless live/verdaccio-divergences.json lists it with its reason;
//  - the same is done for a fixed list of requests no scenario reaches (`probes`).
//
// Scenarios that cannot run against a real server are listed with their reasons in
// live/verdaccio-skips.json, and printed.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { prepare, transcriptsOf } = require('../lib/scenario.js')
const { runSession } = require('../lib/session.js')
const { startFake } = require('../lib/fake-server.js')
const { createFake, DEFAULT_PACKAGES } = require('../verdaccio/fake.js')
const { install } = require('./server.js')
const { PREFIX, call, packument, packageRoute, realize, startProxy, jwtShaped } = require('./world.js')

const here = __dirname
const NAME = 'verdaccio'
const CEILING_SECONDS = 30 * 24 * 3600

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at < 0 ? fallback : process.argv[at + 1]
}

const deepMap = (value, fn) => {
  if (typeof value === 'string') {
    return fn(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepMap(item, fn))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepMap(item, fn)]))
  }
  return value
}

const jwtClaims = (token) => {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- normal form

// What an exchange looks like once it no longer matters whether the fake or the
// real server had it: who sent it, the request with its credential named by role,
// and the answer reduced to what a client reads.
const mediaType = (value) => (value ? value.split(';')[0].trim().toLowerCase() : null)
const keysOf = (json) => (json && typeof json === 'object' ? (Array.isArray(json) ? '[]' : Object.keys(json).sort().join(',')) : json === null || json === undefined ? '' : typeof json)
const bodyShape = (body) => {
  if (!body || typeof body !== 'object') {
    return ''
  }
  return `${Object.keys(body).sort().join(',')}${'readonly' in body ? ` readonly=${body.readonly}` : ''}`
}

// `roles`: { token: role }, `keyRoles`: { key: role }, for the side that is normalised.
const normalise = ({ src, method, route, authorization, body, status, headers, json }, roles, keyRoles) => {
  let auth = null
  if (authorization) {
    const [scheme, value] = authorization.split(' ')
    auth = scheme.toLowerCase() === 'bearer' ? roles(value) : scheme.toLowerCase()
  }
  const [pathOnly] = route.split('?')
  const revoke = /^\/-\/npm\/v1\/tokens\/token\/(.+)$/.exec(pathOnly)
  const named = pathOnly
    .replace(/^(\/-\/user\/org\.couchdb\.user:)[^/]+/, '$1{user}')
    .replace(/^\/-\/stage\/(?!package\/)[^/]+$/, '/-/stage/{id}')
  return {
    src,
    request: `${method} ${revoke ? `/-/npm/v1/tokens/token/{${keyRoles(decodeURIComponent(revoke[1]))}}` : named}`,
    auth,
    body: bodyShape(body),
    answer: {
      status,
      'www-authenticate': headers['www-authenticate'] || null,
      'npm-notice': headers['npm-notice'] || null,
      vary: headers.vary || null,
      'cache-control': headers['cache-control'] || null,
      'content-type': mediaType(headers['content-type']),
      keys: keysOf(json),
    },
  }
}

const describe = (exchange) => `${exchange.src}: ${exchange.request}${exchange.auth ? ` with ${exchange.auth}` : ''}${exchange.body ? ` {${exchange.body}}` : ''}`
const ASPECTS = ['status', 'www-authenticate', 'npm-notice', 'vary', 'cache-control', 'content-type', 'keys']

// The divergences between the two runs of one scenario: [{ id, where, request, fake, real }]
const compare = (where, fake, real) => {
  const found = []
  const length = Math.max(fake.length, real.length)
  for (let at = 0; at < length; at += 1) {
    const f = fake[at]
    const r = real[at]
    if (!f || !r) {
      found.push({ id: `sequence :: ${f ? describe(f) : 'nothing'} (fake) against ${r ? describe(r) : 'nothing'} (real)`, where, request: `call ${at + 1}`, fake: f ? describe(f) : 'no call', real: r ? describe(r) : 'no call' })
      break
    }
    if (describe(f) !== describe(r)) {
      found.push({ id: `sequence :: ${describe(f)} (fake) against ${describe(r)} (real)`, where, request: `call ${at + 1}`, fake: describe(f), real: describe(r) })
      break
    }
    for (const aspect of ASPECTS) {
      if (f.answer[aspect] !== r.answer[aspect]) {
        found.push({
          id: `${f.request}${f.auth ? ` with ${f.auth}` : ''} :: ${aspect} fake=${JSON.stringify(f.answer[aspect])} real=${JSON.stringify(r.answer[aspect])}`,
          where,
          request: describe(f),
          aspect,
          fake: JSON.stringify(f.answer[aspect]),
          real: JSON.stringify(r.answer[aspect]),
        })
      }
    }
  }
  return found
}

// ----------------------------------------------------- what npm sends, and the roles

const roleTable = (scenarioLike) => {
  const roles = new Map()
  const keyRoles = new Map()
  const state = scenarioLike.state || {}
  const mint = state.mint || {}
  for (const [token, entry] of Object.entries(state.tokens || {})) {
    roles.set(token, entry.dead ? 'revoked-token' : entry.login ? 'login-token' : entry.readonly ? 'read-token' : 'full-token')
    if (entry.key) {
      keyRoles.set(entry.key, entry.readonly ? 'read-key' : 'full-key')
    }
  }
  for (const [tier, list] of Object.entries(mint)) {
    for (const entry of list) {
      roles.set(entry.token, `${tier}-token`)
      keyRoles.set(entry.key, `${tier}-key`)
    }
  }
  return { roles, keyRoles }
}

// The request npm sends when it holds a credential for `message`, or null for an
// operation the scenarios do not follow with a request
const npmRequestFor = (message, { password }) => {
  const name = message.package ? `${message.scope ? `${message.scope}/` : ''}${message.package}` : null
  switch (message.operation) {
    case 'read':
      return name && { method: 'GET', route: packageRoute(name) }
    case 'publish':
      return name && { method: 'PUT', route: packageRoute(name), body: packument(name, message.version || '1.0.0') }
    case 'account':
      return { method: 'POST', route: '/-/npm/v1/tokens', body: { password, readonly: false } }
    case 'stage-read':
      return { method: 'GET', route: '/-/stage/00000000-0000-4000-8000-000000000001' }
    case 'stage':
      return name && { method: 'POST', route: `/-/stage/package/${name.replace('/', '%2f')}`, body: packument(name, message.version || '1.0.0') }
    default:
      return null
  }
}

// ------------------------------------------------------------------- one scenario

const loadScenario = (transcript) => JSON.parse(fs.readFileSync(path.join(here, '..', NAME, 'scenarios', `${path.basename(transcript, '.jsonl')}.json`), 'utf8'))

// The runs of one scenario: the scenario as it is, with the state a 7.x server needs to serve
// what the scenario uses (staging is a flag), and, for a wrong password, once more on a registry
// that registers users (Verdaccio's default, `max_users` above 0), where the add-user path
// answers 401 for it and not 409
const variantsOf = (name, scenario, major) => {
  const base = structuredClone(scenario)
  if (major >= 7) {
    base.state = { ...(base.state || {}), flags: { stage: true } }
  }
  const variants = [[name, base]]
  if (name === 'login-wrong-password') {
    variants.push([`${name} (registration open)`, { ...structuredClone(base), state: { ...base.state, registration: 'open' } }])
  }
  return variants
}

const modeOf = (scenario) => (Object.keys(scenario.state?.tokens || {}).some(jwtShaped) ? 'jwt' : 'aes')

// the one request npm sends after each released credential, to whichever world
const followUps = (scenario, sendTo) => {
  const registry = scenario.config.registry
  const password = scenario.state?.users?.[scenario.store?.[registry]?.account]?.password
  let last = null
  return {
    last: () => last,
    afterAnswer: async (request, answer) => {
      if (!answer.Ok || answer.Ok.kind !== 'get') {
        return
      }
      const sent = npmRequestFor(request, { password })
      if (!sent) {
        last = null
        return
      }
      last = { request, sent, ...(await sendTo(sent, answer.Ok.auth.token, request)) }
    },
  }
}

const runFake = async (transcript, scenario) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verdaccio-live-fake-'))
  const scenarioFile = path.join(scratch, 'scenario.json')
  fs.writeFileSync(scenarioFile, JSON.stringify(scenario))
  const run = await prepare(NAME, transcript, { scenarioFile })
  try {
    const nonce = { count: 0 }
    const follow = followUps(scenario, async (sent, token) => {
      // the fake mints from a list the scenario gives; a token create of npm's gets one more
      if (sent.route === '/-/npm/v1/tokens') {
        nonce.count += 1
        const state = run.fakeState
        state.mint ??= {}
        state.mint.full = [...(state.mint.full || []), { token: `npm-created-token-${nonce.count}`, key: `npm-created-key-${nonce.count}` }]
      }
      const res = await call(`${run.fake.url}${PREFIX}`, sent.method, sent.route, { token, body: sent.body, headers: { 'x-harness': 'npm' } })
      return { status: res.status }
    })
    const stderr = await runSession(run, transcript, { afterAnswer: follow.afterAnswer })
    run.finish(stderr)
    const { roles, keyRoles } = roleTable(scenario)
    const mintRoles = (token) => roles.get(token) || (/^npm-created-token/.test(token) ? 'full-token' : /^login-token/.test(token) ? 'login-token' : 'unknown-token')
    const mintKeys = (key) => keyRoles.get(key) || (/^npm-created-key/.test(key) ? 'full-key' : 'unknown-key')
    return run.exchanges.map(({ request, answer }) =>
      normalise(
        {
          src: request.headers['x-harness'] ? 'npm' : 'provider',
          method: request.method,
          route: request.path.slice(PREFIX.length),
          authorization: request.headers.authorization,
          body: request.body,
          status: answer.status,
          // fake-server.js sends JSON unless the answer says otherwise
          headers: { 'content-type': 'application/json', ...(answer.headers || {}) },
          json: answer.json,
        },
        mintRoles,
        mintKeys,
      ),
    )
  } finally {
    await run.cleanup()
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

// What the transcript says was refused, a real server must refuse too: the request npm sent
// with the credential just released gets the status the next retry names
const REPRODUCES = { escalation: true, 'rejection-revoked-key': true }

// The scenario's store, `expect.store` and `expect.state`, read for a real server.
const realRun = async ({ bin, version, transcript, scenario }) => {
  const mode = modeOf(scenario)
  const features = { stage: Number(version.split('.')[0]) >= 7 }
  const state = structuredClone(scenario.state || {})
  // JWT mode: the server signs tokens that expire as the scenario's do, counted from the
  // scenario's clock, and the clock is the real one, shifted so that a token that lapses
  // in the scenario lapses on a real timer
  let jwt = null
  let shift = 0
  let lapse = null
  const realNow = Math.floor(Date.now() / 1000)
  if (mode === 'jwt') {
    const exps = Object.keys(state.tokens || {}).map((token) => jwtClaims(token).exp)
    const exp = Math.min(...exps)
    const clocks = [scenario.now, ...(scenario.clock || [])]
    const lapses = clocks.some((clock) => clock >= exp)
    if (lapses) {
      jwt = '4s'
      shift = realNow - 86400 - scenario.now
      lapse = Date.now() + 4000
    } else {
      jwt = `${Math.max(1, exp - scenario.now)}s`
      shift = realNow - scenario.now
    }
  }
  const world = await realize({ bin, state: { ...state, rules: (state.rules || []).map((rule) => (features.stage ? rule : { ...rule, stage: undefined })) }, jwt, flags: features.stage ? { stage: true } : undefined, packages: DEFAULT_PACKAGES })
  const proxy = await startProxy(world.url)
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verdaccio-live-scenario-'))
  try {
    const toReal = (value) => (world.tokens.has(value) ? world.tokens.get(value) : world.keys.has(value) ? world.keys.get(value) : value)
    const derived = structuredClone(scenario)
    derived.store = deepMap(derived.store || {}, toReal)
    delete derived.expect
    derived.now = scenario.now + shift
    if (derived.clock) {
      derived.clock = derived.clock.map((time) => time + shift)
    }
    const scenarioFile = path.join(scratch, 'scenario.json')
    fs.writeFileSync(scenarioFile, JSON.stringify(derived))
    const run = await prepare(NAME, transcript, { scenarioFile, upstream: proxy.url })
    try {
      const mintStrings = new Set(Object.values(scenario.state?.mint || {}).flat().flatMap((entry) => [entry.token, entry.key]))
      const clocks = [...(derived.clock || [])]
      let clockNow = derived.now
      const follow = followUps(scenario, async (sent, token) => {
        const res = await call(`${proxy.url}${PREFIX}`, sent.method, sent.route, { token, body: sent.body, headers: { 'x-harness': 'npm' } })
        return { status: res.status }
      })
      const reproduces = REPRODUCES[path.basename(transcript, '.jsonl')]
      const stderr = await runSession(run, transcript, {
        expected: (message) => {
          let out = deepMap(message, toReal)
          if (out.Ok?.auth && out.Ok.cache === 'expires') {
            // `expiresAt` is the token's own `exp`, clamped to 30 days from the provider's clock
            out = structuredClone(out)
            out.Ok.expiresAt = Math.min(jwtClaims(out.Ok.auth.token).exp, clockNow + CEILING_SECONDS)
          }
          return out
        },
        beforeClient: async (message) => {
          if (clocks.length) {
            clockNow = clocks.shift()
          }
          if (lapse && message.retry && lapse > Date.now()) {
            await new Promise((resolve) => setTimeout(resolve, lapse - Date.now() + 1500))
          }
          const last = follow.last()
          if (reproduces && message.retry && last) {
            assert.equal(last.status, message.httpStatus, `${run.label}: the real server did not answer the request that the transcript says was refused ${message.httpStatus} (${last.sent.method} ${last.sent.route}) with that status`)
          }
        },
        afterAnswer: follow.afterAnswer,
      })
      run.finish(stderr)

      // the store, as `expect.store` says; a token the scenario has the fake mint is any real one
      const records = proxy.records.filter((record) => record.src === 'provider')
      const matchStore = (actual, expected, where) => {
        if (expected === null) {
          assert.ok(actual === undefined || actual === null, `${where}: expected absent, got ${JSON.stringify(actual)}`)
        } else if (typeof expected === 'string' && mintStrings.has(expected)) {
          assert.ok(typeof actual === 'string' && actual.length > 0, `${where}: expected a minted value, got ${JSON.stringify(actual)}`)
        } else if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
          assert.ok(actual && typeof actual === 'object', `${where}: expected an object, got ${JSON.stringify(actual)}`)
          for (const [key, value] of Object.entries(expected)) {
            matchStore(actual[key], value, `${where}.${key}`)
          }
        } else {
          assert.deepStrictEqual(actual, expected, where)
        }
      }
      const stored = JSON.parse(fs.readFileSync(run.storeFile, 'utf8'))
      if (scenario.expect?.store) {
        matchStore(stored, deepMap(scenario.expect.store, toReal), `${run.label} store`)
      }
      // `expect.state` counts the fake's own books; here they are the provider's calls
      const expectedState = scenario.expect?.state || {}
      for (const [key, value] of Object.entries(expectedState)) {
        const provided = (method, test) => records.filter((record) => record.method === method && test(record))
        if (key === 'whoami') {
          // the fake counts a whoami that reaches the route: a revoked key is refused before it (403)
          assert.equal(provided('GET', (record) => record.route === '/-/whoami' && record.status !== 403).length, value, `${run.label}: whoami calls that reached the route`)
        } else if (key === 'logins') {
          assert.equal(provided('PUT', (record) => record.route.startsWith('/-/user/org.couchdb.user:') && record.status < 300).length, value, `${run.label}: logins the server accepted`)
        } else if (key === 'minted') {
          const minted = provided('POST', (record) => record.route === '/-/npm/v1/tokens' && record.status === 200).map((record) => Boolean(record.body.readonly))
          assert.deepStrictEqual(minted, value.map((entry) => entry.readonly), `${run.label}: tokens the server minted for the provider (readonly flags)`)
        } else if (key === 'revoked') {
          const revoked = provided('DELETE', (record) => record.route.startsWith('/-/npm/v1/tokens/token/') && record.status === 200).map((record) => decodeURIComponent(record.route.split('/').pop()))
          assert.deepStrictEqual(revoked, value.map(toReal), `${run.label}: keys revoked`)
          // and a revoked token is dead for real: 403 on whoami
          for (const key of value) {
            const held = Object.entries(state.tokens || {}).find(([, entry]) => entry.key === key)
            if (held) {
              const res = await call(world.url, 'GET', '/-/whoami', { token: world.tokens.get(held[0]) })
              assert.equal(res.status, 403, `${run.label}: a revoked key's token is refused 403 by whoami`)
            }
          }
        } else {
          throw new Error(`${run.label}: expect.state.${key} has no counterpart against a real server`)
        }
      }
      // a login's tokens are real: the read-only one reads and is refused a write, the full one writes
      const entry = stored[scenario.config.registry]
      if (scenario.typed && entry && entry.tokens && entry.account) {
        const ro = entry.tokens.read.token
        const full = entry.tokens.full.token
        assert.equal((await call(world.url, 'GET', '/-/whoami', { token: ro })).json?.username, entry.account, `${run.label}: the read-only token the provider stored is not ${entry.account}'s`)
        assert.equal((await call(world.url, 'GET', '/-/whoami', { token: full })).json?.username, entry.account, `${run.label}: the full token the provider stored is not ${entry.account}'s`)
        assert.equal((await call(world.url, 'POST', '/-/npm/v1/tokens', { token: ro, body: { password: 'x', readonly: false } })).status, 403, `${run.label}: the read-only token is not read-only`)
      }

      // the exchanges, in normal form: tokens by role through what the scenario knows and
      // what the real server minted during the run
      const { roles: fakeRoles, keyRoles: fakeKeyRoles } = roleTable(scenario)
      const realRoles = new Map()
      const realKeyRoles = new Map()
      for (const [fake, real] of world.tokens) {
        realRoles.set(real, fakeRoles.get(fake))
      }
      for (const [fake, real] of world.keys) {
        realKeyRoles.set(real, fakeKeyRoles.get(fake))
      }
      const exchanges = proxy.records.map((record) => {
        const route = record.route
        if (record.status === 200 && record.method === 'POST' && route === '/-/npm/v1/tokens' && record.json?.token) {
          realRoles.set(record.json.token, record.body.readonly ? 'read-token' : 'full-token')
          realKeyRoles.set(record.json.key, record.body.readonly ? 'read-key' : 'full-key')
        }
        if (record.method === 'PUT' && route.startsWith('/-/user/org.couchdb.user:') && record.json?.token) {
          realRoles.set(record.json.token, 'login-token')
        }
        return normalise(
          { src: record.src, method: record.method, route, authorization: record.headers.authorization, body: record.body, status: record.status, headers: record.answered, json: record.json },
          (token) => realRoles.get(token) || 'unknown-token',
          (key) => realKeyRoles.get(key) || 'unknown-key',
        )
      })
      return exchanges
    } finally {
      await run.cleanup()
    }
  } catch (error) {
    error.message += `\n--- verdaccio ---\n${world.output().slice(-2000)}`
    throw error
  } finally {
    await proxy.close()
    await world.stop()
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------------ probes

// Requests no scenario reaches, sent to a fake and a real server in the same state: what the
// provider or npm could send and a fake might answer differently. `as` is a credential: a
// role of the probe state, `garbage`, or `basic`.
const PROBE_STATE = {
  users: { alice: { password: 'alice-password', groups: ['publishers'] }, bob: { password: 'bob-password', groups: [] } },
  rules: [{ pattern: '@acme/*', access: ['$all'], publish: ['publishers'], unpublish: ['publishers'], stage: ['publishers'] }],
  tokens: {
    'alice-login': { user: 'alice', login: true },
    'alice-read': { user: 'alice', readonly: true, key: 'alice-read-key' },
    'alice-full': { user: 'alice', readonly: false, key: 'alice-full-key' },
    'alice-revoked': { user: 'alice', readonly: false, key: 'alice-revoked-key', dead: true },
    'bob-full': { user: 'bob', readonly: false, key: 'bob-full-key' },
  },
}
const USER = (name) => `/-/user/org.couchdb.user:${name}`
const PROBES = [
  ['ping', 'GET', '/-/ping', null],
  ['whoami, no credential', 'GET', '/-/whoami', null],
  ['whoami, a token the server cannot decrypt', 'GET', '/-/whoami', 'garbage'],
  ['whoami, the read-only token', 'GET', '/-/whoami', 'alice-read'],
  ['whoami, the full token', 'GET', '/-/whoami', 'alice-full'],
  ['whoami, the login token', 'GET', '/-/whoami', 'alice-login'],
  ['whoami, a revoked key', 'GET', '/-/whoami', 'alice-revoked'],
  ['whoami, Basic', 'GET', '/-/whoami', 'basic'],
  ['packument, no credential', 'GET', '/@acme%2fwidget', null],
  ['packument, the read-only token', 'GET', '/@acme%2fwidget', 'alice-read'],
  ['packument, a revoked key', 'GET', '/@acme%2fwidget', 'alice-revoked'],
  ['packument, a token the server cannot decrypt', 'GET', '/@acme%2fwidget', 'garbage'],
  ['publish, no credential', 'PUT', '/@acme%2fwidget', null, () => packument('@acme/widget', '2.5.0')],
  ['publish, the read-only token', 'PUT', '/@acme%2fwidget', 'alice-read', () => packument('@acme/widget', '2.5.0')],
  ['publish, a user the rules refuse', 'PUT', '/@acme%2fwidget', 'bob-full', () => packument('@acme/widget', '2.5.0')],
  ['publish, a user the rules admit', 'PUT', '/@acme%2fwidget', 'alice-full', () => packument('@acme/widget', '2.5.0')],
  ['publish, the same version again', 'PUT', '/@acme%2fwidget', 'alice-full', () => packument('@acme/widget', '2.5.0')],
  ['token list, the read-only token', 'GET', '/-/npm/v1/tokens', 'alice-read'],
  ['token list, no credential', 'GET', '/-/npm/v1/tokens', null],
  ['token create, no credential', 'POST', '/-/npm/v1/tokens', null, () => ({ password: 'alice-password', readonly: false })],
  ['token create, the read-only token', 'POST', '/-/npm/v1/tokens', 'alice-read', () => ({ password: 'alice-password', readonly: false })],
  ['token create, a wrong password', 'POST', '/-/npm/v1/tokens', 'alice-full', () => ({ password: 'wrong', readonly: false })],
  ['token create, a revoked key', 'POST', '/-/npm/v1/tokens', 'alice-revoked', () => ({ password: 'alice-password', readonly: false })],
  ['token revoke, the read-only token', 'DELETE', '/-/npm/v1/tokens/token/alice-full-key', 'alice-read'],
  ['token revoke, another user\'s key', 'DELETE', '/-/npm/v1/tokens/token/alice-full-key', 'bob-full'],
  ['token revoke, a key nobody has', 'DELETE', '/-/npm/v1/tokens/token/no-such-key', 'alice-full'],
  ['login, an existing user', 'PUT', USER('alice'), null, () => ({ name: 'alice', password: 'alice-password' })],
  ['login, an existing user, a wrong password', 'PUT', USER('alice'), null, () => ({ name: 'alice', password: 'wrong' })],
  ['login, a user nobody registered', 'PUT', USER('carol'), null, () => ({ name: 'carol', password: 'carol-password-1' })],
  ['login, Basic on the revision route', 'PUT', `${USER('alice')}/-rev/undefined`, 'basic', () => ({ name: 'alice', password: 'alice-password' })],
  ['login, Basic with a wrong password', 'PUT', `${USER('alice')}/-rev/undefined`, 'basic-wrong', () => ({ name: 'alice', password: 'wrong' })],
  ['stage, a record that does not exist', 'GET', '/-/stage/00000000-0000-4000-8000-000000000001', 'alice-full'],
  ['token revoke, the read-only token of the user', 'DELETE', '/-/npm/v1/tokens/token/alice-read-key', 'alice-full'],
  ['whoami, the key that was just revoked', 'GET', '/-/whoami', 'alice-read'],
]

const runProbes = async ({ bin, version }) => {
  const state = structuredClone(PROBE_STATE)
  const features = { stage: Number(version.split('.')[0]) >= 7 }
  const credential = (as, tokens) => {
    if (as === 'garbage') {
      return { token: 'garbage-token' }
    }
    if (as === 'basic') {
      return { basic: 'alice:alice-password' }
    }
    if (as === 'basic-wrong') {
      return { basic: 'alice:wrong' }
    }
    return as ? { token: tokens.get(as) } : {}
  }
  // the fake
  const fakeState = structuredClone(state)
  const handle = createFake(fakeState)
  const exchanges = []
  const fake = await startFake((request) => {
    let answer
    try {
      answer = handle(request) || { status: 404, json: { error: 'no such route' } }
    } catch (error) {
      // as fake-server.js answers a handler that throws
      answer = { status: 500, json: { error: error.message } }
      exchanges.push({ request, answer })
      throw error
    }
    exchanges.push({ request, answer })
    return answer
  })
  let fakeSide
  try {
    const tokens = new Map(Object.keys(state.tokens).map((name) => [name, name]))
    for (const [, method, route, as, body] of PROBES) {
      await call(`${fake.url}${PREFIX}`, method, route, { ...credential(as, tokens), body: body && body() })
    }
    const { roles, keyRoles } = roleTable({ state })
    fakeSide = exchanges.map(({ request, answer }) =>
      normalise(
        { src: 'npm', method: request.method, route: request.path.slice(PREFIX.length), authorization: request.headers.authorization, body: request.body, status: answer.status, headers: { 'content-type': 'application/json', ...(answer.headers || {}) }, json: answer.json },
        (token) => roles.get(token) || (token === 'garbage-token' ? 'garbage-token' : /^login-token/.test(token) ? 'login-token' : 'unknown-token'),
        (key) => keyRoles.get(key) || 'unknown-key',
      ),
    )
  } finally {
    await fake.close()
  }
  // the real one
  const world = await realize({ bin, state: { ...state, rules: state.rules.map((rule) => (features.stage ? rule : { ...rule, stage: undefined })) }, flags: features.stage ? { stage: true } : undefined, packages: DEFAULT_PACKAGES })
  const proxy = await startProxy(world.url)
  try {
    for (const [, method, route, as, body] of PROBES) {
      const realRoute = route.replace(/\/token\/([^/]+)$/, (all, key) => `/token/${encodeURIComponent(world.keys.get(key) || key)}`)
      await call(`${proxy.url}${PREFIX}`, method, realRoute, { ...credential(as, world.tokens), body: body && body(), headers: { 'x-harness': 'npm' } })
    }
    const { roles, keyRoles } = roleTable({ state })
    const realRoles = new Map([...world.tokens].map(([fakeName, real]) => [real, roles.get(fakeName)]))
    const realKeys = new Map([...world.keys].map(([fakeKey, real]) => [real, keyRoles.get(fakeKey)]))
    const realSide = proxy.records.map((record) => {
      if (record.method === 'PUT' && record.route.startsWith('/-/user/org.couchdb.user:') && record.json?.token) {
        realRoles.set(record.json.token, 'login-token')
      }
      return normalise(
        { src: record.src, method: record.method, route: record.route, authorization: record.headers.authorization, body: record.body, status: record.status, headers: record.answered, json: record.json },
        (token) => realRoles.get(token) || (token === 'garbage-token' ? 'garbage-token' : 'unknown-token'),
        (key) => realKeys.get(key) || 'unknown-key',
      )
    })
    return { fakeSide, realSide }
  } catch (error) {
    error.message += `\n--- verdaccio ---\n${world.output().slice(-2000)}`
    throw error
  } finally {
    await proxy.close()
    await world.stop()
  }
}

// -------------------------------------------------------------------------- main

const matches = (entry, version) => !entry.versions || entry.versions.includes(version.split('.')[0])

const main = async () => {
  const version = arg('version', '6.10.6')
  const major = Number(version.split('.')[0])
  const only = arg('only', '') ? arg('only').split(',') : null
  const dir = arg('install-dir', path.join(os.tmpdir(), `verdaccio-live-install-${version}`))
  const bin = install(version, dir)
  console.log(`verdaccio ${version} (${bin})`)

  const skips = JSON.parse(fs.readFileSync(path.join(here, 'verdaccio-skips.json'), 'utf8')).skips
  const allow = JSON.parse(fs.readFileSync(path.join(here, 'verdaccio-divergences.json'), 'utf8')).allow
  const transcripts = transcriptsOf(NAME)
  const names = transcripts.map((file) => path.basename(file, '.jsonl'))
  for (const name of Object.keys(skips)) {
    assert.ok(names.includes(name), `verdaccio-skips.json lists ${name}, which is not a scenario`)
  }
  const skipped = []
  const failures = []
  const divergences = []
  let ran = 0
  for (const transcript of transcripts) {
    const name = path.basename(transcript, '.jsonl')
    const skip = skips[name]
    if (skip && !(skip.majorBelow && major >= skip.majorBelow)) {
      skipped.push([name, skip.reason])
      continue
    }
    if (only && !only.includes(name)) {
      continue
    }
    for (const [label, scenario] of variantsOf(name, loadScenario(transcript), major)) {
      try {
        const fake = await runFake(transcript, scenario)
        const real = await realRun({ bin, version, transcript, scenario })
        if (process.env.VERDACCIO_LIVE_TRACE) {
          real.forEach((exchange, at) => console.log(`  ${label} #${at + 1} ${describe(exchange)} -> ${exchange.answer.status}`))
        }
        divergences.push(...compare(label, fake, real))
        ran += 1
        console.log(`ok ${label} (${modeOf(scenario)}; ${fake.length} calls on the fake, ${real.length} on verdaccio)`)
      } catch (error) {
        failures.push(`${label}: ${error.message}`)
        console.log(`FAIL ${label}`)
      }
    }
  }
  if (!only || only.includes('probes')) {
    try {
      const { fakeSide, realSide } = await runProbes({ bin, version })
      if (process.env.VERDACCIO_LIVE_TRACE) {
        realSide.forEach((exchange, at) => console.log(`  probes #${at + 1} ${describe(exchange)} -> ${JSON.stringify(exchange.answer)}`))
      }
      divergences.push(...compare('probes', fakeSide, realSide))
      console.log(`ok probes (${PROBES.length} requests)`)
    } catch (error) {
      failures.push(`probes: ${error.message}`)
      console.log('FAIL probes')
    }
  }

  console.log(`\nskipped against verdaccio ${version} (${skipped.length}):`)
  for (const [name, reason] of skipped) {
    console.log(`  ${name}: ${reason}`)
  }

  // divergences, once each; those allowlisted for this version are reported as known
  const unique = new Map()
  for (const divergence of divergences) {
    const entry = unique.get(divergence.id) || { ...divergence, where: [] }
    entry.where.push(divergence.where)
    unique.set(divergence.id, entry)
  }
  const known = []
  const fresh = []
  for (const entry of unique.values()) {
    const listed = allow.find((candidate) => candidate.id === entry.id && matches(candidate, version))
    ;(listed ? known : fresh).push({ ...entry, reason: listed && listed.reason })
  }
  const unused = allow.filter((candidate) => matches(candidate, version) && !unique.has(candidate.id) && !only)
  const show = (entry) => console.log(`  ${entry.request}${entry.aspect ? ` :: ${entry.aspect}` : ''}\n    in: ${[...new Set(entry.where)].join(', ')}\n    fake: ${entry.fake}\n    real: ${entry.real}${entry.reason ? `\n    allowed: ${entry.reason}` : ''}`)
  console.log(`\ndivergences between the fake and verdaccio ${version}: ${known.length} known, ${fresh.length} new`)
  known.forEach(show)
  fresh.forEach(show)
  if (fresh.length) {
    console.log('\nnew divergences, as entries for verdaccio-divergences.json if they are to be allowed:')
    for (const entry of fresh) {
      console.log(JSON.stringify({ id: entry.id, versions: [version.split('.')[0]], reason: '' }))
    }
  }
  for (const entry of unused) {
    console.log(`\nstale allowlist entry (no such divergence any more): ${entry.id}`)
  }
  for (const failure of failures) {
    console.log(`\n${failure}`)
  }
  console.log(`\n${ran} scenarios ran against verdaccio ${version}, ${skipped.length} skipped, ${failures.length} failed, ${fresh.length} new divergences, ${unused.length} stale allowlist entries`)
  if (failures.length || fresh.length || unused.length) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
