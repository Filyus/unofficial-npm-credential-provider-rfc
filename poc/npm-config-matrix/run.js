'use strict'

// Exhaustive check of the tokenHelper trust rule in @npmcli/config: every
// combination of the project .npmrc, the environment, the command line and
// the user file setting `userconfig`, `globalconfig` and `prefix` (2048
// loads). Files a project chose hold an "EVIL" helper, files chosen
// elsewhere a "GOOD" one; no load may end with the EVIL helper in effect.
//
//   node poc/npm-config-matrix/run.js <npm-cli checkout> <scratch dir>
//
// Found the globalconfig case that a narrower test missed: the first layer
// to assign `globalconfig` stores it on the default layer, so a project value
// can be in effect over a cli or env one, depending on what the user file sets.

const fs = require('fs')
const path = require('path')

const [npmCliDir, scratch] = process.argv.slice(2).map(p => p && path.resolve(p))
if (!npmCliDir || !scratch) {
  console.error('usage: node poc/npm-config-matrix/run.js <npm-cli checkout> <scratch dir>')
  process.exit(2)
}
const Config = require(path.join(npmCliDir, 'workspaces', 'config'))
const { definitions, flatten, nerfDarts, shorthands } =
  require(path.join(npmCliDir, 'workspaces', 'config', 'lib', 'definitions'))

const base = path.join(scratch, 'npm-config-matrix')
const P = (...a) => path.join(base, ...a)
const slash = p => p.replace(/\\/g, '/')
const helperLine = v => `//reg.example/:tokenHelper=${v}\n`
const write = (p, c) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, c)
}

// bit i of a mask: whether that source sets the setting
const PROJECT = 0
const ENV = 1
const CLI = 2
const USER = 3
const has = (mask, source) => !!(mask & (1 << source))

const main = async () => {
  fs.rmSync(base, { recursive: true, force: true })
  write(P('proj', 'package.json'), '{}')
  let loaded = 0
  const bad = []
  for (let m = 0; m < 2048; m++) {
    // the user file cannot set userconfig for itself, so three bits there
    const uc = m & 7
    const gc = (m >> 3) & 15
    const pf = (m >> 7) & 15
    const userLines = (has(gc, USER) ? `globalconfig=${slash(P('userg.npmrc'))}\n` : '') +
      (has(pf, USER) ? `prefix=${slash(P('userpre'))}\n` : '')
    write(P('proj', '.npmrc'),
      (has(uc, PROJECT) ? `userconfig=${slash(P('proj', 'u.npmrc'))}\n` : '') +
      (has(gc, PROJECT) ? `globalconfig=${slash(P('proj', 'g.npmrc'))}\n` : '') +
      (has(pf, PROJECT) ? `prefix=${slash(P('proj', 'pre'))}\n` : ''))
    write(P('proj', 'u.npmrc'), helperLine('EVIL') + userLines)
    for (const name of ['envu', 'cliu']) {
      write(P(`${name}.npmrc`), userLines)
    }
    write(P('home', '.npmrc'), userLines)
    write(P('proj', 'g.npmrc'), helperLine('EVIL'))
    for (const name of ['envg', 'clig', 'userg']) {
      write(P(`${name}.npmrc`), helperLine('GOOD'))
    }
    write(P('proj', 'pre', 'etc', 'npmrc'), helperLine('EVIL'))
    for (const name of ['envpre', 'clipre', 'userpre']) {
      write(P(name, 'etc', 'npmrc'), helperLine('GOOD'))
    }
    const env = { HOME: P('home'), USERPROFILE: P('home'), PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }
    const argv = [process.execPath, 'npm']
    if (has(uc, ENV)) {
      env.npm_config_userconfig = P('envu.npmrc')
    }
    if (has(uc, CLI)) {
      argv.push(`--userconfig=${P('cliu.npmrc')}`)
    }
    if (has(gc, ENV)) {
      env.npm_config_globalconfig = P('envg.npmrc')
    }
    if (has(gc, CLI)) {
      argv.push(`--globalconfig=${P('clig.npmrc')}`)
    }
    if (has(pf, ENV)) {
      env.npm_config_prefix = P('envpre')
    }
    if (has(pf, CLI)) {
      argv.push(`--prefix=${P('clipre')}`)
    }
    const config = new Config({
      npmPath: npmCliDir, definitions, flatten, nerfDarts, shorthands, argv, env, cwd: P('proj'), warn: false,
    })
    try {
      await config.load()
    } catch {
      // a combination that loads one file twice is refused by npm itself
      continue
    }
    loaded++
    const inEffect = config.get('//reg.example/:tokenHelper')
    const where = `userconfig ${uc.toString(2)} globalconfig ${gc.toString(2)} prefix ${pf.toString(2)}` +
      ` (bits: user cli env project) -> global ${path.relative(base, config.get('globalconfig'))}`
    if (inEffect === 'EVIL') {
      bad.push(`EVIL helper trusted: ${where}`)
    }
    // and the rule must not cost the user their own helper: with nothing
    // chosen by the project, a global file chosen elsewhere is trusted
    const projectChoseNothing = !has(uc, PROJECT) && !has(gc, PROJECT) && !has(pf, PROJECT)
    if (projectChoseNothing && (gc || pf) && inEffect !== 'GOOD') {
      bad.push(`GOOD helper lost: ${where}`)
    }
  }
  fs.rmSync(base, { recursive: true, force: true })
  for (const line of bad) {
    console.log(line)
  }
  console.log(`${loaded} loads, ${bad.length} wrong`)
  console.log(bad.length || !loaded ? 'FAIL' : 'PASS')
  process.exitCode = bad.length || !loaded ? 1 : 0
}

main()
