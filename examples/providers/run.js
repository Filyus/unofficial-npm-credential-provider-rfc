'use strict'
// Runs each reference provider against the transcripts of its example and
// checks that the provider, started as npm starts it, answers every client
// line with exactly the recorded answer.
//
//   node examples/providers/run.js [provider ...]
//
// For examples/<name>/<t>.jsonl the scenario examples/providers/<name>/
// scenarios/<t>.json gives the starting state: what the provider has stored,
// the vendor API's state (served by the provider's fake.js on 127.0.0.1),
// the clock (`now`, or `clock` with one time per client request), the
// environment, and the person's scripted answers, every one of which the
// provider must ask for. After the
// session, `expect.store` and `expect.state` are compared, as subsets, with
// what the provider left stored and the state the fake ended in. Every
// transcript of an example must have a scenario, so a new exchange cannot
// go unchecked.

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { startFake } = require('./lib/fake-server.js')
const { SENTINEL } = require('./lib/protocol.js')

const here = __dirname
const examples = path.join(here, '..')

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

const runTranscript = async (name, transcriptFile) => {
  const base = path.basename(transcriptFile, '.jsonl')
  const scenarioFile = path.join(here, name, 'scenarios', `${base}.json`)
  assert.ok(fs.existsSync(scenarioFile), `${name}/${base}: no scenario at ${path.relative(examples, scenarioFile)}`)
  const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'))
  const { createFake } = require(path.join(here, name, 'fake.js'))
  const fakeState = structuredClone(scenario.state || {})
  const fake = await startFake(createFake(fakeState))
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `provider-${name}-`))
  let child = null
  try {
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
        person: { mode: 'scripted', presence: scenario.presence || [], log: 'asked.log' },
      }),
    )

    // npm's environment for a provider carries no npm config; CI detection
    // is the provider's, from the variables the scenario sets
    const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...(scenario.env || {}) }
    child = spawn(process.execPath, [path.join(here, name, 'provider.js'), SENTINEL, '--config', configFile], {
      cwd: path.join(here, name),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const exited = new Promise((resolve) => child.on('close', resolve))
    const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    const next = async (what) => {
      const { value, done } = await lines.next()
      assert.ok(!done, `${name}/${base}: provider closed stdout before ${what}\n${stderr}`)
      return JSON.parse(value)
    }

    let step = 0
    let pending = null
    for (const event of readJsonl(transcriptFile)) {
      step += 1
      const where = `${name}/${base} line ${step}`
      if (event.from === 'client' && event.event === 'close') {
        child.stdin.end()
      } else if (event.from === 'client') {
        if (scenario.clock) {
          assert.ok(clock.length, `${where}: the scenario's clock has no time left for this request`)
          fs.writeFileSync(clockFile, String(clock.shift()))
        }
        child.stdin.write(`${JSON.stringify(event.message)}\n`)
        pending = event.message
      } else {
        const got = await next(pending ? `the answer to ${pending.kind}` : 'hello')
        assert.deepStrictEqual(got, event.message, `${where}\n${stderr}`)
        pending = null
      }
    }
    const code = await exited
    assert.equal(code, 0, `${name}/${base}: provider exited ${code}\n${stderr}`)
    const askedFile = path.join(scratch, 'asked.log')
    const asked = fs.existsSync(askedFile) ? fs.readFileSync(askedFile, 'utf8').split('\n').filter(Boolean) : []
    assert.equal(
      asked.length,
      (scenario.presence || []).length,
      `${name}/${base}: the provider asked for presence ${asked.length} times, the scenario scripts ${(scenario.presence || []).length} answers`,
    )
    if (scenario.expect?.store) {
      assertSubset(JSON.parse(fs.readFileSync(storeFile, 'utf8')), scenario.expect.store, `${name}/${base} store`)
    }
    if (scenario.expect?.state) {
      assertSubset(fakeState, scenario.expect.state, `${name}/${base} state`)
    }
  } finally {
    if (child && child.exitCode === null) {
      child.kill()
    }
    await fake.close()
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

const main = async () => {
  const wanted = process.argv.slice(2)
  const names = fs
    .readdirSync(here, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(here, entry.name, 'provider.js')))
    .map((entry) => entry.name)
    .filter((name) => !wanted.length || wanted.includes(name))
  assert.ok(names.length, 'no reference provider found')
  let count = 0
  for (const name of names) {
    const transcripts = fs.readdirSync(path.join(examples, name)).filter((file) => file.endsWith('.jsonl')).sort()
    assert.ok(transcripts.length, `${name}: the example has no transcripts`)
    for (const file of transcripts) {
      await runTranscript(name, path.join(examples, name, file))
      count += 1
      console.log(`ok ${name}/${file}`)
    }
  }
  console.log(`${count} transcripts, ${names.length} providers`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
