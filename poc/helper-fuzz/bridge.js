'use strict'
// What the Phase 1a runner makes of what a token helper printed, for the
// differential fuzzing in tests/fuzz_helper.py.
//
//   node poc/helper-fuzz/bridge.js <npm-cli checkout>
//
// The runner is npm/cli's lib/utils/token-helper.js, used as npm uses it: the
// factory it exports, given a stub config, asked for a registry's header. Only
// @npmcli/promise-spawn is replaced, by a process that "prints" what the
// request says, so no program is started.
//
// Reads JSON lines from stdin, each {op, stdout, stderr} with the helper's
// output as base64, and writes one JSON line for each:
//   header: {ok: <Authorization value>} or {err: <message>}
//   config: {refused: <why the setting is refused, or null>}, for {op, value}
//   log:    {lines: [<what the runner logs of stderr>]}
//   route:  {outcome: ran | plain-http | project-route | run-credential, started: <helpers started>},
//           for {op, uri, given: [<keys>], transport: [{key, source}]}

const Module = require('node:module')
const path = require('node:path')
const readline = require('node:readline')

let printed = { stdout: '', stderr: '' }
let started = 0
const fakeSpawn = () => {
  started += 1
  const child = { stdout: null, stderr: null, once () {}, on () {} }
  const promise = Promise.resolve({ code: 0, signal: null, ...printed })
  promise.process = child
  return promise
}

const load = Module._load
Module._load = function (request, ...rest) {
  return request === '@npmcli/promise-spawn' ? fakeSpawn : load.call(this, request, ...rest)
}
const runner = require(path.resolve(process.argv[2], 'lib', 'utils', 'token-helper.js'))
Module._load = load

const REG = '//bridge.example/'
const HELPER = process.platform === 'win32' ? 'C:\\bridge\\helper.exe' : '/bridge/helper'
// The stub config answers what the runner asks of npm's config: which keys for
// the registry the command line or the environment gave a credential under
// (`given`), and which route settings a project chose (`transport`, each
// `{ key, source }`). Both are empty unless a `route` op says otherwise.
const ask = (helper, { uri, given = [], transport = [] } = {}) => runner({
  flat: { tokenHelpers: { [REG]: helper } },
  get: () => undefined,
  credentialKeysFromCliOrEnv: () => given,
  tokenHelperProjectTransport: transport,
}, {})({ regKey: REG, uri })

const logs = []
process.on('log', (level, ...args) => logs.push([level, ...args]))

const main = async () => {
  for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const { op, stdout, stderr, value, uri, given, transport } = JSON.parse(line)
    printed = {
      stdout: Buffer.from(stdout ?? '', 'base64').toString('utf8'),
      stderr: Buffer.from(stderr ?? '', 'base64').toString('utf8'),
    }
    // a setting, or a route, is judged by whether the helper starts, so it prints a token
    if (op === 'config' || op === 'route') {
      printed = { stdout: 'tok', stderr: '' }
    }
    logs.length = 0
    started = 0
    let answer
    if (op === 'route') {
      // what the runner does with a request to `uri`: runs the helper, or says why not, before anything starts
      const outcome = await ask(HELPER, { uri, given, transport }).then(
        (header) => (header === undefined ? 'run-credential' : 'ran'),
        (error) => (/plain http/.test(error.message) ? 'plain-http' : /route that a project chose/.test(error.message) ? 'project-route' : `error: ${error.message}`))
      answer = { outcome, started }
    } else if (op === 'config') {
      // the helper is run, or the value is refused before anything starts
      answer = await ask(value).then(() => ({ refused: null }), (error) => ({ refused: error.message }))
    } else if (op === 'header') {
      answer = await ask(HELPER).then((ok) => ({ ok }), (error) => ({ err: error.message }))
    } else {
      await ask(HELPER).catch(() => {})
      // what the runner logs of stderr: every `token-helper` line it logged
      answer = { lines: logs.filter(l => l[1] === 'token-helper').map(l => l.slice(2).join(' ')) }
    }
    process.stdout.write(`${JSON.stringify(answer)}\n`)
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
