'use strict'
// One provider session against a prepared scenario (lib/scenario.js): the
// provider is started as npm starts it, fed the client lines of a transcript,
// and every line it answers must equal the recorded one. run.js drives the
// reference providers with it; live/verdaccio.js drives the Verdaccio one the
// same way against a real server.

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const { readJsonl } = require('./scenario.js')
const { SENTINEL } = require('./protocol.js')

// Runs the session and returns the provider's stderr. `hooks` (all optional):
//   expected(message)        the recorded provider message, as this run must see it
//                            (a live run swaps in the tokens a real server minted)
//   beforeClient(message)    called before a client request is sent (async)
//   afterAnswer(request, message)  called with each provider answer (async)
const runSession = async (run, transcriptFile, hooks = {}) => {
  const { label } = run
  let child = null
  try {
    child = spawn(process.execPath, [run.provider, SENTINEL, '--config', run.configFile], {
      cwd: run.cwd,
      env: run.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const exited = new Promise((resolve) => child.on('close', resolve))
    const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    // time inside a run is synthetic, so a provider that has not answered
    // within a few real seconds is waiting on something that will not come
    const next = async (what) => {
      let timer
      const { value, done } = await Promise.race([
        lines.next(),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${label}: no answer within 10 s, waiting for ${what}\n${stderr}`)), 10000)
        }),
      ]).finally(() => clearTimeout(timer))
      assert.ok(!done, `${label}: provider closed stdout before ${what}\n${stderr}`)
      return JSON.parse(value)
    }

    let step = 0
    let pending = null
    for (const event of readJsonl(transcriptFile)) {
      step += 1
      const where = `${label} line ${step}`
      if (event.from === 'client' && event.event === 'close') {
        child.stdin.end()
      } else if (event.from === 'client') {
        run.tick(where)
        if (hooks.beforeClient) {
          await hooks.beforeClient(event.message)
        }
        child.stdin.write(`${JSON.stringify(event.message)}\n`)
        pending = event.message
      } else {
        const got = await next(pending ? `the answer to ${pending.kind}` : 'hello')
        const want = hooks.expected ? hooks.expected(event.message) : event.message
        assert.deepStrictEqual(got, want, `${where}\n${stderr}`)
        if (pending && hooks.afterAnswer) {
          await hooks.afterAnswer(pending, got)
        }
        pending = null
      }
    }
    const code = await exited
    assert.equal(code, 0, `${label}: provider exited ${code}\n${stderr}`)
    // one answer per request and nothing after the last: a line the provider
    // wrote beyond the transcript (or after stdin closed) is a failure too
    const extra = await lines.next()
    assert.ok(extra.done, `${label}: the provider wrote a line the transcript does not have: ${extra.value}\n${stderr}`)
    return stderr
  } finally {
    if (child && child.exitCode === null) {
      child.kill()
    }
  }
}

module.exports = { runSession }
