'use strict'
// Fuzzer for the tokenHelper trust rule in @npmcli/config (read-only use of the checkout).
//
//   NPM_CLI=<npm-cli checkout> FUZZ_DIR=<scratch dir> node poc/npm-config-fuzz/fuzz.js <cases> <seed> [replay.json]
//
// Written in the seventh audit round, where it found the location=global,
// nested-project, home-project, spelling and '..' cases. The oracle encodes
// the intended rule: a helper is in effect only from a file that no project
// setting chose (unless it is a default file) and that lies inside no project
// other than the home directory. Shrunk failures go to FUZZ_DIR as
// min-<category>.json and can be replayed. What it still reports at seed
// 31337 is on the safe side (LOST: refused where the oracle's simpler model
// would trust) plus one EFFECT case where npm loads ~/.npmrc as both project
// and user config because HOME is spelled with an 8.3 name: the file is the
// user's own, so trusting it is right.
//
// NPM_CLI defaults to a checkout named npm-cli next to this repository's
// directory (<repo>/../npm-cli). The 8.3 short-name cases need cmd.exe: on
// Linux and macOS they are not generated, and the run says so once at start.
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const NPMCLI = path.resolve(process.env.NPM_CLI || path.join(__dirname, '..', '..', '..', 'npm-cli'))
const OUT = path.resolve(process.env.FUZZ_DIR || require('os').tmpdir(), 'npm-config-fuzz')
fs.mkdirSync(OUT, { recursive: true })
const Config = require(path.join(NPMCLI, 'workspaces', 'config'))
const { definitions, flatten, nerfDarts, shorthands } =
  require(path.join(NPMCLI, 'workspaces', 'config', 'lib', 'definitions'))

const ROOT = path.join(OUT, 'tree')
const T = (...a) => path.join(ROOT, ...a)
const KEY = '//r.test/:tokenHelper'

// ---------- fixed tree ----------
const DIRS = {
  home: T('home-directory'),
  homesub: T('home-directory', 'subdirectory'),
  homeproj: T('home-directory', 'project-in-home'),
  repo: T('repository-long'),
  repohome: T('repository-long', 'home-inside-repo'),
  client: T('repository-long', 'client-package'),
  alpha: T('repository-long', 'packages', 'alpha-package'),
  alphadeep: T('repository-long', 'packages', 'alpha-package', 'deep-directory'),
  nested: T('repository-long', 'subdirectory', 'nested-project'),
  nesteddeep: T('repository-long', 'subdirectory', 'nested-project', 'deep-directory'),
  outside: T('outside-place'),
  plain: T('outside-place', 'plain-directory'),
  nodedir: T('nodejs-directory'),
  npmpath: T('npm-path-directory'),
}
// candidate npmrc files (any may become user/global/builtin/project)
const FILES = {
  homeUser: T('home-directory', '.npmrc'),
  homeXdg: T('home-directory', '.config', 'npm', 'npmrc'),
  homeAppdataGlobal: T('home-directory', 'AppData', 'Roaming', 'npm', 'etc', 'npmrc'),
  homeNpmGlobal: T('home-directory', '.npm-global', 'etc', 'npmrc'),
  homeProjRc: T('home-directory', 'project-in-home', '.npmrc'),
  homesubRc: T('home-directory', 'subdirectory', '.npmrc'),
  repoRc: T('repository-long', '.npmrc'),
  repoCi: T('repository-long', 'ci.npmrc'),
  repoDotdot: T('repository-long', '..ci.npmrc'),
  repoEtc: T('repository-long', 'etc', 'npmrc'),
  repohomeRc: T('repository-long', 'home-inside-repo', '.npmrc'),
  clientRc: T('repository-long', 'client-package', '.npmrc'),
  clientEtc: T('repository-long', 'client-package', 'etc', 'npmrc'),
  alphaRc: T('repository-long', 'packages', 'alpha-package', '.npmrc'),
  alphaEtc: T('repository-long', 'packages', 'alpha-package', 'etc', 'npmrc'),
  nestedRc: T('repository-long', 'subdirectory', 'nested-project', '.npmrc'),
  nestedEtc: T('repository-long', 'subdirectory', 'nested-project', 'etc', 'npmrc'),
  subCi: T('repository-long', 'subdirectory', 'ci.npmrc'),
  outU: T('outside-place', 'user.npmrc'),
  outG: T('outside-place', 'global.npmrc'),
  outPreEtc: T('outside-place', 'prefix-directory', 'etc', 'npmrc'),
  nodeEtc: T('nodejs-directory', 'etc', 'npmrc'),
  builtin: T('npm-path-directory', 'npmrc'),
}
const PREFIXES = {
  outPre: T('outside-place', 'prefix-directory'),
  homeAppdata: T('home-directory', 'AppData', 'Roaming', 'npm'),
  homeNpmGlobal: T('home-directory', '.npm-global'),
  repo: DIRS.repo,
  client: DIRS.client,
  alpha: DIRS.alpha,
  nested: DIRS.nested,
  nodedir: DIRS.nodedir,
}
const MARKERS = {
  homePkg: T('home-directory', 'package.json'),
  homeNm: T('home-directory', 'node_modules'),
  repoPkg: T('repository-long', 'package.json'),
  repoNm: T('repository-long', 'node_modules'),
  clientPkg: T('repository-long', 'client-package', 'package.json'),
  alphaPkg: T('repository-long', 'packages', 'alpha-package', 'package.json'),
  nestedPkg: T('repository-long', 'subdirectory', 'nested-project', 'package.json'),
  homeprojPkg: T('home-directory', 'project-in-home', 'package.json'),
  repohomePkg: T('repository-long', 'home-inside-repo', 'package.json'),
}

const write = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c) }
const setup = () => {
  for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true })
  for (const d of Object.values(PREFIXES)) fs.mkdirSync(path.join(d, 'etc'), { recursive: true })
  for (const f of Object.values(FILES)) fs.mkdirSync(path.dirname(f), { recursive: true })
  write(path.join(DIRS.npmpath, 'package.json'), '{"version":"12.0.0"}')
}
setup()

// 8.3 short names, computed once
const SHORT = new Map()
const shortOf = p => {
  if (SHORT.has(p)) return SHORT.get(p)
  let s = null
  if (process.platform !== 'win32') return s
  try {
    s = execSync(`cmd /c for %I in ("${p}") do @echo %~sI`, { encoding: 'utf8' }).trim()
  } catch {}
  SHORT.set(p, s)
  return s
}
if (process.platform !== 'win32') console.log('not Windows: the 8.3 short-name cases are skipped')
for (const d of Object.values(DIRS)) shortOf(d)
for (const d of Object.values(PREFIXES)) shortOf(d)

// ---------- rng ----------
let seed = 1
const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = a => a[Math.floor(rnd() * a.length)]
const chance = p => rnd() < p

// ---------- spellings ----------
const randCase = s => s.split('').map(ch => chance(0.5) ? ch.toUpperCase() : ch.toLowerCase()).join('')
const spell = (abs, cwd, { dir = false, kind } = {}) => {
  const k = kind || pick(['abs', 'abs', 'fwd', 'case', 'rel', 'reldot', 'drive', 'short', 'unc', 'tilde', 'trail', 'envvar'])
  const home = DIRS.home
  switch (k) {
    case 'abs': return { k, v: abs }
    case 'fwd': return { k, v: abs.replace(/\\/g, '/') }
    case 'case': return { k, v: randCase(abs) }
    case 'rel': return { k, v: path.relative(cwd, abs) || '.' }
    case 'reldot': { const r = path.relative(cwd, abs); return { k, v: r.startsWith('..') ? r : '.\\' + r } }
    case 'drive': return { k, v: 'C:' + (path.relative(cwd, abs) || '.') }
    case 'short': {
      // shorten the deepest existing ancestor dir
      let d = dir ? abs : path.dirname(abs); let rest = dir ? '' : path.basename(abs)
      while (d.length > ROOT.length) {
        const s = shortOf(d)
        if (s && s.toLowerCase() !== d.toLowerCase()) return { k, v: path.join(s, rest) }
        rest = path.join(path.basename(d), rest); d = path.dirname(d)
      }
      return { k: 'abs', v: abs }
    }
    case 'unc': return { k, v: '\\\\?\\' + abs }
    case 'tilde': {
      const r = path.relative(home, abs)
      if (!r.startsWith('..') && !path.isAbsolute(r)) return { k, v: '~/' + r.replace(/\\/g, '/') }
      return { k: 'abs', v: abs }
    }
    case 'trail': return { k, v: abs + (dir ? pick(['\\', '/', '\\\\']) : '') }
    case 'envvar': return { k, v: '${FUZZ_BASE}' + abs.slice(ROOT.length) }
  }
}

const fileIds = Object.keys(FILES)
const cwdIds = ['repo', 'alpha', 'alphadeep', 'nested', 'nesteddeep', 'client', 'home', 'homesub', 'homeproj', 'plain', 'repohome']
const homeIds = ['home', 'home', 'home', 'repo', 'repohome', 'plain']

// ---------- generator ----------
const gen = () => {
  const c = {
    cwd: pick(cwdIds),
    home: pick(homeIds),
    homeKind: pick(['abs', 'abs', 'fwd', 'case', 'short', 'trail']),
    markers: {},
    repoWs: chance(0.5),
    lines: {}, // file id -> array of [key, target-type, target-id, spellkind]
    cli: [], // [key, type, id, kind] or ['-g'] etc
    env: [], // [nameCase, key, type, id, kind]
    envPrefix: null,
  }
  for (const m of Object.keys(MARKERS)) c.markers[m] = chance(m === 'repoPkg' ? 0.9 : m.startsWith('home') && m !== 'homeprojPkg' ? 0.3 : 0.7)
  const setting = (allowed) => {
    const key = pick(allowed)
    if (key === 'prefix') return [key, 'P', pick(Object.keys(PREFIXES)), null]
    if (key === 'global') return [key, 'V', pick(['true', 'false']), null]
    if (key === 'location') return [key, 'V', pick(['global', 'user', 'project']), null]
    return [key, 'F', pick(fileIds), null]
  }
  for (const f of fileIds) {
    const n = Math.floor(rnd() * 3)
    const arr = []
    const allowed = f === 'builtin' ? ['prefix', 'globalconfig', 'userconfig'] : ['prefix', 'globalconfig', 'userconfig', 'global', 'location']
    for (let i = 0; i < n; i++) arr.push(setting(allowed))
    c.lines[f] = arr
  }
  const nc = Math.floor(rnd() * 3)
  for (let i = 0; i < nc; i++) c.cli.push(setting(['prefix', 'globalconfig', 'userconfig', 'global', 'location']))
  const ne = Math.floor(rnd() * 3)
  for (let i = 0; i < ne; i++) c.env.push([pick(['lower', 'upper', 'mixed']), ...setting(['prefix', 'globalconfig', 'userconfig', 'global', 'location'])])
  if (chance(0.1)) c.envPrefix = pick(Object.keys(PREFIXES))
  // spell kinds decided at generation
  const KINDS = ['abs', 'abs', 'fwd', 'case', 'rel', 'reldot', 'drive', 'short', 'unc', 'tilde', 'trail', 'envvar']
  for (const s of [...Object.values(c.lines).flat(), ...c.cli]) if (s[1] !== 'V') s[3] = pick(KINDS)
  for (const e of c.env) if (e[2] !== 'V') e[4] = pick(KINDS)
  return c
}

const target = (type, id) => type === 'P' ? PREFIXES[id] : FILES[id]
const nameCase = (nc, key) => {
  const n = 'npm_config_' + key
  return nc === 'upper' ? n.toUpperCase() : nc === 'mixed' ? 'Npm_Config_' + key.toUpperCase() : n
}

// ---------- materialize and run ----------
const materialize = (c, cwd, strip) => {
  for (const [m, p] of Object.entries(MARKERS)) {
    const on = c.markers[m]
    if (m.endsWith('Nm')) {
      if (on) fs.mkdirSync(p, { recursive: true }); else fs.rmSync(p, { recursive: true, force: true })
    } else if (on) {
      write(p, m === 'repoPkg' && c.repoWs ? '{"name":"r","workspaces":["packages/*"]}' : '{"name":"x"}')
    } else fs.rmSync(p, { force: true })
  }
  for (const f of fileIds) {
    let body = f === 'builtin' ? '' : `${KEY}=H_${f}\n`
    for (const s of c.lines[f]) {
      if (strip && strip.has(f) && ['prefix', 'globalconfig', 'userconfig'].includes(s[0])) continue
      const v = s[1] === 'V' ? s[2] : spell(target(s[1], s[2]), cwd, { dir: s[1] === 'P', kind: s[3] }).v
      body += `${s[0]}=${v.replace(/\\/g, '\\\\')}\n`
    }
    write(FILES[f], body)
  }
}

const runOnce = async (c, strip) => {
  const cwd = DIRS[c.cwd]
  materialize(c, cwd, strip)
  process.chdir(cwd)
  const homeAbs = DIRS[c.home]
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, FUZZ_BASE: ROOT }
  env.HOME = spell(homeAbs, cwd, { dir: true, kind: c.homeKind }).v
  if (c.envPrefix) env.PREFIX = PREFIXES[c.envPrefix]
  for (const [ncase, key, type, id, kind] of c.env) {
    env[nameCase(ncase, key)] = type === 'V' ? id : spell(target(type, id), cwd, { dir: type === 'P', kind }).v
  }
  const argv = [process.execPath, 'npm']
  for (const [key, type, id, kind] of c.cli) {
    if (key === 'global') { if (id === 'true') argv.push('-g'); continue }
    argv.push(`--${key}=${type === 'V' ? id : spell(target(type, id), cwd, { dir: type === 'P', kind }).v}`)
  }
  const config = new Config({
    npmPath: DIRS.npmpath, definitions, flatten, nerfDarts, shorthands, argv, env, cwd,
    execPath: path.join(DIRS.nodedir, 'node.exe'), platform: 'win32', warn: false,
  })
  try {
    await config.load()
  } catch (e) {
    return { error: e.message }
  }
  const src = w => config.data.get(w).source
  const has = w => Object.hasOwn(config.data.get(w).data, KEY)
  return {
    env, argv: argv.slice(2), config,
    userFile: src('user'), globalFile: src('global'), projectFile: src('project'),
    userHelper: has('user'), globalHelper: has('global'),
    localPrefix: config.localPrefix, home: config.home,
    global: ['cli', 'env', 'builtin', ...(config.data.get('user').source && Object.keys(config.data.get('user').data).length ? ['user'] : [])].some(w => config.get('global', w) === true || config.get('location', w) === 'global'),
    cliGlobal: !!(config.get('global', 'cli') || config.get('location', 'cli') === 'global'),
    cliPrefix: config.get('prefix', 'cli'),
    defaultPrefix: config.get('prefix', 'default'),
  }
}

// canonical path of an existing or not-yet-existing file
const canon = p => {
  if (!p) return null
  let s = p
  try { s = fs.realpathSync.native(p) } catch {
    try { s = path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p)) } catch { s = path.resolve(p) }
  }
  return s.replace(/^\\\\\?\\/, '').toLowerCase()
}
const insideDir = (f, d) => { const cf = canon(f); const cd = canon(d); return cf !== cd && cf.startsWith(cd + '\\') }

const fileIdOf = p => { const c = canon(p); return fileIds.find(f => canon(FILES[f]) === c) || p }

const check = async (c) => {
  const r = await runOnce(c)
  if (r.error) return { skip: r.error }
  // counterfactual: the project file loaded, without its selecting keys
  const projId = r.projectFile && fileIds.find(f => canon(FILES[f]) === canon(r.projectFile))
  let cf = r
  if (projId && c.lines[projId].some(s => ['prefix', 'globalconfig', 'userconfig'].includes(s[0]))) {
    cf = await runOnce(c, new Set([projId]))
    if (cf.error) return { skip: 'cf:' + cf.error }
  }
  const sameAsProject = f => projId && canon(f) === canon(FILES[projId])
  // projects: ancestors of cwd holding package.json or node_modules
  const projects = []
  for (let d = DIRS[c.cwd]; d.length >= ROOT.length; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'package.json')) || fs.existsSync(path.join(d, 'node_modules'))) projects.push(d)
  }
  const cliPrefixProject = r.cliPrefix && !r.global
  if (cliPrefixProject) projects.push(r.cliPrefix)
  const homeAbs = DIRS[c.home]
  const homeLike = d => canon(d) === canon(homeAbs)
  const defaults = [path.join(homeAbs, '.npmrc'), path.join(r.defaultPrefix, 'etc', 'npmrc')].map(canon)
  const out = []
  for (const [where, file, cfFile, helper] of [['user', r.userFile, cf.userFile, r.userHelper], ['global', r.globalFile, cf.globalFile, r.globalHelper]]) {
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory() || canon(file) === canon(FILES.builtin)) continue
    if (where === 'user' && sameAsProject(file)) continue
    const controlled = canon(file) !== canon(cfFile)
    const isDefault = defaults.includes(canon(file))
    const insideAny = projects.filter(p => insideDir(file, p))
    const strictBad = (controlled && !isDefault) || (insideAny.filter(p => !homeLike(p)).length && !isDefault)
    const lenientInside = insideAny.filter(p => !homeLike(p))
    const expectTrusted = (!controlled || isDefault) && (!lenientInside.length || isDefault)
    if (helper && strictBad) {
      let sub = 'controlled'
      if (!controlled) {
        const lp = r.localPrefix
        if (!insideDir(file, lp)) sub = 'outer'
        else {
          const rel = path.relative(path.resolve(lp).toLowerCase(), path.resolve(file).toLowerCase())
          const plainInside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
          sub = !plainInside ? (rel.startsWith('..') && !rel.startsWith('..' + path.sep) ? 'dotdot' : 'spelling') : 'notproject'
        }
      }
      out.push({ cat: `EFFECT-${where}-${sub}`, where, file: fileIdOf(file), projects: insideAny.map(p => path.relative(ROOT, p)) })
    }
    if (!helper && expectTrusted) {
      out.push({ cat: `LOST-${where}${insideAny.length ? '-homeproject' : ''}`, where, file: fileIdOf(file), projects: insideAny.map(p => path.relative(ROOT, p)) })
    }
  }
  return { out, r }
}

// ---------- shrinking ----------
const clone = o => JSON.parse(JSON.stringify(o))
const shrink = async (c, cat) => {
  const fails = async x => { const res = await check(x); return res.out && res.out.some(o => o.cat === cat) }
  let cur = clone(c)
  let progress = true
  while (progress) {
    progress = false
    const cands = []
    for (const f of fileIds) cur.lines[f].forEach((_, i) => cands.push(x => x.lines[f].splice(i, 1)))
    cur.cli.forEach((_, i) => cands.push(x => x.cli.splice(i, 1)))
    cur.env.forEach((_, i) => cands.push(x => x.env.splice(i, 1)))
    if (cur.envPrefix) cands.push(x => { x.envPrefix = null })
    for (const m of Object.keys(MARKERS)) if (cur.markers[m]) cands.push(x => { x.markers[m] = false })
    if (cur.repoWs) cands.push(x => { x.repoWs = false })
    if (cur.homeKind !== 'abs') cands.push(x => { x.homeKind = 'abs' })
    const allSpells = x => [...Object.values(x.lines).flat(), ...x.cli, ...x.env.map(e => e)]
    allSpells(cur).forEach((s, i) => { if (s[s.length - 1] && s[s.length - 1] !== 'abs' && s[1] !== 'V' && s[2] !== 'V') cands.push(x => { const t = allSpells(x)[i]; t[t.length - 1] = 'abs' }) })
    for (const cand of cands) {
      const x = clone(cur); cand(x)
      if (await fails(x)) { cur = x; progress = true; break }
    }
  }
  return cur
}

const describe = (c) => {
  const lines = []
  lines.push(`cwd=${path.relative(ROOT, DIRS[c.cwd])} HOME=${path.relative(ROOT, DIRS[c.home])}(${c.homeKind}) ws=${c.repoWs}`)
  lines.push('markers: ' + Object.entries(c.markers).filter(([, v]) => v).map(([k]) => k).join(','))
  for (const f of fileIds) if (c.lines[f].length) lines.push(`  ${f}: ` + c.lines[f].map(s => `${s[0]}=${s[2]}(${s[3] || ''})`).join(' '))
  if (c.cli.length) lines.push('  cli: ' + c.cli.map(s => `${s[0]}=${s[2]}(${s[3] || ''})`).join(' '))
  if (c.env.length) lines.push('  env: ' + c.env.map(s => `${nameCase(s[0], s[1])}=${s[3]}(${s[4] || ''})`).join(' '))
  if (c.envPrefix) lines.push('  PREFIX=' + c.envPrefix)
  return lines.join('\n')
}

const main = async () => {
  const N = +process.argv[2] || 1000
  seed = +process.argv[3] || 7
  const replay = process.argv[4]
  if (replay) {
    const c = JSON.parse(fs.readFileSync(replay, 'utf8'))
    const res = await check(c)
    console.log(describe(c))
    console.log(JSON.stringify(res.out || res.skip, null, 1))
    if (res.r) console.log({ env: res.r.env, argv: res.r.argv, user: res.r.userFile, global: res.r.globalFile, project: res.r.projectFile, localPrefix: res.r.localPrefix })
    return
  }
  const cats = new Map()
  let ran = 0; let skipped = 0
  const distinct = new Set()
  for (let i = 0; i < N; i++) {
    const c = gen()
    distinct.add(JSON.stringify(c))
    const res = await check(c)
    if (res.skip) { skipped++; continue }
    ran++
    for (const o of res.out) {
      if (!cats.has(o.cat)) cats.set(o.cat, { n: 0, first: c, o })
      cats.get(o.cat).n++
    }
  }
  console.log(`cases=${N} distinct=${distinct.size} loaded=${ran} skipped=${skipped}`)
  for (const [cat, { n, first, o }] of cats) {
    console.log(`\n== ${cat}: ${n}`)
    const s = await shrink(first, cat)
    fs.writeFileSync(path.join(OUT, `min-${cat}.json`), JSON.stringify(s))
    console.log(describe(s))
    const res = await check(s)
    console.log(JSON.stringify(res.out.filter(x => x.cat === cat)))
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
