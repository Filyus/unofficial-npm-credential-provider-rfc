'use strict'

// Platform checks for the tokenHelper prototype, meant for CI on macOS, Linux
// and Windows. It prints what the filesystem does (`info`) and fails on what
// the prototype must get right whatever the filesystem does (`ok`/`FAIL`):
// a file in the project spelled another way (letter case, Unicode form, a
// symlinked parent, a `..\x` name) is still refused as a token helper source,
// and a script whose #! interpreter is missing is reported as such.
//
//   node poc/platform-probes/run.js <npm-cli checkout> <npm-registry-fetch checkout>
//
// Both checkouts must have the prototype applied.

const fs = require('fs')
const os = require('os')
const path = require('path')

const [npmCliDir, fetchDir] = process.argv.slice(2).map(p => p && path.resolve(p))
if (!npmCliDir || !fetchDir) {
  console.error('usage: node poc/platform-probes/run.js <npm-cli checkout> <npm-registry-fetch checkout>')
  process.exit(2)
}
const Config = require(path.join(npmCliDir, 'workspaces', 'config'))
const { definitions, flatten, nerfDarts, shorthands } =
  require(path.join(npmCliDir, 'workspaces', 'config', 'lib', 'definitions'))
const getTokenHelperHeader = require(path.join(fetchDir, 'lib', 'token-helper.js'))

const WIN = process.platform === 'win32'
const KEY = '//reg.example/:tokenHelper'
const results = []
const info = (what, value) => results.push({ kind: 'info', what, value })
const check = (what, ok, detail = '') => results.push({ kind: ok ? 'ok' : 'FAIL', what, value: detail })

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-token-helper-probes-'))
const write = (p, content) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

// ---------- what this filesystem does ----------

const caseProbe = path.join(root, 'CaseProbe')
write(caseProbe, '')
const caseInsensitive = fs.existsSync(path.join(root, 'caseprobe'))
info('filesystem is case-insensitive', caseInsensitive)
if (caseInsensitive) {
  info('realpath of a case variant returns', path.basename(fs.realpathSync.native(path.join(root, 'CASEPROBE'))))
}

const nfc = 'café'
const nfd = 'café'
fs.mkdirSync(path.join(root, nfc))
const nfdReachesNfc = fs.existsSync(path.join(root, nfd))
info('an NFD spelling reaches a directory created as NFC', nfdReachesNfc)
info('readdir returns the name as', fs.readdirSync(root).includes(nfc) ? 'NFC' : 'NFD')
if (nfdReachesNfc) {
  const real = path.basename(fs.realpathSync.native(path.join(root, nfd)))
  info('realpath of the NFD spelling returns', real === nfc ? 'NFC' : real === nfd ? 'NFD' : real)
}

const tmpReal = fs.realpathSync.native(os.tmpdir())
info('os.tmpdir() is reached through a link', tmpReal !== os.tmpdir() ? `${os.tmpdir()} -> ${tmpReal}` : false)
const stat = p => fs.statSync(p, { bigint: true })
info('dev:ino agree through the link', `${stat(root).ino === stat(fs.realpathSync.native(root)).ino}` +
  ` (ino ${stat(root).ino ? 'nonzero' : 'zero'})`)

// ---------- the trust rule ----------

// a project with a helper file in it; home elsewhere. Each case names the
// project's file another way and must still be refused.
const load = async (userconfig, cwd) => {
  const config = new Config({
    npmPath: path.join(root, 'npm'),
    definitions,
    flatten,
    nerfDarts,
    shorthands,
    argv: [process.execPath, 'npm', `--userconfig=${userconfig}`, `--globalconfig=${path.join(root, 'home', 'g.npmrc')}`],
    env: { HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), PATH: process.env.PATH },
    cwd,
    warn: false,
  })
  await config.load()
  return config.get(KEY)
}

const trust = async () => {
  const helperLine = `${KEY}=${path.join(root, 'helper')}\n`
  write(path.join(root, 'home', '.npmrc'), '')
  write(path.join(root, 'home', 'g.npmrc'), '')
  write(path.join(root, 'outside.npmrc'), helperLine)

  const project = path.join(root, 'Project-café')
  write(path.join(project, 'package.json'), '{}')
  write(path.join(project, 'ci.npmrc'), helperLine)

  check('control: a file outside the project is trusted',
    await load(path.join(root, 'outside.npmrc'), project) !== undefined)
  check('control: the project file spelled as created is refused',
    await load(path.join(project, 'ci.npmrc'), project) === undefined)

  if (caseInsensitive) {
    const upper = path.join(root, path.basename(project).toUpperCase(), 'CI.NPMRC')
    check('the project file in another letter case is refused', await load(upper, project) === undefined, upper)
    const cwdUpper = path.join(root, path.basename(project).toUpperCase())
    check('the project file seen from a cwd in another letter case is refused',
      await load(path.join(project, 'ci.npmrc'), cwdUpper) === undefined)
  }
  if (nfdReachesNfc) {
    const nfdFile = path.join(root, 'Project-café', 'ci.npmrc')
    check('the project file through an NFD spelling is refused', await load(nfdFile, project) === undefined)
  }
  if (tmpReal !== os.tmpdir()) {
    const viaReal = path.join(fs.realpathSync.native(project), 'ci.npmrc')
    check('the project file through the resolved temp path is refused', await load(viaReal, project) === undefined, viaReal)
  }
  if (!WIN) {
    write(path.join(project, '..\\evil', 'npmrc'), helperLine)
    check('a project directory named ..\\evil is still the project',
      await load(path.join(project, '..\\evil', 'npmrc'), project) === undefined)
    // a link in the checkout to a file in the checkout
    fs.symlinkSync(path.join(project, 'ci.npmrc'), path.join(root, 'link.npmrc'))
    check('a link outside the project to the project file is refused',
      await load(path.join(root, 'link.npmrc'), project) === undefined)
  }
}

// ---------- the helper runtime ----------

const runtime = async () => {
  if (WIN) {
    return
  }
  const script = (name, content) => {
    const p = path.join(root, 'helpers', name)
    write(p, content)
    fs.chmodSync(p, 0o755)
    return p
  }
  const outcome = p => getTokenHelperHeader(p, `//${path.basename(p)}/`, 10000)
    .then(h => `header ${h.split(' ')[0]} …`, e => e.message.replace(p, '<helper>'))

  const good = script('good', '#!/bin/sh\necho tok-good\n')
  check('a shebang script helper works', (await outcome(good)) === 'header Bearer …', await outcome(good))

  const missing = script('missing', '#!/no/such/interpreter\necho tok\n')
  const m = await outcome(missing)
  check('a missing #! interpreter is named', m.includes('its interpreter "/no/such/interpreter" was not found'), m)

  const crlf = script('crlf', '#!/bin/sh\r\necho tok\r\n')
  const c = await outcome(crlf)
  check('a #! line with a carriage return is explained', c.includes('carriage return'), c)

  info('a script without a #! line', await outcome(script('noshebang', 'echo tok-noshebang\n')))

  if (process.platform === 'darwin') {
    const brewNode = fs.existsSync('/opt/homebrew/bin/node')
    info('node at /opt/homebrew/bin/node', brewNode)
    info('a #!/usr/local/bin/node script', await outcome(script('usrlocalnode', '#!/usr/local/bin/node\nconsole.log("tok")\n')))
  }
}

const main = async () => {
  try {
    await trust()
    await runtime()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  console.log(`platform: ${process.platform} ${os.release()} node ${process.version}`)
  for (const r of results) {
    console.log(`${r.kind.padEnd(4)} ${r.what}${r.value === '' ? '' : `: ${r.value}`}`)
  }
  const failed = results.filter(r => r.kind === 'FAIL').length
  console.log(failed ? `FAIL (${failed})` : 'PASS')
  process.exitCode = failed ? 1 : 0
}

main()
