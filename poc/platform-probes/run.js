'use strict'

// Platform checks for the Phase 1a tokenHelper runner, meant for CI on macOS,
// Linux and Windows. It prints what the platform does (`info`) and fails on
// what the runner must get right whatever the platform does (`ok`/`FAIL`):
// helper paths that Win32 would read as another file (a trailing space or dot,
// a slash after the name, `\\?\`, a UNC share, letter case, an 8.3 name) run
// the file they name or run nothing, a .cmd in a directory with a name cmd.exe
// gives a meaning to runs as itself, in its own directory, a directory longer
// than 258 characters is refused with a reason, and a script whose #! interpreter is missing is reported as such.
//
//   node poc/platform-probes/run.js <npm-cli checkout>
//
// The checkout must have the prototype applied. PROBE_ROOT names the
// directory the probes work in (default: the temp directory), so that they can
// run on another volume: an SMB share on Windows, where a helper is a UNC path.

const fs = require('fs')
const os = require('os')
const path = require('path')

const [npmCliDir] = process.argv.slice(2).map(p => p && path.resolve(p))
if (!npmCliDir) {
  console.error('usage: node poc/platform-probes/run.js <npm-cli checkout>')
  process.exit(2)
}
const runner = require(path.join(npmCliDir, 'lib', 'utils', 'token-helper.js'))

// the factory npm uses, with a stub config, for one helper; a fresh one for
// each call, so that nothing is cached
const getTokenHelperHeader = (helper, regKey, timeout = 15000) => runner(
  { flat: { tokenHelpers: { [regKey]: helper } }, get: () => undefined, credentialKeysFromCliOrEnv: () => [], tokenHelperProjectTransport: [] },
  {}, process.platform, { timeout, grace: 2000, drain: 250 })({ regKey })

const WIN = process.platform === 'win32'
const results = []
const info = (what, value) => results.push({ kind: 'info', what, value })
const check = (what, ok, detail = '') => results.push({ kind: ok ? 'ok' : 'FAIL', what, value: detail })

const base = process.env.PROBE_ROOT ? path.resolve(process.env.PROBE_ROOT) : os.tmpdir()
fs.mkdirSync(base, { recursive: true })
const root = fs.mkdtempSync(path.join(base, 'npm-token-helper-probes-'))
const UNC = root.startsWith('\\\\')
const write = (p, content) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

info('probes run in', process.env.PROBE_ROOT ? `PROBE_ROOT ${base}` : `the temp directory ${base}`)

// ---------- the helper runtime ----------

// the 8.3 spelling of an existing path, from cmd.exe's %~s modifier
const shortName = (file) => {
  const out = require('child_process').spawnSync(process.env.ComSpec || 'cmd.exe',
    ['/d', '/c', 'for', '%I', 'in', `("${file}")`, 'do', '@echo', '%~sI'], { encoding: 'utf8', windowsVerbatimArguments: true, cwd: path.dirname(file) })
  const line = (out.stdout || '').trim()
  return out.status === 0 && line && line.toLowerCase() !== file.toLowerCase() ? line : null
}

// A helper path that Win32 would read as another file: a trailing space or
// dot is dropped, a slash after a file name is a directory, `\\?\` turns every
// normalization off, and a space is where arguments start. Each helper prints
// a token of its own and appends it to a log, so what ran is known even when
// the prototype reports a failure. The prototype either refuses the value or
// runs exactly the file it names; running another file (the decoy that the
// normalized spelling reaches) is the failure. What it does is recorded as info.
// a UNC path \\host\share\x is spelled \\?\UNC\host\share\x
const verbatim = p => p.startsWith('\\\\') ? `\\\\?\\UNC\\${p.slice(2)}` : `\\\\?\\${p}`
const created = []
const spellings = async (short) => {
  let n = 0
  // files: [name, token] under one directory; value: the helper path given;
  // names: the tokens of the files the value names (none: it must not run)
  const probe = async (label, files, value, names) => {
    const dir = path.join(root, 'spellings', String(++n))
    const log = path.join(dir, 'ran.log')
    for (const [name, token] of files) {
      const file = verbatim(path.join(dir, name))
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, `@echo off\r\necho ${token}>>"${log}"\r\necho ${token}\r\n`)
      created.push(file)
    }
    const given = value(dir)
    const outcome = await getTokenHelperHeader(given, `//spelling/${n}/`, 15000).then(h => `header ${h}`, e => `refused: ${short(e.message)}`)
    const ran = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean) : []
    info(label, `${short(JSON.stringify(given))} -> ${outcome}; ran ${ran.length ? ran.join(', ') : 'nothing'}`)
    const wrong = ran.filter(token => !names.includes(token))
    check(label, !wrong.length && (!outcome.startsWith('header ') || names.includes(outcome.split(' ').pop())),
      `${wrong.length ? `ran ${wrong.join(', ')}` : names.length || !ran.length ? 'refused or ran what it names' : 'ran'}`)
  }
  const decoy = [['helper.cmd', 'tok-decoy']]
  const both = (extra) => [...decoy, [extra, 'tok-named']]

  await probe('a .cmd helper in a directory with a space in its name is refused or runs that file',
    [['with space\\helper.cmd', 'tok-named']], d => path.join(d, 'with space', 'helper.cmd'), ['tok-named'])
  await probe('a .bat helper in a directory with a space in its name is refused or runs that file',
    [['with space\\helper.bat', 'tok-named']], d => path.join(d, 'with space', 'helper.bat'), ['tok-named'])
  await probe('a file followed by an argument is refused and nothing runs',
    [['helper.cmd', 'tok-decoy']], d => `${path.join(d, 'helper.cmd')} --arg`, [])
  await probe('a helper path with a trailing space, where only the file without it exists, is refused or runs nothing else',
    decoy, d => `${path.join(d, 'helper.cmd')} `, [])
  await probe('a helper path with a trailing dot, where only the file without it exists, is refused or runs nothing else',
    decoy, d => `${path.join(d, 'helper.cmd')}.`, [])
  await probe('a helper path with a trailing space, where a file with that name exists beside the decoy, is refused or runs the file it names',
    both('helper.cmd '), d => `${path.join(d, 'helper.cmd')} `, ['tok-named'])
  await probe('a helper path with a trailing dot, where a file with that name exists beside the decoy, is refused or runs the file it names',
    both('helper.cmd.'), d => `${path.join(d, 'helper.cmd')}.`, ['tok-named'])
  await probe('a helper path with a backslash after the file name is refused or runs nothing',
    decoy, d => `${path.join(d, 'helper.cmd')}\\`, [])
  await probe('a helper path with a slash after the file name is refused or runs nothing',
    decoy, d => `${path.join(d, 'helper.cmd')}/`, [])
  await probe('a helper path with a trailing space and a slash is refused or runs nothing',
    decoy, d => `${path.join(d, 'helper.cmd')} /`, [])
  await probe('a \\\\?\\ verbatim helper path is refused or runs that file',
    [['helper.cmd', 'tok-named']], d => verbatim(path.join(d, 'helper.cmd')), ['tok-named'])
  await probe('a \\\\?\\ verbatim helper path with a trailing space is refused or runs the file it names',
    both('helper.cmd '), d => `${verbatim(path.join(d, 'helper.cmd'))} `, ['tok-named'])
  await probe('a \\\\?\\ verbatim helper path with a trailing dot is refused or runs the file it names',
    both('helper.cmd.'), d => `${verbatim(path.join(d, 'helper.cmd'))}.`, ['tok-named'])
  await probe('a helper path with forward slashes is refused or runs that file',
    [['helper.cmd', 'tok-named']], d => path.join(d, 'helper.cmd').replace(/\\/g, '/'), ['tok-named'])
  await probe('a helper path in another letter case is refused or runs that file',
    [['helper.cmd', 'tok-named']], d => path.join(d, 'HELPER.CMD'), ['tok-named'])
  await probe('a helper path through an 8.3 short directory name is refused or runs that file',
    [['a long directory name\\helper.cmd', 'tok-named']], d => {
      const short8 = shortName(path.join(d, 'a long directory name'))
      return short8 ? path.join(short8, 'helper.cmd') : path.join(d, 'a long directory name', 'helper.cmd')
    }, ['tok-named'])
  for (const file of created) {
    try {
      fs.rmSync(file, { force: true })
    } catch (er) {
      info('could not remove', `${short(file)}: ${er.code}`)
    }
  }
}

// .cmd helpers go through cmd.exe, which gives meaning to & ^ ! ; ( ) and
// more: in a directory name each must reach the helper unchanged, start it in
// that directory, and run nothing else
const windows = async () => {
  const short = s => s.split(JSON.stringify(root).slice(1, -1)).join('<root>').split(root).join('<root>')
  const names = ['plain', 'with space', 'amp&ersand', 'caret^here', 'semi;colon', 'paren(x86)',
    'Program Files (x86)', "apostrophe's", 'comma,equals=', 'bang!here', 'café папка 目录',
    'x&mkdir injected-marker&x', 'x^&mkdir injected-marker', 'x"&mkdir injected-marker&"x']
  for (const name of names) {
    const dir = path.join(root, 'cmd-helpers', name)
    let helper
    try {
      helper = path.join(dir, 'helper.cmd')
      write(helper, `@echo off\r\nnode -e "require('fs').writeFileSync(require('path').join(process.cwd(), 'cwd.txt'), process.cwd())"\r\necho tok-cmd\r\n`)
    } catch (er) {
      // a name Windows does not allow at all (")
      info(`a .cmd helper in "${name}"`, `not creatable: ${er.code}`)
      continue
    }
    const header = await getTokenHelperHeader(helper, `//cmd/${name}/`, 15000).then(h => h, e => e.message)
    const cwd = fs.existsSync(path.join(dir, 'cwd.txt')) ? fs.readFileSync(path.join(dir, 'cwd.txt'), 'utf8') : null
    const injected = [root, dir, path.dirname(dir), process.cwd()].some(d => fs.existsSync(path.join(d, 'injected-marker')))
    // cmd.exe cannot start in a UNC directory and falls back to the Windows
    // directory, so on a share only the run is required, and the directory is
    // recorded
    if (UNC) {
      info(`a .cmd helper in "${name}" started in`, cwd === dir ? 'its own directory' : cwd)
    }
    check(`a .cmd helper in "${name}" runs as itself, in its own directory`,
      header === 'Bearer tok-cmd' && (UNC || cwd === dir) && !injected, `${header}; cwd ${cwd === dir ? 'ok' : cwd}`)
  }
  // refused before anything is looked up, so the paths need not exist
  const refusedAt = (helper) => getTokenHelperHeader(helper, '//refused/', 15000).then(h => `header ${h}`, e => e.message)
  const longDir = await refusedAt(`C:\\${'d'.repeat(260)}\\helper.cmd`)
  check('a helper in a directory longer than 258 characters is refused with a reason',
    longDir.includes('longer than 258 characters') && longDir.includes('shorter path'), longDir.slice(0, 60))
  const ps1 = path.join(root, 'ps1', 'helper.ps1')
  write(ps1, 'Write-Output tok\r\n')
  const ps1Outcome = await refusedAt(ps1)
  check('a .ps1 helper is refused and a .cmd wrapper suggested', ps1Outcome.includes('.cmd wrapper'), short(ps1Outcome))
  const js = path.join(root, 'js', 'helper.js')
  write(js, 'console.log("tok")\n')
  check('a .js helper is refused and a .cmd wrapper suggested', (await refusedAt(js)).includes('.cmd wrapper'))
  await spellings(short)
}

const runtime = async () => {
  if (WIN) {
    return windows()
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

  const noShebang = await outcome(script('noshebang', 'echo tok-noshebang\n'))
  info('a script without a #! line', noShebang)
  if (process.platform === 'darwin') {
    check('on macOS a script without a #! line fails with ENOEXEC', noShebang.includes('ENOEXEC'), noShebang)
  }
  if (process.platform === 'linux') {
    check('on Linux a script without a #! line runs through /bin/sh', noShebang === 'header Bearer …', noShebang)
  }

  if (process.platform === 'darwin') {
    const brewNode = fs.existsSync('/opt/homebrew/bin/node')
    info('node at /opt/homebrew/bin/node', brewNode)
    info('a #!/usr/local/bin/node script', await outcome(script('usrlocalnode', '#!/usr/local/bin/node\nconsole.log("tok")\n')))
  }
}

const main = async () => {
  try {
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
