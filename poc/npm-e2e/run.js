'use strict'

// End-to-end check of the Phase 1 `tokenHelper` prototype: a real npm, from a
// local npm/cli checkout with the prototype npm-registry-fetch laid over its
// bundled copy, against a local registry that records the Authorization
// header it receives.
//
//   node poc/npm-e2e/run.js <npm-cli checkout> <npm-registry-fetch checkout>
//
// Both checkouts must be on their `token-helper` branches. The overlay is
// undone before the script exits, whatever happens.

const { execFile } = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const [npmCliDir, fetchDir] = process.argv.slice(2).map(p => path.resolve(p))
if (!npmCliDir || !fetchDir) {
  console.error('usage: node poc/npm-e2e/run.js <npm-cli checkout> <npm-registry-fetch checkout>')
  process.exit(2)
}

const OVERLAY = ['auth.js', 'index.js', 'token-helper.js']
const bundled = path.join(npmCliDir, 'node_modules', 'npm-registry-fetch', 'lib')

const overlay = () => {
  const backup = new Map()
  const restore = () => {
    for (const [target, content] of backup) {
      if (content === null) {
        fs.rmSync(target, { force: true })
      } else {
        fs.writeFileSync(target, content)
      }
    }
  }
  try {
    for (const file of OVERLAY) {
      const target = path.join(bundled, file)
      backup.set(target, fs.existsSync(target) ? fs.readFileSync(target) : null)
      fs.copyFileSync(path.join(fetchDir, 'lib', file), target)
    }
  } catch (er) {
    // a half-applied overlay must not outlive the run
    restore()
    throw er
  }
  return restore
}

// The helper sits in a directory whose name has a space and writes to stderr,
// so both paths are exercised.
const writeHelper = (root) => {
  const dir = path.join(root, 'token helpers')
  fs.mkdirSync(dir, { recursive: true })
  const body = "process.stderr.write('helper says hello\\n'); process.stdout.write('helper-token\\n')"
  fs.writeFileSync(path.join(dir, 'helper.js'), body)
  if (process.platform === 'win32') {
    const helper = path.join(dir, 'helper.cmd')
    fs.writeFileSync(helper, `@"${process.execPath}" "${path.join(dir, 'helper.js')}"\r\n`)
    return helper
  }
  const helper = path.join(dir, 'helper')
  fs.writeFileSync(helper, `#!${process.execPath}\n${body}`)
  fs.chmodSync(helper, 0o755)
  return helper
}

const main = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-token-helper-e2e-'))
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization || null)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      name: 'demo',
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { name: 'demo', version: '1.0.0', dist: { tarball: 'http://x/demo.tgz' } } },
    }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const registry = `http://127.0.0.1:${port}/`
  const nerf = `//127.0.0.1:${port}/`
  const helper = writeHelper(root)

  const run = async (name, userrc, projectrc) => {
    const dir = path.join(root, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), '{}')
    fs.writeFileSync(path.join(dir, 'user.npmrc'), userrc)
    if (projectrc) {
      fs.writeFileSync(path.join(dir, '.npmrc'), projectrc)
    }
    seen.length = 0
    const { stdout, stderr } = await new Promise(resolve => execFile(process.execPath, [
      path.join(npmCliDir, 'bin', 'npm-cli.js'), 'view', 'demo', 'version',
      `--registry=${registry}`,
      `--userconfig=${path.join(dir, 'user.npmrc')}`,
      `--globalconfig=${path.join(dir, 'global.npmrc')}`,
      `--cache=${path.join(dir, 'cache')}`,
      '--prefer-online',
    ], { cwd: dir, timeout: 60000 }, (err, out, errOut) =>
      resolve({ stdout: out, stderr: errOut + (err ? `\n${err.message}` : '') })))
    return {
      name,
      version: stdout.trim(),
      authorization: [...new Set(seen)],
      notices: stderr.split(/\r?\n/).filter(l => /tokenHelper|token-helper|ETOKENHELPER|Unknown/.test(l)),
    }
  }

  const restore = overlay()
  try {
    const results = [
      await run('user-config', `${nerf}:tokenHelper=${helper}\n`),
      await run('project-config', '', `${nerf}:tokenHelper=${helper}\n`),
      await run('helper-beats-stale-token', `${nerf}:tokenHelper=${helper}\n${nerf}:_authToken=stale\n`),
    ]
    console.log(JSON.stringify(results, null, 2))
    const [user, project, stale] = results
    const ok = user.version === '1.0.0' &&
      user.authorization.join() === 'Bearer helper-token' &&
      user.notices.some(l => l.includes('helper says hello')) &&
      project.authorization.join() === '' &&
      project.notices.some(l => l.includes('Ignoring project config')) &&
      stale.authorization.join() === 'Bearer helper-token'
    console.log(ok ? 'PASS' : 'FAIL')
    process.exitCode = ok ? 0 : 1
  } finally {
    restore()
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main()
