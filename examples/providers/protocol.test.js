'use strict'
// The provider side of the wire, without a provider: how lines are cut, and
// what becomes of a line that is not a request.
//
//   node --test examples/providers/

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const test = require('node:test')
const { readLines, parseRequest, validateRequest, MAX_LINE_BYTES, Answer, err, guarded } = require('./lib/protocol.js')

const GET = { v: 1, kind: 'get', registry: 'https://r.test/', operation: 'read', interactive: true }
const lines = async (chunks, limit) => {
  const found = []
  for await (const line of readLines(Readable.from(chunks.map((chunk) => Buffer.from(chunk))), limit)) {
    found.push(line.oversized ? 'OVERSIZED' : line.bytes.toString())
  }
  return found
}

test('a line may arrive in pieces, and several in one', async () => {
  assert.deepEqual(await lines(['ab', 'c\nde', 'f\ng\n']), ['abc', 'def', 'g'])
  assert.deepEqual(await lines(['\n\n', 'a\n']), ['', '', 'a'])
  assert.deepEqual(await lines(['a\r\n']), ['a\r'])
})

test('the last line counts without its newline, and a stream with no line gives none', async () => {
  assert.deepEqual(await lines(['a\nb']), ['a', 'b'])
  assert.deepEqual(await lines([]), [])
})

test('a line over the limit is dropped whole, wherever the pieces fall, and the next one is read', async () => {
  assert.deepEqual(await lines(['aaaaaa\nok\n'], 5), ['OVERSIZED', 'ok'])
  assert.deepEqual(await lines(['aaa', 'aaa', 'aaa\nok\n'], 5), ['OVERSIZED', 'ok'])
  assert.deepEqual(await lines(['aaaaa\n'], 5), ['aaaaa'])
  assert.deepEqual(await lines(['aaaaaa'], 5), ['OVERSIZED'])
})

test('an oversized line is not kept in memory while it is read', async () => {
  const chunk = Buffer.alloc(1 << 20, 0x61)
  const before = process.memoryUsage().arrayBuffers
  let peak = 0
  const stream = Readable.from(
    (function* () {
      for (let i = 0; i < 200; i += 1) {
        yield chunk
        peak = Math.max(peak, process.memoryUsage().arrayBuffers - before)
      }
      yield Buffer.from('\nok\n')
    })(),
  )
  const found = []
  for await (const line of readLines(stream)) {
    found.push(line.oversized ? 'OVERSIZED' : line.bytes.toString())
  }
  assert.deepEqual(found, ['OVERSIZED', 'ok'])
  assert.ok(peak < 64 << 20, `${peak} bytes held while 200 MiB went by`)
})

const rejected = (bytes) => parseRequest({ bytes: Buffer.from(bytes) }).answer

test('a request is read, and what is not one is answered with an error that echoes none of it', () => {
  assert.deepEqual(parseRequest({ bytes: Buffer.from(JSON.stringify(GET)) }).message, GET)
  for (const bad of ['', '{', 'null', '[]', '7', '"get"', '{"v":2}', '{"Ok":{}}', '﻿{}']) {
    const answer = rejected(bad)
    assert.equal(answer.Err.kind, 'other', bad)
    assert.ok(answer.Err.message.startsWith('malformed request'), bad)
  }
  const secret = rejected('{"v":1,"kind":"login","registry":"https://r.test/","token":"s3cret-value","retry":null}')
  assert.ok(!JSON.stringify(secret).includes('s3cret-value'))
  assert.equal(parseRequest({ oversized: true }).answer.Err.kind, 'other')
})

test('bytes that are not UTF-8 are refused, not repaired', () => {
  const line = Buffer.concat([Buffer.from('{"v":1,"kind":"get","registry":"https://r.test/","operation":"read","interactive":true,"command":"'), Buffer.from([0xff]), Buffer.from('"}')])
  assert.ok(parseRequest({ bytes: line }).answer)
})

test('a request has what the schema asks of it', () => {
  assert.equal(validateRequest(GET), null)
  const bad = [
    { ...GET, v: 2 },
    { ...GET, kind: 'Get' },
    { ...GET, kind: 'constructor ' },
    { ...GET, registry: 1 },
    { ...GET, scope: 'a' },
    { ...GET, scope: '@a/b' },
    { ...GET, package: '' },
    { ...GET, retry: null },
    { ...GET, httpStatus: 99 },
    { ...GET, httpStatus: 401.5 },
    { ...GET, authChallenges: [1] },
    { ...GET, operation: 'publish' },
    { v: 1, kind: 'get', registry: 'https://r.test/', interactive: true },
    { v: 1, kind: 'erase', registry: 'https://r.test/', operation: 'read' },
    { ...GET, retry: true },
  ]
  for (const request of bad) {
    assert.notEqual(validateRequest(request), null, JSON.stringify(request))
  }
  assert.equal(validateRequest({ ...GET, operation: 'frobnicate', extra: { anything: [1] } }), null)
  assert.equal(validateRequest({ ...GET, retry: true, httpStatus: 403, authChallenges: ['Bearer'] }), null)
})

test('lone surrogates and numbers beyond a double are refused wherever they are, however deep', () => {
  assert.ok(rejected('{"v":1,"kind":"x","registry":"r","a":"\\ud800"}'))
  assert.ok(rejected('{"v":1,"kind":"x","registry":"r","\\udc00":1}'))
  assert.ok(rejected('{"v":1,"kind":"x","registry":"r","a":[{"b":1e400}]}'))
  assert.equal(rejected('{"v":1,"kind":"x","registry":"r","a":"\\ud83d\\ude00"}'), undefined)
  const deep = `{"v":1,"kind":"x","registry":"r","a":${'['.repeat(100000)}"\\ud800"${']'.repeat(100000)}}`
  // refused for the surrogate, not for the depth: the same nesting without it is a request
  assert.match(rejected(deep).Err.message, /lone surrogate/)
  assert.equal(rejected(deep.replace('\\ud800', 'a')), undefined)
  const wide = `{"v":1,"kind":"x","registry":"r","a":[${'0,'.repeat(400000)}0]}`
  assert.equal(rejected(wide), undefined)
})

test('the limit is the 1 MiB the RFC sets as the floor', () => {
  assert.equal(MAX_LINE_BYTES, 1048576)
})

test('a line of exactly 1 MiB with its newline is read, as the RFC floor requires, and the limit counts the line without it', async () => {
  const count = async (chunks) => {
    const found = []
    for await (const line of readLines(Readable.from(chunks))) {
      found.push(line.oversized ? 'OVERSIZED' : line.bytes.length)
    }
    return found
  }
  const line = (bytes) => Buffer.alloc(bytes, 0x20)
  const nl = Buffer.from('\n')
  // 1 MiB counting the newline: the floor every peer must accept, however the pieces fall
  assert.deepEqual(await count([Buffer.concat([line(MAX_LINE_BYTES - 1), nl])]), [MAX_LINE_BYTES - 1])
  assert.deepEqual(await count([line(MAX_LINE_BYTES - 1), nl]), [MAX_LINE_BYTES - 1])
  assert.deepEqual(await count([line(1 << 19), line((1 << 19) - 1), Buffer.from('\nok\n')]), [MAX_LINE_BYTES - 1, 2])
  // the limit is the choice of this reader (the RFC says at least 1 MiB, newline counted): it
  // counts the bytes before the newline, so the line that is one byte over the floor is still read
  assert.deepEqual(await count([Buffer.concat([line(MAX_LINE_BYTES), nl])]), [MAX_LINE_BYTES])
  // and the first line over the limit is dropped whole, the next one read
  assert.deepEqual(await count([Buffer.concat([line(MAX_LINE_BYTES + 1), nl, Buffer.from('ok\n')])]), ['OVERSIZED', 2])
  assert.deepEqual(await count([line(MAX_LINE_BYTES + 1)]), ['OVERSIZED'])
})

test('what a handler throws is the answer, except that a parse error quotes nothing', async () => {
  const script = `
    const { serve, Answer, err } = require(${JSON.stringify(path.join(__dirname, 'lib', 'protocol.js'))})
    serve(async () => ({
      hello: { v: [1] },
      handlers: {
        get: async (request) => {
          if (request.package === 'parse') {
            throw new SyntaxError('Unexpected token s, "client_secret: s3cr3t-value-xyz" is not valid JSON')
          }
          if (request.package === 'answer') {
            throw new Answer(err('other', 'raised from a helper'))
          }
          throw new Error('the registry said no')
        },
      },
    }))
  `
  const fs = require('node:fs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-test-'))
  const file = path.join(dir, 'provider.js')
  fs.writeFileSync(file, script)
  const child = spawn(process.execPath, [file, '--npm-credential-provider'], { stdio: ['pipe', 'pipe', 'inherit'] })
  const lines = []
  // a provider that never answers fails this test in seconds, not at the runner's limit
  const waitFor = async (condition, what) => {
    const stop = Date.now() + 10000
    while (!condition()) {
      assert.ok(Date.now() < stop, `no ${what} within 10 s`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  let buffered = ''
  child.stdout.on('data', (chunk) => {
    buffered += chunk
    let at
    while ((at = buffered.indexOf('\n')) !== -1) {
      lines.push(JSON.parse(buffered.slice(0, at)))
      buffered = buffered.slice(at + 1)
    }
  })
  const answerTo = async (package_) => {
    const before = lines.length
    child.stdin.write(`${JSON.stringify({ ...GET, package: package_ })}\n`)
    await waitFor(() => lines.length > before, 'answer')
    return lines.at(-1)
  }
  try {
    await waitFor(() => lines.length > 0, 'hello')
    const parse = await answerTo('parse')
    assert.equal(parse.Err.kind, 'other')
    assert.ok(!JSON.stringify(parse).includes('s3cr3t'), JSON.stringify(parse))
    assert.equal((await answerTo('other')).Err.message, 'the registry said no')
    assert.deepEqual(await answerTo('answer'), { Err: { kind: 'other', message: 'raised from a helper' } })
  } finally {
    child.kill()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a scenario that cannot be set up fails with its reason and leaves nothing listening', async () => {
  const { prepare } = require('./lib/scenario.js')
  const fs = require('node:fs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-test-'))
  try {
    const scenarioFile = path.join(dir, 'bad.json')
    fs.writeFileSync(scenarioFile, JSON.stringify({ hosts: 5 }))
    const transcript = path.join(__dirname, '..', 'npmjs', 'install.jsonl')
    await assert.rejects(prepare('npmjs', transcript, { scenarioFile }), /map is not a function|hosts/)
    // the handle is released a moment after close() calls back
    const stop = Date.now() + 2000
    while (process.getActiveResourcesInfo().includes('TCPServerWrap') && Date.now() < stop) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(!process.getActiveResourcesInfo().includes('TCPServerWrap'), 'a fake server is still listening')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const runProvider = (...args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'gitlab', 'provider.js'), ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end()
  })

test('a provider that cannot start says why on stderr, exits non-zero and writes nothing to stdout', async () => {
  const missing = await runProvider('--npm-credential-provider')
  assert.equal(missing.code, 2)
  assert.equal(missing.stdout, '')
  assert.match(missing.stderr, /cannot start: --config <file> is required/)
  assert.doesNotMatch(missing.stderr, /\bat .*\.js:\d+/, 'no stack trace')
  const twice = await runProvider('--npm-credential-provider', '--config', 'a', '--config', 'b')
  assert.equal(twice.code, 2)
  assert.match(twice.stderr, /--config given twice/)
})

test('every provider that shows a sign-in step stops when it could not be shown', () => {
  const fs = require('node:fs')
  const calls = []
  for (const name of fs.readdirSync(__dirname)) {
    const file = path.join(__dirname, name, 'provider.js')
    if (!fs.existsSync(file)) {
      continue
    }
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (line.includes('showToPerson(')) {
        calls.push({ where: `${name}/provider.js:${index + 1}`, checked: /if \(!ctx\.showToPerson\(/.test(line) })
      }
    })
  }
  assert.ok(calls.length >= 8, `found ${calls.length} calls`)
  assert.deepEqual(calls.filter((call) => !call.checked).map((call) => call.where), [], 'a call that ignores whether the step was shown')
})

test('guarded turns a raised Answer into the answer and lets any other error through', async () => {
  const answer = err('other', 'no')
  assert.deepEqual(await guarded(async () => { throw new Answer(answer) })({}), answer)
  await assert.rejects(guarded(async () => { throw new Error('boom') })({}), /boom/)
})
