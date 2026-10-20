'use strict'
// A scenario prepared for one transcript: the fake vendor API started from
// its state, the provider's own configuration written, the clock set, and
// the checks to run once the session is over. run.js drives a provider with
// it; scenario.js hands it to another client, such as the Rust one.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { startFake } = require('./fake-server.js')

const providers = path.join(__dirname, '..')
const examples = path.join(providers, '..')

const readJsonl = (file) =>
  fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line))

// `actual` contains `expected`: every key of expected, recursively, with an
// equal value; arrays compare whole.
// `null` in expected means the key is absent (or null).
const assertSubset = (actual, expected, where) => {
  if (expected === null) {
    assert.ok(actual === undefined || actual === null, `${where}: expected absent, got ${JSON.stringify(actual)}`)
    return
  }
  if (typeof expected !== 'object' || Array.isArray(expected)) {
    assert.deepStrictEqual(actual, expected, where)
    return
  }
  assert.ok(actual && typeof actual === 'object', `${where}: expected an object, got ${JSON.stringify(actual)}`)
  for (const [key, value] of Object.entries(expected)) {
    assertSubset(actual[key], value, `${where}.${key}`)
  }
}

// Every secret a scenario puts within the provider's reach: a string right
// under a key that names a token, secret or password (or in an array so
// named), and the keys of an object so named when they look like a token
// rather than a package or a cache key (a fake's table of live tokens), in
// the store, the fake's state, the environment, the provider's fixtures and
// every message of the transcript. Records under such a key are searched by
// their own keys, so a token's tier or package is not taken for a secret.
const SECRET_KEY = /token|secret|password|credential/i
const collectSecrets = (value, secretContext = false, found = new Set()) => {
  if (typeof value === 'string') {
    if (secretContext && value.length >= 6) {
      found.add(value)
    }
  } else if (Array.isArray(value)) {
    value.forEach((item) => collectSecrets(item, secretContext, found))
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const named = SECRET_KEY.test(key)
      if (named && item && typeof item === 'object' && !Array.isArray(item)) {
        Object.keys(item)
          .filter((inner) => !/[:/@]/.test(inner))
          .forEach((inner) => collectSecrets(inner, true, found))
      }
      collectSecrets(item, named, found)
    }
  }
  return found
}

const fixtureSecrets = (name) => {
  const dir = path.join(providers, name, 'fixtures')
  const found = new Set()
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      collectSecrets(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')), false, found)
    }
  }
  return found
}

// `presence` replaces the scenario's scripted answers, for sessions that are
// not the transcript's (tests/test_provider_sessions.py). `owned` is told what
// has been started, so that a setup that fails can give it back.
const setUp = async (name, transcriptFile, { presence, scenarioFile: given } = {}, owned = {}) => {
  const base = path.basename(transcriptFile, '.jsonl')
  const label = `${name}/${base}`
  const scenarioFile = given ?? path.join(providers, name, 'scenarios', `${base}.json`)
  assert.ok(fs.existsSync(scenarioFile), `${label}: no scenario at ${path.relative(examples, scenarioFile)}`)
  const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'))
  const { createFake } = require(path.join(providers, name, 'fake.js'))
  const fakeState = structuredClone(scenario.state || {})
  const fake = await startFake(createFake(fakeState))
  owned.fake = fake
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `provider-${name}-`))
  owned.scratch = scratch

  // `now` is the clock at the start; `clock`, if given, is the clock for
  // each client request in turn, so time can pass between requests
  const clockFile = path.join(scratch, 'clock')
  const clock = [...(scenario.clock || [])]
  fs.writeFileSync(clockFile, String(scenario.now ?? 0))
  const storeFile = path.join(scratch, 'store.json')
  fs.writeFileSync(storeFile, JSON.stringify(scenario.store || {}))
  const endpoints = Object.fromEntries((scenario.hosts || []).map((origin) => [origin, fake.url]))
  const configFile = path.join(scratch, 'config.json')
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      ...(scenario.config || {}),
      store: 'store.json',
      endpoints,
      clock: 'clock',
      person: { mode: 'scripted', presence: presence || scenario.presence || [], log: 'asked.log' },
    }),
  )

  return {
    label,
    askedFile: path.join(scratch, 'asked.log'),
    // what the scenario puts within the provider's reach, for a client
    // that checks stderr itself
    secrets: () => [
      ...new Set([
        ...collectSecrets({ store: scenario.store, state: scenario.state, env: scenario.env, config: scenario.config }),
        ...collectSecrets(readJsonl(transcriptFile).map((event) => event.message)),
        ...collectSecrets(JSON.parse(fs.readFileSync(storeFile, 'utf8'))),
        ...collectSecrets(fakeState),
        ...fixtureSecrets(name),
      ]),
    ],
    provider: path.join(providers, name, 'provider.js'),
    cwd: path.join(providers, name),
    configFile,
    // npm's environment for a provider carries no npm config; CI detection
    // is the provider's, from the variables the scenario sets
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...(scenario.env || {}) },

    // before each client request
    tick: (where) => {
      if (scenario.clock) {
        assert.ok(clock.length, `${where}: the scenario's clock has no time left for this request`)
        fs.writeFileSync(clockFile, String(clock.shift()))
      }
    },

    // after the session; `stderr` is the provider's, when the client kept it
    finish: (stderr) => {
      if (stderr !== null) {
        // stderr is logged by npm: no secret of the scenario may appear in it as it is.
        // A masked or partial value is not looked for, and neither is a secret of fewer
        // than six characters (see collectSecrets)
        const secrets = new Set([
          ...collectSecrets({ store: scenario.store, state: scenario.state, env: scenario.env, config: scenario.config }),
          ...collectSecrets(readJsonl(transcriptFile).map((event) => event.message)),
          ...collectSecrets(JSON.parse(fs.readFileSync(storeFile, 'utf8'))),
          ...collectSecrets(fakeState),
          ...fixtureSecrets(name),
        ])
        const leaked = [...secrets].filter((secret) => stderr.includes(secret))
        assert.deepEqual(leaked, [], `${label}: the provider wrote a secret to stderr`)
      }
      const askedFile = path.join(scratch, 'asked.log')
      const asked = fs.existsSync(askedFile) ? fs.readFileSync(askedFile, 'utf8').split('\n').filter(Boolean) : []
      const scripted = (scenario.presence || []).length
      assert.equal(asked.length, scripted, `${label}: the provider asked for presence ${asked.length} times, the scenario scripts ${scripted} answers`)
      if (scenario.expect?.store) {
        assertSubset(JSON.parse(fs.readFileSync(storeFile, 'utf8')), scenario.expect.store, `${label} store`)
      }
      if (scenario.expect?.state) {
        assertSubset(fakeState, scenario.expect.state, `${label} state`)
      }
    },

    cleanup: async () => {
      await fake.close()
      fs.rmSync(scratch, { recursive: true, force: true })
    },
  }
}

// A scenario that cannot be set up fails with its reason, and leaves no fake
// server listening and no scratch directory behind: a run that hangs on a
// bad scenario hides what was wrong with it.
const prepare = async (name, transcriptFile, options = {}) => {
  const owned = {}
  try {
    return await setUp(name, transcriptFile, options, owned)
  } catch (error) {
    if (owned.fake) {
      await owned.fake.close()
    }
    if (owned.scratch) {
      fs.rmSync(owned.scratch, { recursive: true, force: true })
    }
    throw error
  }
}

// The reference providers, and the transcripts of each one's example.
const providerNames = () =>
  fs
    .readdirSync(providers, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(providers, entry.name, 'provider.js')))
    .map((entry) => entry.name)
const transcriptsOf = (name) =>
  fs
    .readdirSync(path.join(examples, name))
    .filter((file) => file.endsWith('.jsonl'))
    .sort()
    .map((file) => path.join(examples, name, file))

module.exports = { prepare, readJsonl, providerNames, transcriptsOf }
