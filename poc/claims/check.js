'use strict'

// Confirms that every piece of evidence phase-1a-implementation.md,
// phase-2-implementation.md and sources.md cite still exists: each
// `kind: text` reference must be found in the files of that kind, so a test
// that is renamed or deleted cannot leave an RFC claim without evidence.
// Kinds: fetch, config, cli (npm's tests), e2e, probe (this repository's
// scripts), spec (a key of spec/policy-v1.json), py (a file in tests/, or
// `module.test_name`, or `module.Class.test_name`, for a test in it: a bare
// module name proves only that the file exists), js (a
// test title in examples/providers/*.test.js) and rs (a Rust test function
// under poc/rust/crates).
//
//   node poc/claims/check.js <npm-cli checkout> <npm-registry-fetch checkout>

const fs = require('fs')
const path = require('path')

const rfc = path.resolve(__dirname, '..', '..')
const [npmCliDir, fetchDir] = process.argv.slice(2).map(p => p && path.resolve(p))
if (!npmCliDir || !fetchDir) {
  console.error('usage: node poc/claims/check.js <npm-cli checkout> <npm-registry-fetch checkout>')
  process.exit(2)
}

const read = file => fs.readFileSync(file, 'utf8')
const tree = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(dir, entry.name)
  return entry.isDirectory() ? tree(file) : entry.name.endsWith('.js') ? [read(file)] : []
}).join('\n')

const sources = (dir, ext) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(dir, entry.name)
  return entry.isDirectory() ? (entry.name === 'target' ? [] : sources(file, ext)) : entry.name.endsWith(ext) ? [read(file)] : []
}).join('\n')

const corpus = {
  js: () => fs.readdirSync(path.join(rfc, 'examples', 'providers'))
    .filter(name => name.endsWith('.test.js')).map(name => read(path.join(rfc, 'examples', 'providers', name))).join('\n'),
  rs: () => sources(path.join(rfc, 'poc', 'rust', 'crates'), '.rs'),
  fetch: () => read(path.join(fetchDir, 'test', 'auth.js')),
  config: () => tree(path.join(npmCliDir, 'workspaces', 'config', 'test')),
  cli: () => tree(path.join(npmCliDir, 'test', 'lib')),
  e2e: () => read(path.join(rfc, 'poc', 'npm-e2e', 'run.js')),
  probe: () => read(path.join(rfc, 'poc', 'platform-probes', 'run.js')),
  spec: () => read(path.join(rfc, 'spec', 'policy-v1.json')),
}
const loaded = {}
const specKeys = new Set()
const collectKeys = (value) => {
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      specKeys.add(key)
      collectKeys(inner)
    }
  }
}
collectKeys(JSON.parse(read(path.join(rfc, 'spec', 'policy-v1.json'))))
const found = (kind, text) => {
  if (kind === 'py') {
    // `module`, `module.test_name` or `module.Class.test_name`
    const [module, ...rest] = text.split('.')
    const file = path.join(rfc, 'tests', `${module}.py`)
    if (!fs.existsSync(file) || rest.length > 2) {
      return false
    }
    if (!rest.length) {
      return true
    }
    const source = read(file)
    const test = rest.pop()
    const scope = rest.length ? source.split(new RegExp(`^class ${rest[0]}\\b`, 'm'))[1]?.split(/^class /m)[0] : source
    return scope !== undefined && new RegExp(`^\\s*(async )?def ${test}\\(`, 'm').test(scope)
  }
  loaded[kind] ??= corpus[kind]()
  if (kind === 'spec') {
    return specKeys.has(text)
  }
  return loaded[kind].includes(text)
}

const documents = ['phase-1a-implementation.md', 'phase-2-implementation.md', 'sources.md']
const refs = documents.flatMap(name => [...read(path.join(rfc, name)).matchAll(/`(fetch|config|cli|e2e|probe|spec|py|js|rs): ([^`]+)`/g)])
const missing = refs.filter(([, kind, text]) => !found(kind, text))
for (const [ref] of missing) {
  console.log(`missing ${ref}`)
}
console.log(`${refs.length} references, ${missing.length} missing`)
console.log(missing.length || !refs.length ? 'FAIL' : 'PASS')
process.exitCode = missing.length || !refs.length ? 1 : 0
