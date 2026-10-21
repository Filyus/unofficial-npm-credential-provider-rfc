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
const path = require('node:path')
const { prepare, providerNames, transcriptsOf } = require('./lib/scenario.js')
const { runSession } = require('./lib/session.js')

const runTranscript = async (name, transcriptFile) => {
  const run = await prepare(name, transcriptFile)
  try {
    run.finish(await runSession(run, transcriptFile))
  } finally {
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
