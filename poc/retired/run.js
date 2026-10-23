'use strict'

// Proves that each retired mechanism is still one `git apply` away: for every
// entry of retired.json it checks that the patch applies to the prototype,
// applies it, runs the tap files the entry lists (the tests of the mechanism the
// patch restores), prints one line with the outcome and puts the tree back. The
// job fails if a patch does not apply or its tests fail; every entry is tried
// whatever the ones before it did.
//
//   node poc/retired/run.js <npm-cli checkout with the prototype applied>
//
// The checkout must be a git tree with no changes, because each entry is undone
// with `git checkout -- .` and `git clean -fd`; the script refuses to start
// otherwise. With GITHUB_STEP_SUMMARY set, the lines are written there too.

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const here = __dirname
const root = process.argv[2] && path.resolve(process.argv[2])
if (!root) {
  console.error('usage: node poc/retired/run.js <npm-cli checkout>')
  process.exit(2)
}
const { retired } = JSON.parse(fs.readFileSync(path.join(here, 'retired.json'), 'utf8'))

const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })

const dirty = git('status', '--porcelain')
if (dirty.status !== 0 || dirty.stdout.trim()) {
  console.error(`${root} is not a git tree with no changes; refusing to apply patches to it and clean it afterwards`)
  process.exit(2)
}

const tap = path.join(root, 'node_modules', 'tap', 'bin', 'run.js')
const lines = []
let failures = 0
const report = (line, failed) => {
  lines.push(`${failed ? 'FAIL' : 'ok  '} ${line}`)
  console.log(lines.at(-1))
  failures += failed ? 1 : 0
}

for (const { name, patch, tests } of retired) {
  const file = path.join(here, patch)
  console.log(`::group::${name}`)
  try {
    const check = git('apply', '--check', file)
    if (check.status !== 0) {
      console.log(check.stderr)
      report(`${name}: the patch no longer applies to the prototype`, true)
      continue
    }
    const applied = git('apply', file)
    if (applied.status !== 0) {
      console.log(applied.stderr)
      report(`${name}: git apply failed after a successful check`, true)
      continue
    }
    const failed = []
    let count = 0
    for (const [dir, files] of Object.entries(tests)) {
      count += files.length
      const run = spawnSync(process.execPath, [tap, '--no-coverage', ...files], {
        cwd: path.join(root, dir),
        encoding: 'utf8',
        stdio: ['ignore', 'inherit', 'inherit'],
      })
      if (run.status !== 0) {
        failed.push(...files.map(f => path.posix.join(dir, f)))
      }
    }
    report(failed.length
      ? `${name}: applied, and the tests of the restored mechanism fail (${failed.join(', ')})`
      : `${name}: applied, and its ${count} test file${count === 1 ? '' : 's'} pass${count === 1 ? 'es' : ''}`, failed.length)
  } finally {
    console.log('::endgroup::')
    git('checkout', '--', '.')
    git('clean', '-fd')
  }
}

console.log(`\n${retired.length - failures} of ${retired.length} retired mechanisms apply and pass`)
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Retired mechanisms\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`)
}
process.exitCode = failures ? 1 : 0
