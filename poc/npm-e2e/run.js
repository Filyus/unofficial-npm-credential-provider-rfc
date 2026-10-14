'use strict'

// End-to-end check of the Phase 1 `tokenHelper` prototype: a real npm, from a
// local npm/cli checkout with the prototype npm-registry-fetch laid over its
// bundled copy, against a local registry that records every request and the
// Authorization header it carried.
//
//   node poc/npm-e2e/run.js <npm-cli checkout> <npm-registry-fetch checkout>
//
// Both checkouts must be on their `token-helper` branches. The overlay is
// undone before the script exits, including on Ctrl+C.

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
    const failures = []
    // every file is restored even if another one fails
    for (const [target, content] of backup) {
      try {
        if (content === null) {
          fs.rmSync(target, { force: true })
        } else {
          fs.writeFileSync(target, content)
        }
      } catch (er) {
        failures.push(`${target}: ${er.message}`)
      }
    }
    backup.clear()
    if (failures.length) {
      console.error(`could not restore:\n${failures.join('\n')}\nrun: git -C ${npmCliDir} checkout -- node_modules/npm-registry-fetch/lib`)
      // a run that leaves the checkout modified has not passed
      process.exitCode = 1
    }
    return failures.length === 0
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
// including something that looks like a credential, so quoting, stderr
// forwarding and masking are all exercised.
const writeHelper = (root) => {
  const dir = path.join(root, 'token helpers')
  fs.mkdirSync(dir, { recursive: true })
  const script = path.join(dir, 'helper.js')
  fs.writeFileSync(script, [
    "process.stderr.write('helper says hello\\n')",
    "process.stderr.write('debug: Authorization: Bearer leaked-in-stderr\\n')",
    "process.stdout.write('helper-token\\n')",
  ].join('\n'))
  if (process.platform === 'win32') {
    const helper = path.join(dir, 'helper.cmd')
    fs.writeFileSync(helper, `@"${process.execPath}" "${script}"\r\n`)
    return helper
  }
  // a shell wrapper, so a node path with spaces cannot break a shebang
  const helper = path.join(dir, 'helper')
  // single quotes, with any single quote in a path escaped, so the shell
  // expands nothing in the paths
  const sq = s => `'${s.replaceAll("'", "'\\''")}'`
  fs.writeFileSync(helper, `#!/bin/sh\nexec ${sq(process.execPath)} ${sq(script)}\n`)
  fs.chmodSync(helper, 0o755)
  return helper
}

const main = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-token-helper-e2e-'))
  const seen = []
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(req.method === 'PUT' ? { ok: true } : {
        name: 'demo',
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { name: 'demo', version: '1.0.0', dist: { tarball: 'http://x/demo.tgz' } } },
      }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const registry = `http://127.0.0.1:${port}/`
  const nerf = `//127.0.0.1:${port}/`
  const helper = writeHelper(root)
  const helperLine = `${nerf}:tokenHelper=${helper}\n`

  const run = async (name, { args = ['view', 'demo', 'version'], user = '', project = '', pkg = {}, userconfigFlag = true }) => {
    const dir = path.join(root, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.1', ...pkg }))
    fs.writeFileSync(path.join(dir, 'user.npmrc'), user)
    fs.writeFileSync(path.join(dir, '.npmrc'), project.replaceAll('<dir>', dir))
    fs.writeFileSync(path.join(dir, 'repo-user.npmrc'), helperLine)
    // HOME must not be the project directory, or the project .npmrc would be
    // the default user config and npm would load it as such
    const home = path.join(dir, 'home')
    fs.mkdirSync(home)
    seen.length = 0
    const { stdout, stderr, failed } = await new Promise(resolve => execFile(process.execPath, [
      path.join(npmCliDir, 'bin', 'npm-cli.js'), ...args,
      `--registry=${registry}`,
      // a --userconfig flag would outrank a project redirect, so the redirect
      // scenario leaves it out and points HOME at the scenario directory
      ...(userconfigFlag ? [`--userconfig=${path.join(dir, 'user.npmrc')}`] : []),
      `--globalconfig=${path.join(dir, 'global.npmrc')}`,
      `--cache=${path.join(dir, 'cache')}`,
      '--prefer-online',
    ], { cwd: dir, timeout: 60000, env: { ...process.env, HOME: home, USERPROFILE: home } }, (err, out, errOut) =>
      resolve({ stdout: out, stderr: errOut + (err ? `\n${err.message}` : ''), failed: !!err })))
    return {
      name,
      failed,
      stdout: stdout.trim(),
      requests: seen.map(s => `${s.method} ${s.authorization || '-'}`),
      notices: stderr.split(/\r?\n/).filter(l =>
        /tokenHelper|token-helper|ETOKENHELPER|Unknown|ENEEDAUTH|leaked/.test(l)),
    }
  }

  // Each check names the scenario and what must hold; a scenario that never
  // reached the registry fails rather than passing on an empty list.
  const checks = []
  const expect = (result, what, ok) => checks.push({ scenario: result.name, what, ok: !!ok })
  const auths = r => [...new Set(r.requests.map(x => x.split(' ').slice(1).join(' ')))]

  // handlers first, so an interrupt during the overlay itself is covered; on
  // Windows only Ctrl+C (SIGINT) and Ctrl+Break (SIGBREAK) reach a handler,
  // a forced termination cannot be intercepted at all
  let restore = null
  const onSignal = sig => {
    if (restore) {
      restore()
      restore = null
    }
    process.exit(128 + (os.constants.signals[sig] || 1))
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.once(sig, onSignal)
  }
  restore = overlay()

  try {
    const user = await run('user-config', { user: helperLine })
    expect(user, 'view succeeds', !user.failed && user.stdout === '1.0.0')
    expect(user, 'every request carries the helper token', user.requests.length && auths(user).join() === 'Bearer helper-token')
    expect(user, 'helper stderr reaches the user', user.notices.some(l => l.includes('helper says hello')))
    expect(user, 'a credential in stderr is masked', !user.notices.some(l => l.includes('leaked-in-stderr')))

    const project = await run('project-config', { project: helperLine })
    expect(project, 'view still reaches the registry', !project.failed && project.requests.length)
    expect(project, 'no credential is sent', auths(project).join() === '-')
    expect(project, 'the key is reported as ignored', project.notices.some(l => l.includes('Ignoring project config')))

    const redirect = await run('project-redirects-userconfig', {
      project: 'userconfig=<dir>/repo-user.npmrc\n',
      userconfigFlag: false,
    })
    expect(redirect, 'view still reaches the registry', !redirect.failed && redirect.requests.length)
    expect(redirect, 'the repository file supplies no credential', auths(redirect).join() === '-')
    expect(redirect, 'the helper is reported as ignored', redirect.notices.some(l => l.includes('selected by project config')))

    const stale = await run('helper-beats-stale-token', { user: `${helperLine}${nerf}:_authToken=stale\n` })
    expect(stale, 'the helper wins', stale.requests.length && auths(stale).join() === 'Bearer helper-token')

    const publish = await run('publish-with-helper-only', { args: ['publish'], user: helperLine })
    expect(publish, 'publish does not refuse with ENEEDAUTH', !publish.notices.some(l => l.includes('ENEEDAUTH')))
    expect(publish, 'the PUT carries the helper token', publish.requests.some(r => r === 'PUT Bearer helper-token'))

    const publishConfig = await run('publishConfig-helper', {
      args: ['publish'],
      user: `${nerf}:_authToken=real-token\n`,
      pkg: { publishConfig: { [`${nerf}:tokenHelper`]: helper } },
    })
    expect(publishConfig, 'the PUT carries the real token', publishConfig.requests.some(r => r === 'PUT Bearer real-token'))
    expect(publishConfig, 'no request carries the helper token', !publishConfig.requests.some(r => r.endsWith('helper-token')))
    expect(publishConfig, 'the key is reported as ignored', publishConfig.notices.some(l => l.includes('Ignoring publishConfig')))

    const login = await run('login-with-helper', { args: ['login', '--auth-type=web'], user: helperLine })
    expect(login, 'login refuses with ETOKENHELPER', login.failed && login.notices.some(l => l.includes('ETOKENHELPER')))
    expect(login, 'nothing is sent', login.requests.length === 0)
    expect(login, 'no token is saved', fs.readFileSync(path.join(root, login.name, 'user.npmrc'), 'utf8') === helperLine)

    const results = [user, project, redirect, stale, publish, publishConfig, login]
    console.log(JSON.stringify(results, null, 2))
    for (const c of checks) {
      console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.scenario}: ${c.what}`)
    }
    const ok = checks.every(c => c.ok)
    console.log(ok ? 'PASS' : 'FAIL')
    process.exitCode = ok && process.exitCode !== 1 ? 0 : 1
  } finally {
    if (restore) {
      restore()
      restore = null
    }
    server.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main()
