'use strict'

// Confirms that every piece of evidence the three implementation documents
// (phase-1a-, phase-1b- and phase-2-implementation.md) and sources.md cite
// still exists: each `kind: text` reference must be found in the files of that
// kind, so a test that is renamed or deleted cannot leave an RFC claim without
// evidence.
// Kinds: fetch, config, cli (npm's tests), e2e, probe (this repository's
// scripts), spec (a key of spec/policy-v1.json), py (a file in tests/, or
// `module.test_name`, or `module.Class.test_name`, for a test in it: a bare
// module name proves only that the file exists), js (a
// test title in examples/providers/*.test.js) and rs (a Rust test function
// under poc/rust/crates).
//
// It also checks the submissions of each implementation document: every row of
// a table under `## Rule by rule` has a Submission cell naming submissions of
// that document's `## Submissions` table, every submission is named by a rule,
// and, for Phase 1a, the commit shas and the lib lines added that the table
// states are those of the commits in poc/patches.
//
// And the retired mechanisms: every patch in poc/retired is an entry of
// retired.json and a row of the README's table there, and the other way round.
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

const implementations = ['phase-1a-implementation.md', 'phase-1b-implementation.md', 'phase-2-implementation.md']
const documents = [...implementations, 'sources.md']
const refs = documents.flatMap(name => [...read(path.join(rfc, name)).matchAll(/`(fetch|config|cli|e2e|probe|spec|py|js|rs): ([^`]+)`/g)])
const missing = refs.filter(([, kind, text]) => !found(kind, text))
for (const [ref] of missing) {
  console.log(`missing ${ref}`)
}
console.log(`${refs.length} references, ${missing.length} missing`)

// The cells of a table row, split at the bars that are not inside a code span.
const cellsOf = line => {
  const cells = []
  let current = ''
  let inCode = false
  for (const ch of line.trim().replace(/^\|/, '')) {
    if (ch === '`') {
      inCode = !inCode
    }
    if (ch === '|' && !inCode) {
      cells.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  return cells
}

// The tables of the `## title` section of a document: { header, rows }, cells
// as strings. Lines in a fenced block are not part of any table.
const tablesIn = (text, title) => {
  const lines = []
  let inSection = false
  let fenced = false
  for (const line of text.split('\n')) {
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced
    }
    if (!fenced && /^## /.test(line)) {
      inSection = line.slice(3).trim() === title
      continue
    }
    if (inSection && !fenced) {
      lines.push(line)
    }
  }
  const tables = []
  let current = null
  for (const line of lines) {
    if (line.startsWith('|')) {
      if (!current) {
        current = []
        tables.push(current)
      }
      current.push(cellsOf(line))
    } else {
      current = null
    }
  }
  return tables.map(([header, , ...rows]) => ({ header, rows }))
}

// Added lines of each commit of an mbox patch under lib/ and
// workspaces/config/lib/, counted by walking the hunks by their own counters.
const addedLibLines = file => {
  const commits = []
  let commit = null
  let name = null
  let oldLeft = 0
  let newLeft = 0
  // a checkout with autocrlf has CRLF endings; the walk does not depend on them
  for (const line of read(file).split(/\r?\n/)) {
    const from = /^From ([0-9a-f]{40}) /.exec(line)
    if (from && !oldLeft && !newLeft) {
      commit = { sha: from[1], added: 0 }
      commits.push(commit)
      name = null
    } else if (!oldLeft && !newLeft) {
      const diff = /^diff --git a\/.* b\/(.*)$/.exec(line)
      const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line)
      if (diff) {
        name = diff[1]
      } else if (hunk) {
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1])
        newLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
      }
    } else if (line[0] === '+') {
      newLeft--
      if (name.startsWith('lib/') || name.startsWith('workspaces/config/lib/')) {
        commit.added++
      }
    } else if (line[0] === '-') {
      oldLeft--
    } else if (line[0] !== '\\') {
      oldLeft--
      newLeft--
    }
  }
  return commits
}

const problems = []
let ruleRows = 0
for (const name of implementations) {
  const text = read(path.join(rfc, name))
  const [submissions] = tablesIn(text, 'Submissions')
  if (!submissions || submissions.header[0] !== '#') {
    problems.push(`${name}: no Submissions table whose first column is #`)
    continue
  }
  const numbers = new Set(submissions.rows.map(row => row[0]))
  const named = new Set()
  const rules = tablesIn(text, 'Rule by rule')
  if (!rules.length) {
    problems.push(`${name}: no table under Rule by rule`)
  }
  for (const { header, rows } of rules) {
    const column = header.indexOf('Submission')
    if (column < 0) {
      problems.push(`${name}: a table under Rule by rule has no Submission column (${header.join(' | ')})`)
      continue
    }
    for (const row of rows) {
      ruleRows++
      const cell = row[column] ?? ''
      if (!/^\d+(, \d+)*$/.test(cell)) {
        problems.push(`${name}: the Submission cell "${cell}" of "${row[0].slice(0, 60)}" is not a submission number or a list of them`)
        continue
      }
      for (const number of cell.split(', ')) {
        if (!numbers.has(number)) {
          problems.push(`${name}: "${row[0].slice(0, 60)}" names submission ${number}, which the Submissions table does not have`)
        }
        named.add(number)
      }
    }
  }
  for (const number of numbers) {
    if (!named.has(number)) {
      problems.push(`${name}: submission ${number} is named by no rule`)
    }
  }
  if (name === 'phase-1a-implementation.md') {
    const patches = {
      'npm-registry-fetch': addedLibLines(path.join(rfc, 'poc', 'patches', 'npm-registry-fetch.patch')),
      'npm/cli': addedLibLines(path.join(rfc, 'poc', 'patches', 'npm-cli.patch')),
    }
    const matched = new Set()
    for (const row of submissions.rows) {
      const repository = Object.keys(patches).find(key => row[1].startsWith(key))
      const sha = /commit `([0-9a-f]{7,40})`/i.exec(row[2])?.[1]
      const lines = /(\d+) lib lines/.exec(row[2])?.[1]
      if (!repository || !sha || !lines) {
        problems.push(`${name}: submission ${row[0]} states no repository, no commit sha or no "N lib lines"`)
        continue
      }
      const commit = patches[repository].find(c => c.sha.startsWith(sha))
      if (!commit) {
        problems.push(`${name}: submission ${row[0]} names commit ${sha}, which poc/patches has no commit of in ${repository}`)
        continue
      }
      matched.add(commit.sha)
      if (commit.added !== Number(lines)) {
        problems.push(`${name}: submission ${row[0]} states ${lines} lib lines, the patch of ${sha} adds ${commit.added}`)
      }
    }
    for (const commit of Object.values(patches).flat()) {
      if (!matched.has(commit.sha)) {
        problems.push(`${name}: the commit ${commit.sha.slice(0, 7)} of poc/patches is in no submission`)
      }
    }
  }
}
for (const problem of problems) {
  console.log(problem)
}
console.log(`${ruleRows} rule rows in ${implementations.length} documents, ${problems.length} problems with submissions`)

// The retired mechanisms: poc/retired holds one patch for each entry of
// retired.json and one row of the README's table for each, and nothing else.
const retiredDir = path.join(rfc, 'poc', 'retired')
const retiredProblems = []
const listed = JSON.parse(read(path.join(retiredDir, 'retired.json'))).retired
const onDisk = fs.readdirSync(retiredDir).filter(name => name.endsWith('.patch'))
const rowsOfReadme = read(path.join(retiredDir, 'README.md')).split('\n')
  .filter(line => line.startsWith('|')).map(cellsOf)
  .map(cells => /^`([^`]+\.patch)`$/.exec(cells[0])?.[1]).filter(Boolean)
for (const name of onDisk) {
  if (!listed.some(entry => entry.patch === name)) {
    retiredProblems.push(`poc/retired/${name} is in no entry of retired.json`)
  }
  if (!rowsOfReadme.includes(name)) {
    retiredProblems.push(`poc/retired/${name} has no row in poc/retired/README.md`)
  }
}
for (const entry of listed) {
  if (!onDisk.includes(entry.patch)) {
    retiredProblems.push(`retired.json lists ${entry.patch}, which is not in poc/retired`)
  }
  if (!Object.values(entry.tests).flat().length) {
    retiredProblems.push(`retired.json lists no tests for ${entry.name}`)
  }
}
for (const name of rowsOfReadme) {
  if (!onDisk.includes(name)) {
    retiredProblems.push(`poc/retired/README.md has a row for ${name}, which is not in poc/retired`)
  }
}
for (const problem of retiredProblems) {
  console.log(problem)
}
console.log(`${onDisk.length} retired patches, ${listed.length} in retired.json, ${rowsOfReadme.length} rows in the README, ${retiredProblems.length} problems`)
problems.push(...retiredProblems)

const failed = missing.length || !refs.length || problems.length
console.log(failed ? 'FAIL' : 'PASS')
process.exitCode = failed ? 1 : 0
