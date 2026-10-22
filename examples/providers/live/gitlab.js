'use strict'
// The GitLab reference provider against a real GitLab CE.
//
//   node examples/providers/live/gitlab.js --container gitlab [--url http://localhost:8929]
//        [--image gitlab/gitlab-ce:<tag>] [--expect-image-tag <tag>] [--only <scenario>,...]
//
// The fake of examples/providers/gitlab/fake.js is written from the page and the docs, so
// the provider and its fake can share one mistake (an endpoint or a scope GitLab does not
// accept, a status it does not send) and agree. This run puts the provider in front of a
// real GitLab, started by the workflow (.github/workflows/gitlab-live.yml) as a docker
// container: set up once through GitLab's own interfaces (an admin token made in the Rails
// console; users, a group, projects, an OAuth application and a package through the REST
// API), and for each scenario given the OAuth tokens, deploy tokens and job token its
// state names, the provider talking to GitLab through a recording proxy. Each scenario
// that can run against a real server runs twice, once on the fake as run.js does and once
// here:
//
//  - the provider must answer as the transcript records (the tokens GitLab minted standing
//    in for the scenario's), leave what `expect.store` says, and make the calls
//    `expect.state` counts (deploy tokens created and deleted, refreshes, revocations);
//  - what npm would send after each released credential (a packument read, a publish, a
//    dist-tag), and what a person would do beside the provider (remove a deploy token in the
//    project's settings, approve a device code), is done on both;
//  - the two runs must make the same calls and get the same answers, in status, in the
//    headers a client may read (WWW-Authenticate, Vary, Cache-Control, Content-Type) and
//    in the names of the body's keys. A difference is a divergence, printed with the
//    request, the fake's answer and the real one, and it fails the run unless
//    live/gitlab-divergences.json lists it with its reason;
//  - the same is done for a fixed list of requests no scenario reaches (`probes`).
//
// Scenarios that cannot run against a real server are listed with their reasons in
// live/gitlab-skips.json, and printed. The first line says which GitLab this is, and so
// does the last, so that a failure of a nightly run on `latest` names the version that changed.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { prepare, transcriptsOf, readJsonl } = require('../lib/scenario.js')
const { runSession } = require('../lib/session.js')
const { startFake } = require('../lib/fake-server.js')
const { createFake } = require('../gitlab/fake.js')
const { packument } = require('./world.js')
const { arg, deepMap, mediaType, keysOf, describe, compare, report } = require('./common.js')
const w = require('./gitlab-world.js')

const here = __dirname
const NAME = 'gitlab'
const ADMIN = 'admin-pat'
// the project numbers of the scenarios, and the projects they stand for on a real instance
const PROJECTS = { 42: 'widgets', 43: 'other' }

// ---------------------------------------------------------------- normal form

const bodyShape = (body) => {
  if (body === null || body === undefined) {
    return ''
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    return typeof body
  }
  const extra = []
  if (Array.isArray(body.scopes)) {
    extra.push(`scopes=${[...body.scopes].sort().join('+')}`)
  }
  // the values of the fields that say what is asked for, never of one that is a secret
  for (const key of ['grant_type', 'token_type_hint', 'scope']) {
    if (typeof body[key] === 'string') {
      extra.push(`${key}=${body[key]}`)
    }
  }
  return [Object.keys(body).sort().join(','), ...extra].filter(Boolean).join(' ')
}

// One exchange as the fake or the real server had it, in the form both are compared in.
// `names` says what a project or group number is, `dts` what a deploy token id is,
// `role(token)` what a bearer token is.
const normalise = ({ src, method, route, authorization, body, status, headers, json }, { names, dts, role }) => {
  let auth = null
  if (authorization) {
    const [scheme, value] = authorization.split(' ')
    auth = scheme.toLowerCase() === 'bearer' ? role(value) : scheme.toLowerCase()
  }
  const [pathOnly, query] = route.split('?')
  const named = pathOnly
    .replace(/\/(projects|groups)\/(\d+)/g, (all, kind, id) => `/${kind}/{${names.get(id) || 'unknown'}}`)
    .replace(/\/deploy_tokens\/(\d+)$/, (all, id) => `/deploy_tokens/{${dts.get(id) || 'dt?'}}`)
  return {
    src,
    request: `${method} ${named}${query ? `?${query.replace(/user_code=[^&]+/, 'user_code=…')}` : ''}`,
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

// The roles tokens have in the exchanges, learned as the exchanges go: a seed (a token the
// scenario names) or what an earlier answer of the server minted.
const makeRoles = (seeds, firstId) => {
  const roles = new Map(seeds)
  const dts = new Map()
  let created = 0
  return {
    dts,
    role: (token) => roles.get(token) || 'unknown-token',
    learn: (record) => {
      if (record.method === 'POST' && record.route === '/oauth/token' && record.status === 200 && record.json?.access_token) {
        roles.set(record.json.access_token, 'oauth-access')
      }
      if (record.method === 'POST' && /\/deploy_tokens$/.test(record.route) && record.status === 201 && record.json?.token) {
        roles.set(record.json.token, (record.json.scopes || []).includes('write_package_registry') ? 'write-deploy' : 'read-deploy')
        dts.set(String(record.json.id), `dt${firstId + created}`)
        created += 1
      }
    },
  }
}

// the credentials the scenario's state and environment name, by role
const seedsOf = (scenario) => {
  const seeds = new Map([[ADMIN, 'admin-pat']])
  const oauth = scenario.state?.oauth || {}
  for (const token of [oauth.accessToken, ...(oauth.next || []).map((pair) => pair.accessToken)]) {
    if (token) {
      seeds.set(token, 'oauth-access')
    }
  }
  for (const token of Object.values(scenario.store || {}).flatMap((entry) => (entry.oauth?.accessToken ? [entry.oauth.accessToken] : []))) {
    seeds.set(token, 'oauth-access')
  }
  for (const deploy of scenario.state?.deployTokens || []) {
    seeds.set(deploy.token, deploy.scopes.includes('write_package_registry') ? 'write-deploy' : 'read-deploy')
  }
  if (scenario.env?.CI_JOB_TOKEN) {
    seeds.set(scenario.env.CI_JOB_TOKEN, 'job-token')
  }
  return seeds
}

// The request npm sends with the credential it was given for `message`, or null for an
// operation the scenarios do not follow with one.
const npmRequestFor = (message) => {
  if (!message.package) {
    return null
  }
  const name = `${message.scope ? `${message.scope}/` : ''}${message.package}`
  const prefix = new URL(message.registry).pathname.replace(/\/$/, '')
  const route = w.packageRoute(name)
  switch (message.operation) {
    case 'read':
      return { method: 'GET', route: `${prefix}${route}` }
    case 'publish':
      return { method: 'PUT', route: `${prefix}${route}`, body: packument(name, message.version || '1.0.0') }
    case 'dist-tag':
      return { method: 'PUT', route: `${prefix}/-/package${route}/dist-tags/beta`, body: '2.4.0' }
    default:
      return null
  }
}

// What a scenario must reproduce on a real server: where the transcript says the registry
// refused a credential, the credential is made one the registry refuses (the person
// removes the deploy token in the project's settings), and the request npm sends with it
// must be refused with that status.
const REPRODUCES = { rejection: true, 'rejection-revoked': true }

// After a session, the requests that show a token is dead (or still alive): the old
// refresh token after a refresh, the revoked tokens after a logout.
const replaysOf = (records) => {
  const replays = []
  const refresh = records.find((record) => record.src === 'provider' && record.route === '/oauth/token' && record.body?.grant_type === 'refresh_token' && record.status === 200)
  if (refresh) {
    replays.push({ method: 'POST', route: '/oauth/token', form: { client_id: refresh.body.client_id, grant_type: 'refresh_token', refresh_token: refresh.body.refresh_token } })
  }
  const revoked = records.filter((record) => record.src === 'provider' && record.route === '/oauth/revoke' && record.status === 200)
  for (const record of revoked) {
    if (record.body.token_type_hint === 'access_token') {
      replays.push({ method: 'GET', route: '/api/v4/user', token: record.body.token })
    } else {
      replays.push({ method: 'POST', route: '/oauth/token', form: { client_id: record.body.client_id, grant_type: 'refresh_token', refresh_token: record.body.token } })
    }
  }
  return replays
}

// ------------------------------------------------------------------- one scenario

const loadScenario = (transcript) => JSON.parse(fs.readFileSync(path.join(here, '..', NAME, 'scenarios', `${path.basename(transcript, '.jsonl')}.json`), 'utf8'))

// A scenario as it is run on both sides. The fake's `login` answers slow_down first, to
// make the provider back off; a real GitLab answers authorization_pending, and slow_down
// only to a poll sooner than its interval, so the live run has the fake say what GitLab
// says: one pending answer, then the token.
const variantOf = (name, scenario) => {
  const base = structuredClone(scenario)
  if (name === 'login') {
    base.state.oauth = { ...base.state.oauth, slowDown: false, pending: 1, interval: 5 }
    base.expect = { store: { 'https://gitlab.example.com': { oauth: { refreshToken: 'refresh-1', accessToken: 'access-1', accessExpiresAt: scenario.now + 7210 } } } }
  }
  return base
}

const followUps = (send, { reproduce }) => {
  let last = null
  let removed = false
  return {
    last: () => last,
    afterAnswer: async (request, answer) => {
      if (!answer.Ok || answer.Ok.kind !== 'get') {
        return
      }
      const sent = npmRequestFor(request)
      if (!sent) {
        last = null
        return
      }
      if (reproduce && !removed && !request.retry) {
        removed = true
        await reproduce(request)
      }
      last = { request, sent, ...(await send(sent, answer.Ok.auth.token)) }
    },
  }
}

const runFake = async (transcript, scenario) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlab-live-fake-'))
  const patched = structuredClone(scenario)
  if (patched.env?.CI_JOB_TOKEN) {
    patched.state = { ...patched.state, jobToken: patched.env.CI_JOB_TOKEN }
  }
  const scenarioFile = path.join(scratch, 'scenario.json')
  fs.writeFileSync(scenarioFile, JSON.stringify(patched))
  const run = await prepare(NAME, transcript, { scenarioFile })
  try {
    const name = path.basename(transcript, '.jsonl')
    const call = (method, route, options) => w.call(run.fake.url, method, route, options)
    const follow = followUps((sent, token) => call(sent.method, sent.route, { token, body: sent.body, headers: { 'x-harness': 'npm' } }).then((res) => ({ status: res.status })), {
      reproduce: REPRODUCES[name]
        ? async (request) => {
            const created = run.exchanges.filter(({ request: req, answer }) => req.method === 'POST' && /\/deploy_tokens$/.test(req.path) && answer.status === 201).pop()
            const project = /\/projects\/(\d+)\//.exec(request.registry)[1]
            await call('DELETE', `/api/v4/projects/${project}/deploy_tokens/${created.answer.json.id}`, { token: ADMIN, headers: { 'x-harness': 'person' } })
          }
        : null,
    })
    const stderr = await runSession(run, transcript, { afterAnswer: follow.afterAnswer })
    run.finish(stderr)
    const records = () =>
      run.exchanges.map(({ request, answer }) => ({
        src: request.headers['x-harness'] ? 'npm' : 'provider',
        method: request.method,
        route: request.path,
        authorization: request.headers.authorization,
        body: request.body,
        status: answer.status,
        headers: { ...(answer.json === undefined ? {} : { 'content-type': 'application/json' }), ...(answer.headers || {}) },
        json: answer.json,
      }))
    for (const replay of replaysOf(records())) {
      await call(replay.method, replay.route, { token: replay.token, form: replay.form, headers: { 'x-harness': 'replay' } })
    }
    const firstId = scenario.state?.nextId || 1
    const roles = makeRoles(seedsOf(scenario), firstId)
    for (const id of (scenario.state?.deployTokens || []).map((deploy) => deploy.id)) {
      roles.dts.set(String(id), `dt${id}`)
    }
    const names = new Map(Object.entries(PROJECTS))
    return records().map((record) => {
      const exchange = normalise(record, { names, dts: roles.dts, role: roles.role })
      roles.learn(record)
      return exchange
    })
  } finally {
    await run.cleanup()
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

const mapProjects = (value, ids) => JSON.parse(JSON.stringify(value).replace(/\/projects\/(\d+)\//g, (all, id) => `/projects/${ids[id] || id}/`).replace(/"(42|43)"/g, (all, id) => `"${ids[id]}"`))

// The scenario's store, `expect.store` and `expect.state`, read for a real GitLab.
const realRun = async ({ instance, transcript, scenario, log }) => {
  const name = path.basename(transcript, '.jsonl')
  const ids = { 42: instance.projects.widgets.id, 43: instance.projects.other.id }
  const widgets = ids[42]
  const realNow = Math.floor(Date.now() / 1000)
  const shift = realNow - scenario.now
  const state = scenario.state || {}
  const firstId = state.nextId || 1
  await w.reset(instance, log)

  // the tokens the scenario's state names, made on the instance: `tokens` maps a scenario's
  // token to the real one, `deployIds` a scenario's deploy token id to the real id
  const tokens = new Map()
  const deployIds = new Map()
  const storeEntries = Object.values(scenario.store || {})
  for (const entry of storeEntries) {
    if (entry.oauth?.refreshToken) {
      const live = await w.oauthPair(instance, 'maint')
      tokens.set(entry.oauth.refreshToken, live.refresh)
      if (entry.oauth.accessToken) {
        tokens.set(entry.oauth.accessToken, live.access)
      }
      if (state.oauth?.refreshToken && state.oauth.refreshToken !== entry.oauth.refreshToken) {
        // the stored refresh token is one GitLab has revoked: another login's, revoked
        const dead = await w.oauthPair(instance, 'maint')
        assert.equal((await w.revokeOauth(instance, dead.access)).status, 200, 'setup: revoking a login')
        tokens.set(entry.oauth.refreshToken, dead.refresh)
      }
    }
  }
  for (const deploy of state.deployTokens || []) {
    const made = await w.createDeployToken(instance, widgets, { scopes: deploy.scopes })
    tokens.set(deploy.token, made.token)
    deployIds.set(deploy.id, made.id)
  }
  if (scenario.env?.CI_JOB_TOKEN) {
    assert.ok(instance.jobToken, 'no CI job token could be made on this instance (see the setup above)')
    tokens.set(scenario.env.CI_JOB_TOKEN, instance.jobToken)
  }
  const toReal = (value) => (tokens.has(value) ? tokens.get(value) : value)
  const mintStrings = new Set((state.oauth?.next || []).flatMap((pair) => [pair.accessToken, pair.refreshToken]))
  const mintedSecrets = new Set(state.tokens || [])

  const ctx = { storeFile: null }
  const approves = name === 'login'
  const polled = new Map()
  const rules = structuredClone(mapProjects(scenario.concurrently || [], ids))
  const proxy = await w.startProxy(instance.url, {
    before: async (record) => {
      const line = `${record.method} ${record.route.split('?')[0]}`
      for (const [index, rule] of rules.entries()) {
        if (line.startsWith(rule.on)) {
          rules.splice(index, 1)
          fs.writeFileSync(ctx.storeFile, JSON.stringify(rule.store))
          break
        }
      }
      // time inside the run is the provider's synthetic clock, which skips the waits of a poll
      // loop; GitLab judges a poll against its own interval, so the proxy waits the real time
      if (record.route === '/oauth/token' && record.body?.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        const earlier = polled.get(record.body.device_code)
        if (earlier) {
          const wait = earlier.until - Date.now()
          if (wait > 0) {
            await w.sleep(wait)
          }
        }
      }
    },
    after: async (record) => {
      if (record.route === '/oauth/authorize_device' && record.status === 200 && record.json?.device_code) {
        polled.set(record.json.device_code, { until: 0, interval: record.json.interval || 5, record })
        polled.get(record.json.device_code).until = Date.now()
      }
      if (record.route === '/oauth/token' && record.body?.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        const entry = polled.get(record.body.device_code)
        if (entry) {
          entry.until = Date.now() + (entry.interval + 1) * 1000
          // the person approves after the first poll has been told to wait
          if (approves && record.json?.error === 'authorization_pending' && !entry.approved) {
            entry.approved = true
            await w.approve(instance, 'maint', entry.record.json)
          }
        }
      }
    },
  })
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlab-live-scenario-'))
  try {
    const derived = mapProjects(structuredClone(scenario), ids)
    derived.store = deepMap(derived.store || {}, toReal)
    for (const entry of Object.values(derived.store)) {
      if (entry.oauth?.accessExpiresAt) {
        entry.oauth.accessExpiresAt += shift
      }
      for (const held of Object.values(entry.minted || {})) {
        held.id = deployIds.get(held.id) ?? held.id
      }
    }
    delete derived.expect
    derived.now = scenario.now + shift
    if (derived.clock) {
      derived.clock = derived.clock.map((time) => time + shift)
    }
    derived.config = { ...derived.config, clientId: instance.clientId }
    if (derived.env?.CI_JOB_TOKEN) {
      derived.env = { ...derived.env, CI_JOB_TOKEN: toReal(derived.env.CI_JOB_TOKEN) }
    }
    const scenarioFile = path.join(scratch, 'scenario.json')
    fs.writeFileSync(scenarioFile, JSON.stringify(derived))
    const transcriptFile = path.join(scratch, `${name}.jsonl`)
    fs.writeFileSync(transcriptFile, `${readJsonl(transcript).map((event) => JSON.stringify(mapProjects(event, ids))).join('\n')}\n`)
    const run = await prepare(NAME, transcriptFile, { scenarioFile, upstream: proxy.url })
    ctx.storeFile = run.storeFile
    try {
      const createdOnes = () => proxy.records.filter((record) => record.method === 'POST' && /\/deploy_tokens$/.test(record.route) && record.status === 201)
      const reproduces = REPRODUCES[name]
      const follow = followUps(async (sent, token) => ({ status: (await w.call(proxy.url, sent.method, sent.route, { token, body: sent.body, headers: { 'x-harness': 'npm' } })).status }), {
        reproduce: reproduces
          ? async (request) => {
              const id = createdOnes().pop().json.id
              const project = /\/projects\/(\d+)\//.exec(request.registry)[1]
              await w.call(proxy.url, 'DELETE', `/api/v4/projects/${project}/deploy_tokens/${id}`, { token: instance.admin, headers: { 'x-harness': 'person' } })
            }
          : null,
      })
      const stderr = await runSession(run, transcriptFile, {
        expected: (message) => {
          let out = deepMap(message, toReal)
          if (out.Ok?.auth) {
            out = structuredClone(out)
            if (mintedSecrets.has(message.Ok.auth.token)) {
              const made = createdOnes().pop()
              out.Ok.auth.token = made ? made.json.token : '(no deploy token was created)'
            }
            if (out.Ok.cache === 'expires') {
              out.Ok.expiresAt = message.Ok.expiresAt + shift
            }
          }
          return out
        },
        beforeClient: async (message) => {
          const last = follow.last()
          if (reproduces && message.retry && last) {
            assert.equal(last.status, message.httpStatus, `${run.label}: the real GitLab did not answer the request that the transcript says was refused ${message.httpStatus} (${last.sent.method} ${last.sent.route}) with that status`)
          }
        },
        afterAnswer: follow.afterAnswer,
      })
      run.finish(stderr)
      for (const replay of replaysOf(proxy.records)) {
        await w.call(proxy.url, replay.method, replay.route, { token: replay.token, form: replay.form, headers: { 'x-harness': 'replay' } })
      }

      // ids: a scenario's deploy token id is the real one if the scenario names it, else the
      // n-th token the provider made counts from the scenario's `nextId`
      const made = createdOnes().map((record) => record.json)
      const scenarioIdOf = (real) => {
        for (const [fake, id] of deployIds) {
          if (id === real) {
            return fake
          }
        }
        const at = made.findIndex((token) => token.id === real)
        return at < 0 ? null : firstId + at
      }
      const realIdOf = (fake) => deployIds.get(fake) ?? made[fake - firstId]?.id

      // the store, as `expect.store` says; a token the scenario has GitLab issue is any real one
      const matchStore = (actual, expected, where, key) => {
        if (expected === null) {
          assert.ok(actual === undefined || actual === null, `${where}: expected absent, got ${JSON.stringify(actual)}`)
        } else if (key === 'accessExpiresAt') {
          // GitLab's own two hours, counted from the provider's clock (waits of a poll loop included)
          assert.ok(Number.isInteger(actual) && Math.abs(actual - (expected + shift)) <= 120, `${where}: ${actual} is not within 2 minutes of ${expected + shift}`)
        } else if (key === 'id') {
          assert.equal(actual, realIdOf(expected), `${where}: deploy token id`)
        } else if (typeof expected === 'string' && mintStrings.has(expected)) {
          assert.ok(typeof actual === 'string' && actual.length > 0, `${where}: expected a token GitLab issued, got ${JSON.stringify(actual)}`)
        } else if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
          assert.ok(actual && typeof actual === 'object', `${where}: expected an object, got ${JSON.stringify(actual)}`)
          for (const [name2, value] of Object.entries(expected)) {
            matchStore(actual[name2], value, `${where}.${name2}`, name2)
          }
        } else {
          assert.deepStrictEqual(actual, expected, where)
        }
      }
      const stored = JSON.parse(fs.readFileSync(run.storeFile, 'utf8'))
      if (scenario.expect?.store) {
        matchStore(stored, deepMap(mapProjects(scenario.expect.store, ids), toReal), `${run.label} store`)
      }

      // `expect.state` counts the fake's own books; here they are what GitLab was asked and now holds
      const expected = scenario.expect?.state || {}
      const provider = proxy.records.filter((record) => record.src === 'provider')
      const known = new Set(['oauth', 'deployTokens', 'deleted', 'tokens'])
      for (const key of Object.keys(expected)) {
        assert.ok(known.has(key), `${run.label}: expect.state.${key} has no counterpart against a real GitLab`)
      }
      if (expected.tokens) {
        assert.equal(made.length, (state.tokens || []).length - expected.tokens.length, `${run.label}: deploy tokens the provider made`)
      }
      if (expected.deleted) {
        const deleted = proxy.records.filter((record) => record.method === 'DELETE' && /\/deploy_tokens\/\d+$/.test(record.route) && record.status === 204).map((record) => scenarioIdOf(Number(record.route.split('/').pop())))
        assert.deepStrictEqual(deleted, expected.deleted, `${run.label}: deploy tokens deleted (scenario ids)`)
      }
      if (expected.deployTokens) {
        const live = await instance.api('GET', `/projects/${widgets}/deploy_tokens?per_page=100`)
        const have = (live.json || []).map((token) => ({ id: scenarioIdOf(token.id), scopes: [...token.scopes].sort() })).sort((a, b) => a.id - b.id)
        const want = expected.deployTokens.map((token) => ({ id: token.id, scopes: [...token.scopes].sort() })).sort((a, b) => a.id - b.id)
        assert.deepStrictEqual(have, want, `${run.label}: deploy tokens GitLab holds (scenario ids)`)
        // the expiry the provider sent is the one GitLab kept
        for (const record of createdOnes()) {
          const kept = (live.json || []).find((token) => token.id === record.json.id)
          if (kept) {
            assert.equal(kept.expires_at, record.body.expires_at, `${run.label}: expiry GitLab kept for deploy token ${kept.id}`)
          }
        }
      }
      if (expected.oauth) {
        if ('refreshToken' in expected.oauth) {
          const refreshed = provider.filter((record) => record.route === '/oauth/token' && record.body?.grant_type === 'refresh_token' && record.status === 200).length
          assert.equal(refreshed > 0, expected.oauth.refreshToken !== state.oauth?.refreshToken, `${run.label}: refresh grants GitLab accepted (${refreshed})`)
        }
        if ('revoked' in expected.oauth) {
          const revoked = provider.filter((record) => record.route === '/oauth/revoke' && record.status === 200).map((record) => record.body.token)
          assert.deepStrictEqual(revoked, expected.oauth.revoked.map(toReal), `${run.label}: tokens revoked`)
        }
      }
      // a login's access token is the user's, and works
      const entry = Object.values(stored)[0]
      if (name === 'login' && entry?.oauth) {
        const me = await w.call(instance.url, 'GET', '/api/v4/user', { token: entry.oauth.accessToken })
        assert.equal(me.json?.username, 'maint', `${run.label}: the access token the provider stored is not maint's (HTTP ${me.status})`)
      }

      // the exchanges, in normal form
      const roles = makeRoles(new Map([...seedsOf(scenario)].map(([token, role]) => [toReal(token), role]).concat([[instance.admin, 'admin-pat']])), firstId)
      for (const [fake, id] of deployIds) {
        roles.dts.set(String(id), `dt${fake}`)
      }
      const names = new Map(Object.entries(ids).map(([number, id]) => [id, PROJECTS[number]]))
      return proxy.records.map((record) => {
        const exchange = normalise({ ...record, authorization: record.headers.authorization, headers: record.answered }, { names, dts: roles.dts, role: roles.role })
        roles.learn(record)
        return exchange
      })
    } finally {
      await run.cleanup()
    }
  } finally {
    await proxy.close()
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------------ probes

// Requests no scenario reaches, sent to the fake and to the real GitLab in the same state:
// what the provider or npm could send and a fake might answer differently. `as` is a
// credential: a role of the probe state (`read`, `write`, `other-read`, `oauth`, `dev-oauth`,
// `job`, `admin`), `garbage`, or none. `{p}` is the widgets project, `{o}` the other one,
// `{g}` the group, `{device_code}` the code the last device authorization gave.
const PROBE_FAKE_STATE = () => ({
  oauth: { refreshToken: 'probe-refresh', accessToken: 'probe-access', next: [], interval: 5, pending: 1 },
  access: { 'probe-dev-access': { level: 30 } },
  jobToken: 'probe-job-token',
  tokens: ['probe-created-1', 'probe-created-2'],
  nextId: 4,
  deployTokens: [
    { id: 1, token: 'probe-read-deploy', scopes: ['read_package_registry'], expires_at: '2099-01-01' },
    { id: 2, token: 'probe-write-deploy', scopes: ['write_package_registry'], expires_at: '2099-01-01' },
    { id: 3, token: 'probe-other-read', scopes: ['read_package_registry'], expires_at: '2099-01-01' },
  ],
  projectOf: { 3: '43' },
})
const FAKE_ROLES = { read: 'probe-read-deploy', write: 'probe-write-deploy', 'other-read': 'probe-other-read', oauth: 'probe-access', 'dev-oauth': 'probe-dev-access', job: 'probe-job-token', admin: ADMIN, garbage: 'garbage-token' }
const expiry = () => w.expiryDate(Date.now() / 1000 + 3600)
const TOKEN = (scopes) => () => ({ name: 'probe', scopes, expires_at: expiry() })
const PUBLISH = (version) => () => packument('@acme/widgets', version)
const PACKUMENT = '/api/v4/projects/{p}/packages/npm/@acme%2fwidgets'
const DEVICE = { form: () => ({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: '{device_code}' }) }
const PROBES = [
  // the API, with each kind of credential
  ['user, no credential', 'GET', '/api/v4/user', null],
  ['user, a token GitLab does not know', 'GET', '/api/v4/user', 'garbage'],
  ['user, the maintainer\'s OAuth token', 'GET', '/api/v4/user', 'oauth'],
  ['user, the developer\'s OAuth token', 'GET', '/api/v4/user', 'dev-oauth'],
  // deploy tokens: who may create and delete, and what a bad request gets
  ['deploy tokens, create, no credential', 'POST', '/api/v4/projects/{p}/deploy_tokens', null, TOKEN(['read_package_registry'])],
  ['deploy tokens, create, a token GitLab does not know', 'POST', '/api/v4/projects/{p}/deploy_tokens', 'garbage', TOKEN(['read_package_registry'])],
  ['deploy tokens, create, a developer\'s OAuth token', 'POST', '/api/v4/projects/{p}/deploy_tokens', 'dev-oauth', TOKEN(['read_package_registry'])],
  ['deploy tokens, create, a maintainer\'s OAuth token (read)', 'POST', '/api/v4/projects/{p}/deploy_tokens', 'oauth', TOKEN(['read_package_registry'])],
  ['deploy tokens, create, a maintainer\'s OAuth token (write)', 'POST', '/api/v4/projects/{p}/deploy_tokens', 'oauth', TOKEN(['write_package_registry'])],
  ['deploy tokens, create, no scopes', 'POST', '/api/v4/projects/{p}/deploy_tokens', 'oauth', () => ({ name: 'probe', expires_at: expiry() })],
  ['deploy tokens, create, an unknown scope', 'POST', '/api/v4/projects/{p}/deploy_tokens', 'oauth', TOKEN(['no_such_scope'])],
  ['deploy tokens, create, an expiry in the past', 'POST', '/api/v4/projects/{p}/deploy_tokens', 'oauth', () => ({ name: 'probe', scopes: ['read_package_registry'], expires_at: '2020-01-01' })],
  ['deploy tokens, create, a project nobody can see', 'POST', '/api/v4/projects/999999/deploy_tokens', 'oauth', TOKEN(['read_package_registry'])],
  ['deploy tokens, create, a project the maintainer is not a member of', 'POST', '/api/v4/projects/{o}/deploy_tokens', 'oauth', TOKEN(['read_package_registry'])],
  ['deploy tokens, delete, no such token', 'DELETE', '/api/v4/projects/{p}/deploy_tokens/999999', 'oauth'],
  ['deploy tokens, delete, a developer', 'DELETE', '/api/v4/projects/{p}/deploy_tokens/{dt:1}', 'dev-oauth'],
  ['deploy tokens, delete, the maintainer', 'DELETE', '/api/v4/projects/{p}/deploy_tokens/{dt:4}', 'oauth'],
  ['deploy tokens, delete, again', 'DELETE', '/api/v4/projects/{p}/deploy_tokens/{dt:4}', 'oauth'],
  // the OAuth endpoints
  ['oauth, refresh, a token GitLab does not know', 'POST', '/oauth/token', null, { form: () => ({ client_id: '{client}', grant_type: 'refresh_token', refresh_token: 'garbage-refresh' }) }],
  ['oauth, refresh, an unknown client', 'POST', '/oauth/token', null, { form: () => ({ client_id: 'no-such-client', grant_type: 'refresh_token', refresh_token: 'garbage-refresh' }) }],
  ['oauth, a grant type GitLab does not offer', 'POST', '/oauth/token', null, { form: () => ({ client_id: '{client}', grant_type: 'client_credentials' }) }],
  ['oauth, device authorization, an unknown client', 'POST', '/oauth/authorize_device', null, { form: () => ({ client_id: 'no-such-client', scope: 'api' }) }],
  ['oauth, device authorization, a scope the application lacks', 'POST', '/oauth/authorize_device', null, { form: () => ({ client_id: '{client}', scope: 'read_user' }) }],
  ['oauth, device authorization', 'POST', '/oauth/authorize_device', null, { form: () => ({ client_id: '{client}', scope: 'api' }) }],
  ['oauth, device token, not approved yet', 'POST', '/oauth/token', null, { form: () => ({ client_id: '{client}', ...DEVICE.form() }) }],
  ['oauth, device token, polled again at once', 'POST', '/oauth/token', null, { form: () => ({ client_id: '{client}', ...DEVICE.form() }) }],
  ['oauth, device token, a code nobody gave', 'POST', '/oauth/token', null, { form: () => ({ client_id: '{client}', grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'no-such-code' }) }],
  ['oauth, revoke, a token GitLab does not know', 'POST', '/oauth/revoke', null, { form: () => ({ client_id: '{client}', token: 'garbage-token' }) }],
  // the project registry, read
  ['packument, no credential', 'GET', PACKUMENT, null],
  ['packument, a token GitLab does not know', 'GET', PACKUMENT, 'garbage'],
  ['packument, a read deploy token', 'GET', PACKUMENT, 'read'],
  ['packument, a write deploy token', 'GET', PACKUMENT, 'write'],
  ['packument, a read deploy token of another project', 'GET', PACKUMENT, 'other-read'],
  ['packument, the maintainer\'s OAuth token', 'GET', PACKUMENT, 'oauth'],
  ['packument, the developer\'s OAuth token', 'GET', PACKUMENT, 'dev-oauth'],
  ['packument, a CI job token', 'GET', PACKUMENT, 'job'],
  ['packument, the administrator\'s token', 'GET', PACKUMENT, 'admin'],
  ['packument, a package the project does not hold', 'GET', '/api/v4/projects/{p}/packages/npm/@acme%2fmissing', 'read'],
  ['packument, a package of another scope', 'GET', '/api/v4/projects/{p}/packages/npm/@acme-tools%2flint-rules', 'read'],
  ['packument, a project that does not exist', 'GET', '/api/v4/projects/999999/packages/npm/@acme%2fwidgets', 'read'],
  ['packument, the registry URL without its trailing slash', 'GET', '/api/v4/projects/{p}/packages/npm', 'read'],
  // the group and instance registries, with a project deploy token
  ['packument, the group registry, a project read deploy token', 'GET', '/api/v4/groups/{g}/-/packages/npm/@acme%2fwidgets', 'read'],
  ['packument, the group registry, the administrator', 'GET', '/api/v4/groups/{g}/-/packages/npm/@acme%2fwidgets', 'admin'],
  ['packument, the instance registry, a project read deploy token', 'GET', '/api/v4/packages/npm/@acme%2fwidgets', 'read'],
  ['packument, the instance registry, the administrator', 'GET', '/api/v4/packages/npm/@acme%2fwidgets', 'admin'],
  // the project registry, write
  ['publish, no credential', 'PUT', PACKUMENT, null, PUBLISH('2.5.0')],
  ['publish, a read deploy token', 'PUT', PACKUMENT, 'read', PUBLISH('2.5.0')],
  ['publish, a write deploy token', 'PUT', PACKUMENT, 'write', PUBLISH('2.5.0')],
  ['publish, the same version again', 'PUT', PACKUMENT, 'write', PUBLISH('2.5.0')],
  ['publish, a CI job token', 'PUT', PACKUMENT, 'job', PUBLISH('2.5.1')],
  ['publish, a name outside the root group', 'PUT', '/api/v4/projects/{p}/packages/npm/@other%2fwidgets', 'write', () => packument('@other/widgets', '1.0.0')],
  ['publish, a write deploy token of another project', 'PUT', PACKUMENT, 'other-read', PUBLISH('2.5.2')],
  ['packument, after the publish', 'GET', PACKUMENT, 'read'],
  ['dist-tag, a read deploy token', 'PUT', '/api/v4/projects/{p}/packages/npm/-/package/@acme%2fwidgets/dist-tags/beta', 'read', () => '2.4.0'],
  ['dist-tag, a write deploy token', 'PUT', '/api/v4/projects/{p}/packages/npm/-/package/@acme%2fwidgets/dist-tags/beta', 'write', () => '2.4.0'],
  ['dist-tag, a CI job token', 'PUT', '/api/v4/projects/{p}/packages/npm/-/package/@acme%2fwidgets/dist-tags/beta', 'job', () => '2.4.0'],
]

const runProbes = async ({ instance, log }) => {
  const resolve = (value, ctx) =>
    typeof value === 'string'
      ? value.replace(/\{p\}/g, ctx.p).replace(/\{o\}/g, ctx.o).replace(/\{g\}/g, ctx.g).replace(/\{client\}/g, ctx.client).replace(/\{device_code\}/g, ctx.deviceCode || '').replace(/\{dt:(\d+)\}/g, (all, id) => ctx.dt(Number(id)))
      : value
  const send = async (base, ctx, [, method, route, as, spec]) => {
    const options = { token: as ? ctx.tokens[as] : undefined, headers: { 'x-harness': 'probe' } }
    const made = typeof spec === 'function' ? spec() : spec
    if (made && made.form) {
      options.form = Object.fromEntries(Object.entries(made.form()).map(([key, value]) => [key, resolve(value, ctx)]))
    } else if (made !== undefined && made !== null) {
      options.body = made
    }
    const res = await w.call(base, method, resolve(route, ctx), options)
    if (route === '/oauth/authorize_device' && res.json?.device_code) {
      ctx.deviceCode = res.json.device_code
    }
    return res
  }

  // the fake
  const fakeState = PROBE_FAKE_STATE()
  const handle = createFake(fakeState)
  const exchanges = []
  const fake = await startFake((request) => {
    let answer
    try {
      answer = handle(request) || { status: 404, json: { error: 'no such route' } }
    } catch (error) {
      answer = { status: 500, json: { error: error.message } }
      exchanges.push({ request, answer })
      throw error
    }
    exchanges.push({ request, answer })
    return answer
  })
  let fakeSide
  try {
    const ctx = { p: '42', o: '43', g: '7', client: 'probe-client', tokens: FAKE_ROLES, dt: (id) => String(id) }
    for (const probe of PROBES) {
      await send(fake.url, ctx, probe)
    }
    const roles = makeRoles(new Map(Object.entries(FAKE_ROLES).map(([role, token]) => [token, role === 'oauth' ? 'oauth-access' : role === 'read' || role === 'other-read' ? 'read-deploy' : role === 'write' ? 'write-deploy' : role === 'job' ? 'job-token' : role === 'admin' ? 'admin-pat' : role === 'dev-oauth' ? 'dev-oauth' : role])), 4)
    for (const id of [1, 2, 3]) {
      roles.dts.set(String(id), `dt${id}`)
    }
    const names = new Map([['42', 'widgets'], ['43', 'other'], ['7', 'group']])
    fakeSide = exchanges.map(({ request, answer }) => {
      const record = { src: 'npm', method: request.method, route: request.path, authorization: request.headers.authorization, body: request.body, status: answer.status, headers: { ...(answer.json === undefined ? {} : { 'content-type': 'application/json' }), ...(answer.headers || {}) }, json: answer.json }
      const exchange = normalise(record, { names, dts: roles.dts, role: roles.role })
      roles.learn(record)
      return exchange
    })
  } finally {
    await fake.close()
  }

  // the real one
  await w.reset(instance, log)
  const ids = { p: instance.projects.widgets.id, o: instance.projects.other.id, g: String(instance.group.id) }
  const read = await w.createDeployToken(instance, ids.p, { scopes: ['read_package_registry'] })
  const write = await w.createDeployToken(instance, ids.p, { scopes: ['write_package_registry'] })
  const otherRead = await w.createDeployToken(instance, ids.o, { scopes: ['read_package_registry'] })
  const maint = await w.oauthPair(instance, 'maint')
  const dev = await w.oauthPair(instance, 'dev')
  const tokens = { read: read.token, write: write.token, 'other-read': otherRead.token, oauth: maint.access, 'dev-oauth': dev.access, job: instance.jobToken, admin: instance.admin, garbage: 'garbage-token' }
  const proxy = await w.startProxy(instance.url)
  try {
    const dtIds = new Map([[1, read.id], [2, write.id], [3, otherRead.id]])
    const ctx = { ...ids, client: instance.clientId, tokens, dt: (id) => String(dtIds.get(id) ?? id) }
    // the deploy token a probe makes is the fourth, as in the fake
    for (const probe of PROBES) {
      if (probe[2].includes('{dt:4}')) {
        const created = proxy.records.filter((record) => record.method === 'POST' && /\/deploy_tokens$/.test(record.route) && record.status === 201 && record.json.scopes.includes('read_package_registry')).pop()
        dtIds.set(4, created?.json.id)
      }
      if (probe[2].includes('{dt:4}') && !dtIds.get(4)) {
        dtIds.set(4, 999998)
      }
      await send(proxy.url, ctx, probe)
    }
    const roles = makeRoles(new Map([[read.token, 'read-deploy'], [write.token, 'write-deploy'], [otherRead.token, 'read-deploy'], [maint.access, 'oauth-access'], [dev.access, 'dev-oauth'], [instance.jobToken, 'job-token'], [instance.admin, 'admin-pat'], ['garbage-token', 'garbage']]), 4)
    for (const [fake2, real] of dtIds) {
      roles.dts.set(String(real), `dt${fake2}`)
    }
    const names = new Map([[ids.p, 'widgets'], [ids.o, 'other'], [ids.g, 'group']])
    const realSide = proxy.records.map((record) => {
      const exchange = normalise({ ...record, authorization: record.headers.authorization, headers: record.answered }, { names, dts: roles.dts, role: roles.role })
      roles.learn(record)
      return exchange
    })
    return { fakeSide, realSide }
  } finally {
    await proxy.close()
  }
}

// -------------------------------------------------------------------------- main

const main = async () => {
  const url = arg('url', process.env.GITLAB_URL || 'http://localhost:8929')
  const container = arg('container', 'gitlab')
  const image = arg('image', '(not given)')
  const only = arg('only', '') ? arg('only').split(',') : null
  const expectTag = arg('expect-image-tag', '')
  const log = (text) => console.log(text)
  console.log(`GitLab live run: image ${image}, ${url}`)

  const instance = await w.setUpInstance({ url, container, log })
  const version = instance.version
  const major = Number(version.split('.')[0])
  const label = `gitlab ${version} (image ${image}, revision ${instance.revision})`
  console.log(label)
  if (expectTag) {
    assert.equal(version, expectTag.replace(/-ce\.\d+$/, ''), `the image tag ${expectTag} is not the GitLab version ${version} the instance reports`)
  }
  try {
    instance.jobToken = (await w.jobToken(instance, instance.projects.widgets.id)).token
    log('setup: a CI job token, made in the Rails console')
  } catch (error) {
    instance.jobToken = null
    log(`setup: no CI job token (${error.message.split('\n').slice(0, 6).join(' | ')})`)
  }

  const skips = JSON.parse(fs.readFileSync(path.join(here, 'gitlab-skips.json'), 'utf8')).skips
  const allow = JSON.parse(fs.readFileSync(path.join(here, 'gitlab-divergences.json'), 'utf8')).allow
  const transcripts = transcriptsOf(NAME)
  const names = transcripts.map((file) => path.basename(file, '.jsonl'))
  for (const name of Object.keys(skips)) {
    assert.ok(names.includes(name), `gitlab-skips.json lists ${name}, which is not a scenario`)
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
    try {
      const scenario = variantOf(name, loadScenario(transcript))
      const fake = await runFake(transcript, scenario)
      const real = await realRun({ instance, transcript, scenario, log })
      if (process.env.GITLAB_LIVE_TRACE) {
        real.forEach((exchange, at) => console.log(`  ${name} #${at + 1} ${describe(exchange)} -> ${JSON.stringify(exchange.answer)}`))
      }
      divergences.push(...compare(name, fake, real))
      ran += 1
      console.log(`ok ${name} (${fake.length} calls on the fake, ${real.length} on GitLab)`)
    } catch (error) {
      failures.push(`${name}: ${error.stack || error.message}`)
      console.log(`FAIL ${name}`)
    }
  }
  if (!only || only.includes('probes')) {
    try {
      const { fakeSide, realSide } = await runProbes({ instance, log })
      if (process.env.GITLAB_LIVE_TRACE) {
        realSide.forEach((exchange, at) => console.log(`  probes #${at + 1} ${describe(exchange)} -> ${JSON.stringify(exchange.answer)}`))
      }
      divergences.push(...compare('probes', fakeSide, realSide))
      console.log(`ok probes (${PROBES.length} requests)`)
    } catch (error) {
      failures.push(`probes: ${error.stack || error.message}`)
      console.log('FAIL probes')
    }
  }

  console.log(`\nskipped against ${label} (${skipped.length}):`)
  for (const [name, reason] of skipped) {
    console.log(`  ${name}: ${reason}`)
  }
  const { fresh, unused } = report({ product: 'gitlab', version, divergences, allow, only, allowFile: 'gitlab-divergences.json' })
  for (const failure of failures) {
    console.log(`\n${failure}`)
  }
  console.log(`\n${ran} scenarios ran against ${label}, ${skipped.length} skipped, ${failures.length} failed, ${fresh} new divergences, ${unused} stale allowlist entries`)
  if (failures.length || fresh || unused) {
    process.exitCode = 1
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message)
    process.exitCode = 1
  })
}

module.exports = { runFake, variantOf, loadScenario, PROBES, PROBE_FAKE_STATE, FAKE_ROLES }
