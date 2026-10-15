'use strict'

// Runs every npm/cli test suite (the root and each workspace) in two trees,
// the unpatched base and the base with the prototype applied, and fails on
// any suite or test file that passes in the base and fails with the
// prototype: the prototype must break nothing outside its own tests.
//
//   node poc/full-suites/compare.js <base npm-cli tree> <patched npm-cli tree> [suite...]
//
// Suites are run as npm/cli's own CI runs them: `npm test` at the root and
// `npm test --workspace <name>` for each workspace.

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const [base, patched] = process.argv.slice(2, 4).map(p => p && path.resolve(p))
const only = process.argv.slice(4)
if (!base || !patched) {
  console.error('usage: node poc/full-suites/compare.js <base> <patched> [suite...]')
  process.exit(2)
}

const workspaces = tree => {
  const globs = require(path.join(tree, 'package.json')).workspaces
  return globs.flatMap(glob => glob.endsWith('/*')
    ? fs.readdirSync(path.join(tree, glob.slice(0, -2))).map(d => path.join(glob.slice(0, -2), d))
    : [glob])
    .filter(dir => fs.existsSync(path.join(tree, dir, 'package.json')))
    .map(dir => require(path.join(tree, dir, 'package.json')).name)
}

const suites = ['(root)', ...workspaces(patched)].filter(s => !only.length || only.includes(s))

const runSuite = (tree, suite) => {
  const args = [path.join(tree, 'bin', 'npm-cli.js'), 'test', '--ignore-scripts',
    ...(suite === '(root)' ? [] : ['--workspace', suite])]
  const started = Date.now()
  const result = spawnSync(process.execPath, args, {
    cwd: tree,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 40 * 60 * 1000,
    env: { ...process.env, CI: 'true' },
  })
  const output = `${result.stdout}\n${result.stderr}`
  // tap's top-level results: one line per test file
  const failed = [...output.matchAll(/^not ok \d+ - (\S+)/gm)].map(m => m[1])
  return {
    ok: result.status === 0,
    status: result.status ?? result.signal,
    failed,
    seconds: Math.round((Date.now() - started) / 1000),
    tail: output.split('\n').filter(Boolean).slice(-15).join('\n'),
  }
}

const regressions = []
for (const suite of suites) {
  const before = runSuite(base, suite)
  const after = runSuite(patched, suite)
  const newFiles = after.failed.filter(f => !before.failed.includes(f))
  const regressed = (before.ok && !after.ok) || newFiles.length > 0
  console.log(`${regressed ? 'FAIL' : 'ok  '} ${suite}: base ${before.ok ? 'passes' : `fails (${before.status})`} ` +
    `in ${before.seconds}s, prototype ${after.ok ? 'passes' : `fails (${after.status})`} in ${after.seconds}s` +
    (before.failed.length ? `; failing in both: ${before.failed.filter(f => after.failed.includes(f)).join(', ')}` : ''))
  if (regressed) {
    regressions.push(suite)
    console.log(`  newly failing: ${newFiles.join(', ') || '(the suite as a whole)'}\n${after.tail.replace(/^/gm, '  | ')}`)
  }
}
console.log(`${suites.length} suites, ${regressions.length} regressions`)
console.log(regressions.length ? 'FAIL' : 'PASS')
process.exitCode = regressions.length ? 1 : 0
