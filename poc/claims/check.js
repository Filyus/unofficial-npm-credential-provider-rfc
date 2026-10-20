'use strict'

// Confirms that every piece of evidence claims.md cites still exists: each
// `kind: text` reference must be found in the files of that kind, so a test
// that is renamed or deleted cannot leave an RFC claim without evidence.
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

const corpus = {
  fetch: () => read(path.join(fetchDir, 'test', 'token-helper.js')),
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
    return fs.existsSync(path.join(rfc, 'tests', `${text}.py`))
  }
  loaded[kind] ??= corpus[kind]()
  if (kind === 'spec') {
    return specKeys.has(text)
  }
  return loaded[kind].includes(text)
}

const refs = [...read(path.join(rfc, 'claims.md')).matchAll(/`(fetch|config|cli|e2e|probe|spec|py): ([^`]+)`/g)]
const missing = refs.filter(([, kind, text]) => !found(kind, text))
for (const [ref] of missing) {
  console.log(`missing ${ref}`)
}
console.log(`${refs.length} references, ${missing.length} missing`)
console.log(missing.length || !refs.length ? 'FAIL' : 'PASS')
process.exitCode = missing.length || !refs.length ? 1 : 0
