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
const path = require('node:path')
const readline = require('node:readline')
const { prepare, readJsonl, providerNames, transcriptsOf } = require('./lib/scenario.js')
const { SENTINEL } = require('./lib/protocol.js')

const runTranscript = async (name, transcriptFile) => {
  const run = await prepare(name, transcriptFile)
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
        child.stdin.write(`${JSON.stringify(event.message)}\n`)
        pending = event.message
      } else {
        const got = await next(pending ? `the answer to ${pending.kind}` : 'hello')
        assert.deepStrictEqual(got, event.message, `${where}\n${stderr}`)
        pending = null
      }
    }
    const code = await exited
    assert.equal(code, 0, `${label}: provider exited ${code}\n${stderr}`)
    // one answer per request and nothing after the last: a line the provider
    // wrote beyond the transcript (or after stdin closed) is a failure too
    const extra = await lines.next()
    assert.ok(extra.done, `${label}: the provider wrote a line the transcript does not have: ${extra.value}\n${stderr}`)
    run.finish(stderr)
  } finally {
    if (child && child.exitCode === null) {
      child.kill()
    }
    await run.cleanup()
  }
}

const main = async () => {
  const wanted = process.argv.slice(2)
  const names = providerNames().filter((name) => !wanted.length || wanted.includes(name))
  assert.ok(names.length, 'no reference provider found')
  let count = 0
  for (const name of names) {
    const transcripts = transcriptsOf(name)
    assert.ok(transcripts.length, `${name}: the example has no transcripts`)
    for (const file of transcripts) {
      await runTranscript(name, file)
      count += 1
      console.log(`ok ${name}/${path.basename(file)}`)
    }
  }
  console.log(`${count} transcripts, ${names.length} providers`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
