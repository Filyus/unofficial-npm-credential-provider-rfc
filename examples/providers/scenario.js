'use strict'
// Prepares one transcript's scenario for a client other than run.js, such
// as the Rust one in poc/rust, and runs its checks when that client is done.
//
//   node examples/providers/scenario.js            the transcripts, one per line
//   node examples/providers/scenario.js <name> <transcript.jsonl>
//
// With a transcript it starts the fake vendor API, prints one JSON line
// ({provider, cwd, configFile, env}) saying how to start the provider, and
// then reads its stdin: `tick` before each client request moves the clock,
// and the end of stdin runs the checks run.js runs after a session (the
// presence answers asked for, the store, the fake's state). It exits 0 when
// they hold and 1, with the reason on stderr, when they do not. The
// provider's stderr stays with the client, so the secret check is run.js's.

const path = require('node:path')
const readline = require('node:readline')
const { prepare, providerNames, transcriptsOf } = require('./lib/scenario.js')

const main = async () => {
  const [name, transcript] = process.argv.slice(2)
  if (!name) {
    for (const each of providerNames()) {
      for (const file of transcriptsOf(each)) {
        console.log(`${each} ${file}`)
      }
    }
    return
  }
  const run = await prepare(name, path.resolve(transcript))
  try {
    console.log(JSON.stringify({ provider: run.provider, cwd: run.cwd, configFile: run.configFile, env: run.env }))
    let requests = 0
    for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      if (line.trim() === 'tick') {
        requests += 1
        run.tick(`${run.label} request ${requests}`)
      }
    }
    run.finish(null)
  } finally {
    await run.cleanup()
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
