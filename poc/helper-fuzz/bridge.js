'use strict'
// What the Phase 1 prototype makes of what a token helper printed, for the
// differential fuzzing in tests/fuzz_helper.py.
//
//   node poc/helper-fuzz/bridge.js <npm-registry-fetch checkout>
//
// Reads JSON lines from stdin, each {op, stdout, stderr} with the helper's
// output as base64, and writes one JSON line for each:
//   header: {ok: <Authorization value>} or {err: <message>}
//   config: {refused: <why the setting is refused, or null>}, for {op, value}
//   log:    {lines: [<what the prototype logs of stderr>]}
// `log` runs what the prototype runs on a finished helper's stderr, in the
// order it runs it: scrub, split into lines, drop control characters, mask.

const path = require('node:path')
const readline = require('node:readline')

const helper = require(path.resolve(process.argv[2], 'lib', 'token-helper.js'))

const logged = (stderr, stdout) => {
  const lines = []
  for (const line of helper.scrub(stderr, stdout).split(/\r?\n/)) {
    // the strip run() applies: C0 and C1 controls but tab
    const shown = line.replace(/[^\t\x20-\x7e\xa0-￿]/g, '')
    if (shown.trim()) {
      lines.push(helper.mask(shown))
    }
  }
  return lines
}

const main = async () => {
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const { op, stdout, stderr, value } = JSON.parse(line)
    const out = Buffer.from(stdout ?? '', 'base64').toString('utf8')
    const err = Buffer.from(stderr ?? '', 'base64').toString('utf8')
    let answer
    if (op === 'config') {
      answer = { refused: helper.refusal(value) }
    } else if (op === 'header') {
      try {
        answer = { ok: helper.toHeader('/h', out) }
      } catch (error) {
        answer = { err: error.message }
      }
    } else {
      answer = { lines: logged(err, out) }
    }
    process.stdout.write(`${JSON.stringify(answer)}\n`)
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
