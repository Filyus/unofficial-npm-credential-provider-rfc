'use strict'
// Prepares one transcript's scenario for a client other than run.js, such
// as the Rust one in poc/rust, and runs its checks when that client is done.
//
//   node examples/providers/scenario.js            the transcripts, one per line
//   node examples/providers/scenario.js <name> <transcript.jsonl>
//   node examples/providers/scenario.js --sessions <seed> <name> <transcript.jsonl>
//
// With a transcript it starts the fake vendor API, prints one JSON line
// ({provider, cwd, configFile, env}) saying how to start the provider, and
// then reads its stdin: `tick` before each client request moves the clock
// and is answered `ticked` once it has,
// and the end of stdin runs the checks run.js runs after a session (the
// presence answers asked for, the store, the fake's state). It exits 0 when
// they hold and 1, with the reason on stderr, when they do not. The
// provider's stderr stays with the client, so the secret check is run.js's.
//
// With --sessions the client sends requests of its own from the
// scenario's starting state, so the end checks do not apply: presence
// answers come from the seed, the first line also carries `askedFile` and
// `secrets`, and the end of stdin prints the secrets known by then (tokens
// the fake minted included) as a last JSON line.

const path = require('node:path')
const readline = require('node:readline')
const { prepare, providerNames, transcriptsOf } = require('./lib/scenario.js')

const main = async () => {
  const args = process.argv.slice(2)
  const sessions = args[0] === '--sessions'
  const seed = sessions ? Number(args[1]) : 0
  const [name, transcript] = sessions ? args.slice(2) : args
  if (!name) {
    for (const each of providerNames()) {
      for (const file of transcriptsOf(each)) {
        console.log(`${each} ${file}`)
      }
    }
    return
  }
  // a small LCG: the same seed gives the same answers
  let state = seed || 1
  const presence = Array.from({ length: 200 }, () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state % 3 !== 0
  })
  const run = await prepare(name, path.resolve(transcript), sessions ? { presence } : {})
  try {
    const setup = { provider: run.provider, cwd: run.cwd, configFile: run.configFile, env: run.env }
    console.log(JSON.stringify(sessions ? { ...setup, askedFile: run.askedFile, secrets: run.secrets() } : setup))
    let requests = 0
    for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      if (line.trim() === 'tick') {
        requests += 1
        run.tick(`${run.label} request ${requests}`)
        // the client waits for this before it sends the request, or the
        // provider could read the clock before it moved
        console.log('ticked')
      }
    }
    if (sessions) {
      console.log(JSON.stringify({ secrets: run.secrets() }))
    } else {
      run.finish(null)
    }
  } finally {
    await run.cleanup()
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
