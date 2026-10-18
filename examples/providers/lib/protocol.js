'use strict'
// The provider side of the Phase 2 protocol, shared by the reference
// providers: the sentinel check, hello, one JSON line per request, one per
// answer, and diagnostics on stderr only. A provider supplies a hello and a
// handler per request kind; whatever a handler returns is the answer.

const readline = require('node:readline')

const SENTINEL = '--npm-credential-provider'

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
  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
  write(hello)

  // strictly sequential: npm sends the next request only after the answer
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) {
      continue
    }
    const request = JSON.parse(line)
    const handler = handlers[request.kind]
    let answer
    try {
      answer = handler ? await handler(request) : err('operation-not-supported')
    } catch (error) {
      answer = err('other', error.message)
    }
    write(answer)
  }
}

module.exports = { SENTINEL, ok, err, serve, log }
