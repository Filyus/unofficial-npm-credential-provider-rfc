'use strict'

// Fuzzes how a tokenHelper key can be spelled in the places a repository or
// a script controls (project .npmrc, a workspace root's .npmrc, npm_config_*
// variables, command-line flags, publishConfig), and checks that none of them
// makes npm use a helper. The trust rule filters keys with a pattern while
// npm-registry-fetch reads one exact key; this looks for any spelling that the
// first misses and the second still finds, after ini parsing, environment
// expansion and config flattening.
//
// Two oracles: every case is loaded in-process (the real Config class, then
// npm-registry-fetch's getAuth on the result); a sample also runs a real npm
// against a local registry with a helper that leaves a marker file when it
// runs. Positive controls (the exact key in user config) must use the helper
// in both, or the oracles are blind.
//
//   node poc/npm-config-fuzz/spellings.js <npm-cli> <npm-registry-fetch> <scratch dir> [cases] [seed]

const { execFile } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')

const [npmCliDir, fetchDir, scratch] = process.argv.slice(2, 5).map(p => p && path.resolve(p))
const CASES = Number(process.argv[5] || 2000)
let seed = Number(process.argv[6] || 1)
if (!npmCliDir || !fetchDir || !scratch) {
  console.error('usage: node poc/npm-config-fuzz/spellings.js <npm-cli> <npm-registry-fetch> <scratch dir> [cases] [seed]')
  process.exit(2)
}
const Config = require(path.join(npmCliDir, 'workspaces', 'config'))
const { definitions, flatten, nerfDarts, shorthands } =
  require(path.join(npmCliDir, 'workspaces', 'config', 'lib', 'definitions'))
const getAuth = require(path.join(fetchDir, 'lib', 'auth.js'))

const random = () => {
  seed = (seed + 0x6D2B79F5) | 0
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296
}
const pick = list => list[Math.floor(random() * list.length)]

const base = path.join(scratch, 'npm-spellings')
fs.rmSync(base, { recursive: true, force: true })
const write = (p, content) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

// a helper that leaves a marker, behind a wrapper so a node path with spaces
// cannot break it
const marker = path.join(base, 'helper-ran')
write(path.join(base, 'helper', 'helper.js'),
  `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); console.log('tok')\n`)
let helper
if (process.platform === 'win32') {
  helper = path.join(base, 'helper', 'helper.cmd')
  write(helper, `@"${process.execPath}" "${path.join(base, 'helper', 'helper.js')}"\r\n`)
} else {
  helper = path.join(base, 'helper', 'helper')
  const sq = s => `'${s.replaceAll("'", "'\\''")}'`
  write(helper, `#!/bin/sh\nexec ${sq(process.execPath)} ${sq(path.join(base, 'helper', 'helper.js'))}\n`)
  fs.chmodSync(helper, 0o755)
}

// ---------- spellings ----------

const HOST = '127.0.0.1:4873'
const keyName = [
  'tokenHelper', 'tokenHelper', 'tokenHelper', 'TokenHelper', 'TOKENHELPER', 'tokenhelper', 'tokenHelpeR',
  'tokеnHelper', 'tokenΗelper', 'token​Helper', 'tokenHelper\u0000', 'tokenHelper ', ' tokenHelper',
  'token${UNSET_IN_FUZZ?}Helper', '${UNSET_IN_FUZZ?}tokenHelper', 'tokenHelper${UNSET_IN_FUZZ?}',
  'token\\Helper', 'tokenHelper[]', '"tokenHelper"', 'tokenHelper:', ':tokenHelper',
]
const registryPart = [
  `//${HOST}/`, `//${HOST}/`, `//${HOST}`, `//${HOST}//`, `//localhost:4873/`, '//127.0.0.1:4873/sub/',
  `//${HOST}/\${UNSET_IN_FUZZ?}`, `\${UNSET_IN_FUZZ?}//${HOST}/`, `//${HOST.toUpperCase()}/`,
]
const separator = [':', ':', ':', '::', ': ', ' :', '%3A']
const keySpelling = () => `${pick(registryPart)}${pick(separator)}${pick(keyName)}`

// one line of an .npmrc, in some form ini accepts
const npmrcLine = (key, value) => pick([
  () => `${key}=${value}`,
  () => `${key} = ${value}`,
  () => `"${key}"="${value}"`,
  () => `'${key}'=${value}`,
  () => `[${key.split(':')[0]}]\n:${key.split(':').slice(1).join(':')}=${value}`,
  () => `[section]\n${key}=${value}`,
  () => `[__proto__]\n${key}=${value}`,
  () => `${key}[]=${value}`,
  () => `${key}=${value}\n${key}=${value}`,
])()
const npmrcFile = lines => {
  const body = lines.join(pick(['\n', '\r\n']))
  return `${random() < 0.2 ? '﻿' : ''}${body}\n`
}

const SOURCES = ['project', 'workspace-root', 'env', 'cli']

const makeCase = () => {
  const source = pick(SOURCES)
  const keys = Array.from({ length: 1 + Math.floor(random() * 3) }, keySpelling)
  return { source, keys, lines: keys.map(k => npmrcLine(k, helper)) }
}

// ---------- in-process oracle ----------

const setup = (c) => {
  const dir = path.join(base, 'tree')
  fs.rmSync(dir, { recursive: true, force: true })
  write(path.join(dir, 'home', '.npmrc'), c.user || '')
  write(path.join(dir, 'proj', 'package.json'), JSON.stringify({ name: 'p', workspaces: ['packages/*'] }))
  write(path.join(dir, 'proj', 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a' }))
  if (c.source === 'project' || c.source === 'workspace-root') {
    write(path.join(dir, 'proj', '.npmrc'), npmrcFile(c.lines))
  }
  const cwd = c.source === 'workspace-root' ? path.join(dir, 'proj', 'packages', 'a') : path.join(dir, 'proj')
  const env = { HOME: path.join(dir, 'home'), USERPROFILE: path.join(dir, 'home'), PATH: process.env.PATH }
  const argv = []
  if (c.source === 'env') {
    for (const key of c.keys) {
      env[`npm_config_${key}`] = helper
    }
  }
  if (c.source === 'cli') {
    for (const key of c.keys) {
      argv.push(`--${key}=${helper}`)
    }
  }
  return { dir, cwd, env, argv }
}

const inProcess = async (c) => {
  const { dir, cwd, env, argv } = setup(c)
  const config = new Config({
    npmPath: path.join(dir, 'npm'),
    definitions,
    flatten,
    nerfDarts,
    shorthands,
    argv: [process.execPath, 'npm', `--userconfig=${path.join(dir, 'home', '.npmrc')}`,
      `--globalconfig=${path.join(dir, 'home', 'global.npmrc')}`, ...argv],
    env,
    cwd,
    warn: false,
  })
  try {
    await config.load()
  } catch (er) {
    // npm refuses some configurations outright, which uses no helper either
    return { refused: er.code || er.message }
  }
  const registry = `http://${HOST}/`
  const auth = [registry, `http://${HOST}/pkg`, `http://${HOST}/pkg/-/pkg-1.0.0.tgz`]
    .map(uri => getAuth(uri, { ...config.flat, registry }).tokenHelper)
  return {
    helper: auth.find(Boolean) || config.getCredentialsByURI(registry).tokenHelper || null,
  }
}

// ---------- real npm oracle ----------

const realNpm = async (c, server, args = ['whoami']) => {
  const { cwd, env, argv, dir } = setup(c)
  fs.rmSync(marker, { force: true })
  const hook = path.join(base, 'hook.js')
  write(hook, `const M = require('module'); const r = M._resolveFilename
M._resolveFilename = function (req, ...rest) {
  return req === 'npm-registry-fetch' ? ${JSON.stringify(path.join(fetchDir, 'lib', 'index.js'))} : r.call(this, req, ...rest)
}\n`)
  await new Promise(resolve => execFile(process.execPath, [
    '-r', hook, path.join(npmCliDir, 'bin', 'npm-cli.js'), ...args,
    `--registry=http://127.0.0.1:${server.address().port}/`,
    `--userconfig=${path.join(dir, 'home', '.npmrc')}`, `--globalconfig=${path.join(dir, 'home', 'global.npmrc')}`,
    `--cache=${path.join(dir, 'cache')}`, ...argv,
  ], { cwd, env: { ...env, npm_config_update_notifier: 'false' }, timeout: 60000 }, resolve))
  return fs.existsSync(marker)
}

const main = async () => {
  const failures = []
  const counts = { cases: 0, refused: 0 }

  // the oracles must see a helper where one is allowed
  const control = { source: 'user', keys: [`//${HOST}/:tokenHelper`], lines: [], user: `//${HOST}/:tokenHelper=${helper}\n` }
  if (!(await inProcess(control)).helper) {
    failures.push('positive control: the exact key in user config was not used in-process')
  }

  for (let i = 0; i < CASES; i++) {
    const c = makeCase()
    const result = await inProcess(c)
    counts.cases++
    if (result.refused) {
      counts.refused++
    } else if (result.helper) {
      failures.push(`case ${i} uses the helper in-process: ${JSON.stringify({ source: c.source, lines: c.lines })}`)
    }
  }

  // a sample with a real npm, and publishConfig, which only publish reads
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(req.url.includes('whoami') ? { username: 'u' } : { ok: true }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const local = c => ({
    ...c,
    keys: c.keys.map(k => k.replaceAll('4873', String(port))),
    lines: c.lines.map(l => l.replaceAll('4873', String(port))),
  })
  try {
    const positive = local(control)
    positive.user = positive.user.replaceAll('4873', String(port))
    if (!(await realNpm(positive, server))) {
      failures.push('positive control: the exact key in user config did not run the helper in a real npm')
    }
    const SAMPLE = Math.min(30, CASES)
    for (let i = 0; i < SAMPLE; i++) {
      const c = local(makeCase())
      // a NUL cannot be part of an environment variable or an argument
      if ((c.source === 'env' || c.source === 'cli') && c.keys.some(k => k.includes('\u0000'))) {
        i--
        continue
      }
      if (await realNpm(c, server)) {
        failures.push(`real npm ran the helper: ${JSON.stringify({ source: c.source, lines: c.lines })}`)
      }
    }
    for (let i = 0; i < 10; i++) {
      const key = keySpelling().replaceAll('4873', String(port))
      const c = { source: 'publishConfig', keys: [key], lines: [] }
      const { dir } = setup(c)
      write(path.join(dir, 'proj', 'package.json'), JSON.stringify({
        name: 'p', version: '1.0.0', publishConfig: { [key]: helper },
      }))
      if (await realNpm(c, server, ['publish'])) {
        failures.push(`real npm publish ran the helper from publishConfig: ${JSON.stringify(key)}`)
      }
    }
    console.log(`${SAMPLE} sampled cases and 10 publishConfig spellings run with a real npm`)
  } finally {
    server.close()
    fs.rmSync(base, { recursive: true, force: true })
  }

  for (const f of failures) {
    console.log(`FAIL ${f}`)
  }
  console.log(`${counts.cases} spellings loaded in-process (${counts.refused} refused by npm), ${failures.length} failures`)
  console.log(failures.length ? 'FAIL' : 'PASS')
  process.exitCode = failures.length ? 1 : 0
}

main()
