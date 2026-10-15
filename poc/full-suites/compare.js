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
    .map(dir => ({ name: require(path.join(tree, dir, 'package.json')).name, dir }))
}

const suites = ['(root)', ...workspaces(patched).map(w => w.name)].filter(s => !only.length || only.includes(s))

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
    output,
    tail: output.split('\n').filter(Boolean).slice(-15).join('\n'),
  }
}

// one test file, alone and without coverage, as a pass or a fail
const suiteDir = (tree, suite) => suite === '(root)' ? tree : path.join(tree, workspaces(tree).find(w => w.name === suite).dir)
const runFile = (tree, suite, file) => spawnSync(process.execPath,
  [path.join(tree, 'node_modules', 'tap', 'bin', 'run.js'), '--no-coverage', file],
  { cwd: suiteDir(tree, suite), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 }).status === 0

// what tap printed about the failing subtests of a file
const failureLines = output => output.split('\n')
  .filter(line => /^\s+not ok |^\s+(found|wanted|message|at|stack):|^\s+[-+] /.test(line))
  .slice(0, 40).join('\n')

const RERUNS = 3
const regressions = []
const flaky = []
for (const suite of suites) {
  const before = runSuite(base, suite)
  const after = runSuite(patched, suite)
  const newFiles = after.failed.filter(f => !before.failed.includes(f))
  // a file that failed once may fail at random: it counts only if it fails
  // every time with the prototype and passes every time without it
  const confirmed = newFiles.filter(file => {
    const withPrototype = Array.from({ length: RERUNS }, () => runFile(patched, suite, file)).filter(Boolean).length
    const withoutIt = Array.from({ length: RERUNS }, () => runFile(base, suite, file)).filter(Boolean).length
    console.log(`  ${suite} ${file}: rerun ${RERUNS}x, passes ${withPrototype} with the prototype, ${withoutIt} without`)
    if (withPrototype === 0 && withoutIt === RERUNS) {
      return true
    }
    flaky.push(`${suite} ${file}`)
    return false
  })
  // a suite that fails without any failing file (coverage) is a regression
  // too, unless a file that failed only once explains it
  const suiteOnly = before.ok && !after.ok && !after.failed.length
  const regressed = confirmed.length > 0 || suiteOnly
  console.log(`${regressed ? 'FAIL' : 'ok  '} ${suite}: base ${before.ok ? 'passes' : `fails (${before.status})`} ` +
    `in ${before.seconds}s, prototype ${after.ok ? 'passes' : `fails (${after.status})`} in ${after.seconds}s` +
    (before.failed.length ? `; failing in both: ${before.failed.filter(f => after.failed.includes(f)).join(', ')}` : ''))
  if (newFiles.length) {
    console.log(failureLines(after.output).replace(/^/gm, '  | '))
  }
  if (regressed) {
    regressions.push(suite)
    console.log(`  regression: ${confirmed.join(', ') || '(the suite as a whole)'}\n${after.tail.replace(/^/gm, '  | ')}`)
  }
}
if (flaky.length) {
  console.log(`failed once, not every time: ${flaky.join('; ')}`)
}
console.log(`${suites.length} suites, ${regressions.length} regressions`)
console.log(regressions.length ? 'FAIL' : 'PASS')
process.exitCode = regressions.length ? 1 : 0
