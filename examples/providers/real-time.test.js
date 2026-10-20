'use strict'
// The one part a conformance run does not exercise: outside a run, a
// provider's time is the system clock and its sleeps are real timers. These
// tests take a few real seconds, which is why run.js does not do this.
//
//   node --test examples/providers/

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const test = require('node:test')
const { loadContext } = require('./lib/context.js')
const { startFake } = require('./lib/fake-server.js')
const { SENTINEL } = require('./lib/protocol.js')

const scratchConfig = (t, config) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-real-time-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, JSON.stringify({ store: 'store.json', ...config }))
  return file
}

test('without a run clock, time is the system clock and sleep waits', async (t) => {
  const ctx = loadContext(scratchConfig(t, {}))
  assert.ok(Math.abs(ctx.clockMs() - Date.now()) < 1000)
  assert.ok(Math.abs(ctx.now() - Date.now() / 1000) < 2)
  const before = Date.now()
  const clockBefore = ctx.clockMs()
  await ctx.sleep(300)
  assert.ok(Date.now() - before >= 290, 'sleep returned before its time')
  assert.ok(ctx.clockMs() - clockBefore >= 290, 'the clock did not move with the system clock')
})

test('without a run clock, a request carries no run time', async (t) => {
  let seen
  const fake = await startFake((request) => {
    seen = request
    return { status: 200, json: {} }
  })
  t.after(() => fake.close())
  const ctx = loadContext(scratchConfig(t, { endpoints: { 'https://registry.example.test': fake.url } }))
  await ctx.request('GET', 'https://registry.example.test/ping')
  assert.equal(seen.clockSent, false, 'a real request carried the conformance clock header')
})

test('the npmjs.com provider waits out Retry-After on real timers', async (t) => {
  const state = { login: { pending: 1, token: 'example-session-token', retryAfter: 1 } }
  const beganAt = Date.now()
  const fake = await startFake(require('./npmjs/fake.js').createFake(state))
  t.after(() => fake.close())
  // no `clock`: the provider runs on the system clock, as outside a run
  const config = scratchConfig(t, { endpoints: { 'https://registry.npmjs.org': fake.url }, pollMs: 20 })
  const dir = path.dirname(config)
  // started with pipes and no console, as npm starts it, in a directory of
  // its own: the sign-in text must not land in a file there
  const child = spawn(process.execPath, [path.join(__dirname, 'npmjs', 'provider.js'), SENTINEL, '--config', config], {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  t.after(() => child.kill())
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  assert.deepEqual(JSON.parse((await lines.next()).value).v, [1])
  const started = Date.now()
  child.stdin.write(`${JSON.stringify({ v: 1, kind: 'login', registry: 'https://registry.npmjs.org/', interactive: true })}\n`)
  assert.deepEqual(JSON.parse((await lines.next()).value), { Ok: { kind: 'login' } })
  const took = Date.now() - started
  child.stdin.end()
  await new Promise((resolve) => child.on('close', resolve))

  assert.ok(took >= 950, `the login took ${took} ms, less than the Retry-After of 1 s`)
  assert.equal(state.tooSoon, undefined, 'a poll came sooner than Retry-After')
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => /^CON(IN|OUT)\$$|^tty$/i.test(name)),
    [],
    `the provider wrote a terminal name as a file\n${stderr}`,
  )
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8'))
  const issuedAt = stored.tokens.find((entry) => entry.tier === 'session').issuedAt
  // inside the test's own window, whatever a slow runner makes of its length: the point is the system clock, not a fixed one
  assert.ok(issuedAt >= beganAt / 1000 - 2 && issuedAt <= Date.now() / 1000 + 2, 'the token was stamped with a time that is not now')
})

// A provider answers a presence prompt and has nothing more to do: it must be
// able to exit, not wait out the deadline of the prompt. The deadline of a
// prompt is minutes, and a timer that is not cleared holds the process.
test('a deadline that did not pass does not keep the process alive', async (t) => {
  const config = scratchConfig(t, {})
  const script = `
    const { loadContext } = require(${JSON.stringify(path.join(__dirname, 'lib', 'context.js'))})
    const ctx = loadContext(${JSON.stringify(config)})
    ctx.withDeadline(() => Promise.resolve("answered"), 30000).then((answer) => console.log(answer))
  `
  const started = Date.now()
  const done = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.on('close', (code) => resolve({ code, out }))
    t.after(() => child.kill())
  })
  assert.equal(done.out.trim(), 'answered')
  assert.ok(Date.now() - started < 10000, `the process stayed ${Date.now() - started} ms for a half-minute deadline`)
})

test('a deadline that passes gives null, and aborts what was waiting', async (t) => {
  const ctx = loadContext(scratchConfig(t, {}))
  let aborted = false
  const started = Date.now()
  const answer = await ctx.withDeadline(
    (signal) =>
      new Promise(() => {
        signal.addEventListener('abort', () => {
          aborted = true
        })
      }),
    200,
  )
  assert.equal(answer, null)
  assert.ok(Date.now() - started >= 190)
  assert.ok(aborted, 'the task was told to stop')
})
