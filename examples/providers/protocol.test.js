'use strict'
// The provider side of the wire, without a provider: how lines are cut, and
// what becomes of a line that is not a request.
//
//   node --test examples/providers/

const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const test = require('node:test')
const { readLines, parseRequest, validateRequest, MAX_LINE_BYTES } = require('./lib/protocol.js')

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
  assert.ok(rejected(deep))
  const wide = `{"v":1,"kind":"x","registry":"r","a":[${'0,'.repeat(400000)}0]}`
  assert.equal(rejected(wide), undefined)
})

test('the limit is the 1 MiB the RFC sets as the floor', () => {
  assert.equal(MAX_LINE_BYTES, 1048576)
})
