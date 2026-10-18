'use strict'
// The provider side of the Phase 2 protocol, shared by the reference
// providers: the sentinel check, hello, one JSON line per request, one per
// answer, and diagnostics on stderr only. A provider supplies a hello and a
// handler per request kind; whatever a handler returns is the answer.
//
// What arrives is not trusted. A line over the size limit is dropped as it
// arrives, never buffered, and one that is not UTF-8, not JSON, not an object
// or not a request the schema accepts is answered with an error and the
// session goes on: one answer per line, never an `Ok` for a line that is not
// a valid request.

const SENTINEL = '--npm-credential-provider'

// The floor Phase 2 sets for a maximum line size: 1 MiB, newline excluded.
const MAX_LINE_BYTES = 1024 * 1024

const ok = (kind, fields = {}) => ({ Ok: { kind, ...fields } })
const err = (kind, message, causedBy) => ({
  Err: {
    kind,
    ...(message === undefined ? {} : { message }),
    ...(causedBy === undefined ? {} : { causedBy }),
  },
})

// Arguments after the sentinel, as `--name value` pairs.
const parseArgs = (argv) => {
  if (argv[0] !== SENTINEL) {
    return null
  }
  const args = {}
  for (let i = 1; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) {
      throw new Error(`unexpected argument ${argv[i]}`)
    }
    args[argv[i].slice(2)] = argv[i + 1]
  }
  return args
}

const log = (...parts) => process.stderr.write(`${parts.join(' ')}\n`)

// The lines of a byte stream, as { bytes } or, for a line over the limit,
// { oversized: true }. An oversized line is counted and thrown away chunk by
// chunk, so a peer cannot make the provider hold more than the limit.
async function* readLines(stream, limit = MAX_LINE_BYTES) {
  let chunks = []
  let size = 0
  let over = false
  for await (const chunk of stream) {
    let start = 0
    for (;;) {
      const newline = chunk.indexOf(0x0a, start)
      const end = newline === -1 ? chunk.length : newline
      if (!over) {
        size += end - start
        if (size > limit) {
          over = true
          chunks = []
        } else {
          chunks.push(chunk.subarray(start, end))
        }
      }
      if (newline === -1) {
        break
      }
      yield over ? { oversized: true } : { bytes: Buffer.concat(chunks) }
      chunks = []
      size = 0
      over = false
      start = newline + 1
    }
  }
  if (over) {
    yield { oversized: true }
  } else if (size > 0) {
    yield { bytes: Buffer.concat(chunks) }
  }
}

// ignoreBOM keeps a byte order mark in the text, where JSON.parse refuses it
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

const IDENTIFIER = /^[a-z][a-z0-9-]*$/
const SCOPE = /^@[^/]+$/
const GRANULARITIES = new Set(['registry', 'scope', 'package'])
const REQUIRE_VERSION = new Set(['publish', 'stage', 'stage-reject'])
const nonEmpty = (value) => typeof value === 'string' && value.length > 0

// The schema's `request` definition (spec/protocol-v1.schema.json): the first
// thing wrong with a parsed request, or null. It says nothing about the
// values; a provider decides what it serves.
const validateRequest = (message) => {
  const has = (key) => Object.hasOwn(message, key)
  if (message.v !== 1) {
    return 'v must be 1'
  }
  if (typeof message.kind !== 'string' || !IDENTIFIER.test(message.kind)) {
    return 'kind must be a lowercase identifier'
  }
  if (typeof message.registry !== 'string') {
    return 'registry must be a string'
  }
  if (has('scope') && !(typeof message.scope === 'string' && SCOPE.test(message.scope))) {
    return 'scope must look like @name'
  }
  for (const key of ['package', 'version', 'command', 'token']) {
    if (has(key) && !nonEmpty(message[key])) {
      return `${key} must be a non-empty string`
    }
  }
  for (const key of ['interactive', 'retry']) {
    if (has(key) && typeof message[key] !== 'boolean') {
      return `${key} must be a boolean`
    }
  }
  if (has('operation') && !(typeof message.operation === 'string' && IDENTIFIER.test(message.operation))) {
    return 'operation must be a lowercase identifier'
  }
  if (has('granularity') && !GRANULARITIES.has(message.granularity)) {
    return 'granularity must be registry, scope or package'
  }
  if (has('httpStatus') && !(Number.isInteger(message.httpStatus) && message.httpStatus >= 100 && message.httpStatus <= 599)) {
    return 'httpStatus must be an HTTP status code'
  }
  if (has('authChallenges') && !(Array.isArray(message.authChallenges) && message.authChallenges.every((item) => typeof item === 'string'))) {
    return 'authChallenges must be a list of strings'
  }
  if (message.kind === 'get' && !(has('operation') && has('interactive'))) {
    return 'get needs operation and interactive'
  }
  if (message.kind === 'erase' && !(has('operation') && has('granularity'))) {
    return 'erase needs operation and granularity'
  }
  if (REQUIRE_VERSION.has(message.operation) && !has('version')) {
    return `${message.operation} needs version`
  }
  if (message.retry === true && !has('httpStatus')) {
    return 'retry needs httpStatus'
  }
  return null
}

// One line to its request, or the answer to give instead. Nothing of the line
// is echoed in the answer: a login request carries a token.
const parseRequest = (line) => {
  if (line.oversized) {
    return { answer: err('other', `a line over ${MAX_LINE_BYTES} bytes was rejected whole`) }
  }
  let message
  try {
    message = JSON.parse(utf8.decode(line.bytes))
  } catch {
    return { answer: err('other', 'malformed request: not UTF-8 JSON') }
  }
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return { answer: err('other', 'malformed request: not a JSON object') }
  }
  const problem = validateRequest(message)
  return problem ? { answer: err('other', `malformed request: ${problem}`) } : { message }
}

// Runs the session: `start(args)` returns { hello, handlers }, where
// handlers maps a request kind to an async function of the request. A kind
// with no handler, or an operation the handler does not know, is answered
// `operation-not-supported`, never treated as a read.
const serve = async (start) => {
  const args = parseArgs(process.argv.slice(2))
  if (!args) {
    log(`run by npm with ${SENTINEL}; this provider has no standalone mode`)
    process.exitCode = 2
    return
  }
  const { hello, handlers } = await start(args)
  // a client that has gone away is the end of the session, not a crash
  process.stdout.on('error', () => process.exit(0))
  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
  write(hello)

  // strictly sequential: npm sends the next request only after the answer
  for await (const line of readLines(process.stdin)) {
    if (line.bytes && line.bytes.every((byte) => byte === 0x20 || byte === 0x09 || byte === 0x0d)) {
      continue
    }
    const { message, answer: rejected } = parseRequest(line)
    if (rejected) {
      write(rejected)
      continue
    }
    // own properties only: a kind named `constructor` is not a handler
    const handler = Object.hasOwn(handlers, message.kind) ? handlers[message.kind] : null
    let answer
    try {
      answer = handler ? await handler(message) : err('operation-not-supported')
    } catch (error) {
      answer = err('other', error.message)
    }
    write(answer)
  }
}

module.exports = { SENTINEL, MAX_LINE_BYTES, ok, err, serve, log, readLines, validateRequest, parseRequest }
