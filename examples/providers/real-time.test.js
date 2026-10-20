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
const http = require('node:http')
const { PassThrough } = require('node:stream')
const { loadContext, readLineFrom, editSecret, discardBuffered, guardRawMode, restoreRawModes, RequestTimeout } = require('./lib/context.js')
const { startFake } = require('./lib/fake-server.js')
const { SENTINEL } = require('./lib/protocol.js')

// An await that cannot outlive the test: a hung child or a stream that never
// ends fails in `ms` and does not wait for the CI job to be cancelled
const within = (promise, ms, what) => {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: no result within ${ms} ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

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
  // the sign-in step is scripted, so a runner with no terminal still gets as far as the polling; the
  // clock is not (no `clock`), which is what this test is about
  const config = scratchConfig(t, {
    endpoints: { 'https://registry.npmjs.org': fake.url },
    pollMs: 20,
    person: { mode: 'scripted', presence: [], log: 'asked.log' },
  })
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
  assert.deepEqual(JSON.parse((await within(lines.next(), 15000, 'hello')).value).v, [1])
  const started = Date.now()
  child.stdin.write(`${JSON.stringify({ v: 1, kind: 'login', registry: 'https://registry.npmjs.org/', interactive: true })}\n`)
  assert.deepEqual(JSON.parse((await within(lines.next(), 30000, 'the login answer')).value), { Ok: { kind: 'login' } })
  const took = Date.now() - started
  child.stdin.end()
  await within(new Promise((resolve) => child.on('close', resolve)), 15000, 'the provider closing')

  assert.ok(took >= 950, `the login took ${took} ms, less than the Retry-After of 1 s`)
  assert.equal(state.tooSoon, undefined, 'a poll came sooner than Retry-After')
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
  const done = await within(new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.on('close', (code) => resolve({ code, out }))
    t.after(() => child.kill())
  }), 20000, 'the process exiting')
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

test('with no run person, the sign-in step goes to the terminal or the login stops at once, and no terminal name becomes a file', async (t) => {
  const state = { login: { pending: 0, token: 'example-session-token' } }
  const fake = await startFake(require('./npmjs/fake.js').createFake(state))
  t.after(() => fake.close())
  const config = scratchConfig(t, { endpoints: { 'https://registry.npmjs.org': fake.url }, pollMs: 20 })
  const dir = path.dirname(config)
  // started with pipes and no console, as npm starts it, in a directory of its own
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
  assert.deepEqual(JSON.parse((await within(lines.next(), 15000, 'hello')).value).v, [1])
  child.stdin.write(`${JSON.stringify({ v: 1, kind: 'login', registry: 'https://registry.npmjs.org/', interactive: true })}\n`)
  const answer = JSON.parse((await within(lines.next(), 30000, 'the login answer')).value)
  child.stdin.end()
  await within(new Promise((resolve) => child.on('close', resolve)), 15000, 'the provider closing')
  // a runner may or may not have a terminal; both outcomes are right, and nothing in between
  const shown = answer.Ok && answer.Ok.kind === 'login'
  const stopped = answer.Err && answer.Err.kind === 'other' && /no terminal/i.test(answer.Err.message || '')
  assert.ok(shown || stopped, `unexpected answer ${JSON.stringify(answer)}`)
  if (stopped) {
    assert.equal(state.polls ?? 0, 0, 'it polled a sign-in nobody could see')
  }
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => /^CON(IN|OUT)\$$|^tty$/i.test(name)),
    [],
    `the provider wrote a terminal name as a file\n${stderr}`,
  )
})

// a vendor that accepts the connection and never answers
const startHung = async (t) => {
  const sockets = new Set()
  const server = http.createServer(() => {})
  server.on('connection', (socket) => sockets.add(socket))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    for (const socket of sockets) {
      socket.destroy()
    }
    server.close()
  })
  return `http://127.0.0.1:${server.address().port}`
}

test('a call to a vendor that never answers fails within its deadline, without a clock and in a run', async (t) => {
  const url = await startHung(t)
  const real = loadContext(scratchConfig(t, { requestTimeoutMs: 150, endpoints: { 'https://registry.example.test': url } }))
  let started = Date.now()
  await assert.rejects(within(real.request('GET', 'https://registry.example.test/poll?secret=x'), 5000, 'the default deadline'), (error) => {
    assert.ok(error instanceof RequestTimeout)
    assert.equal(error.code, 'ETIMEDOUT')
    assert.ok(!error.message.includes('secret'), 'the message quoted the query')
    return true
  })
  assert.ok(Date.now() - started < 3000)
  // `timeoutMs` bounds one call, `until` a time on the clock of the context
  started = Date.now()
  await assert.rejects(within(real.request('GET', 'https://registry.example.test/', { timeoutMs: 100 }), 5000, 'timeoutMs'), RequestTimeout)
  await assert.rejects(within(real.request('GET', 'https://registry.example.test/', { until: real.clockMs() + 100 }), 5000, 'until'), RequestTimeout)
  assert.ok(Date.now() - started < 3000, 'until did not shorten the wait')
  await assert.rejects(real.request('GET', 'https://registry.example.test/', { until: real.clockMs() - 1 }), RequestTimeout)

  // in a run the clock is a file: a deadline already past fails at once, and the real bound is the default one
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-clock-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'clock'), '1000')
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ store: 'store.json', clock: 'clock', requestTimeoutMs: 150, endpoints: { 'https://registry.example.test': url } }))
  const run = loadContext(path.join(dir, 'config.json'))
  await assert.rejects(run.request('GET', 'https://registry.example.test/', { until: run.clockMs() }), RequestTimeout)
  await assert.rejects(within(run.request('GET', 'https://registry.example.test/', { until: run.clockMs() + 600000 }), 5000, 'run'), RequestTimeout)
})

test('a call that answers in time is not cut short', async (t) => {
  const fake = await startFake(() => ({ status: 200, json: { fine: true } }))
  t.after(() => fake.close())
  const ctx = loadContext(scratchConfig(t, { requestTimeoutMs: 5000, endpoints: { 'https://registry.example.test': fake.url } }))
  const res = await ctx.request('GET', 'https://registry.example.test/', { until: ctx.clockMs() + 5000 })
  assert.deepEqual(res.json, { fine: true })
})

test('a store that cannot be written leaves no temporary file beside it', (t) => {
  const file = scratchConfig(t, {})
  const dir = path.dirname(file)
  const ctx = loadContext(file)
  // a directory where the store goes: the rename fails after the temporary was written
  fs.mkdirSync(path.join(dir, 'store.json'))
  assert.throws(() => ctx.writeStore({ tokens: ['secret'] }))
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), [])
  // and one that cannot even be opened
  const sub = loadContext(scratchConfig(t, { store: 'missing-dir/store.json' }))
  assert.throws(() => sub.writeStore({}))
})

test('a line read from a terminal stream: split characters, end of input, abort', async () => {
  const split = new PassThrough()
  const euro = Buffer.from('p\u20acw\r\nrest')
  const pending = readLineFrom(split)
  split.write(euro.subarray(0, 2))
  split.write(euro.subarray(2, 3))
  split.write(euro.subarray(3))
  assert.equal(await within(pending, 2000, 'split line'), 'p\u20acw')

  const typed = new PassThrough()
  const eof = readLineFrom(typed)
  typed.end('no newline')
  assert.equal(await within(eof, 2000, 'end of input'), 'no newline')

  const closed = new PassThrough()
  const nothing = readLineFrom(closed)
  closed.end()
  assert.equal(await within(nothing, 2000, 'empty end of input'), null)

  const idle = new PassThrough()
  const controller = new AbortController()
  const aborted = readLineFrom(idle, controller.signal)
  controller.abort()
  assert.equal(await within(aborted, 2000, 'abort'), null)
})

test('a secret typed in raw mode is edited as a line is', () => {
  assert.deepEqual(editSecret('', 'ab\u007fc\r'), { text: 'ac', done: true, cancelled: false })
  assert.deepEqual(editSecret('', 'x'), { text: 'x', done: false, cancelled: false })
  assert.deepEqual(editSecret('ab', 'c\u0015d\n'), { text: 'd', done: true, cancelled: false })
  assert.equal(editSecret('ab', '\u0003').cancelled, true)
  assert.equal(editSecret('', '\u0004').cancelled, true)
  assert.deepEqual(editSecret('ab', '\u0004'), { text: 'ab', done: true, cancelled: false })
})

test('a malformed provider body is a 500 from the fake and the run goes on', async () => {
  const fake = await startFake(() => ({ status: 200, json: {} }))
  try {
    const bad = await fetch(`${fake.url}/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })
    assert.equal(bad.status, 500)
    const good = await fetch(`${fake.url}/x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(good.status, 200)
  } finally {
    await fake.close()
  }
})

test('what was typed before a question is discarded, and what is typed after it is not', async () => {
  const input = new PassThrough()
  input.write('y\ny\n')
  const discarded = discardBuffered(input, 20)
  input.write('half a li')
  await within(discarded, 2000, 'discarding type-ahead')
  input.write('real answer\n')
  assert.equal(await within(readLineFrom(input), 2000, 'reading the answer'), 'real answer')
})

test('raw mode of a secret prompt is given back by the exit and SIGTERM handlers, and the handlers go with the prompt', () => {
  const modes = []
  const terminal = { setRawMode: (on) => modes.push(on) }
  const before = { exit: process.listenerCount('exit'), term: process.listenerCount('SIGTERM') }
  const release = guardRawMode(terminal)
  assert.equal(process.listenerCount('exit'), before.exit + 1)
  assert.equal(process.listenerCount('SIGTERM'), before.term + 1)
  restoreRawModes()
  assert.deepEqual(modes, [false], 'a stopped provider turns raw mode off')
  release()
  assert.deepEqual(modes, [false, false])
  assert.equal(process.listenerCount('exit'), before.exit)
  assert.equal(process.listenerCount('SIGTERM'), before.term)
})
