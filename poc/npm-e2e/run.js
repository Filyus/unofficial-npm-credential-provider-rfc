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
// two runs against one checkout would each back up the other's overlay, and
// the one restoring last would leave it in place
const lock = path.join(bundled, '..', '.token-helper-e2e.lock')

const overlay = () => {
  try {
    fs.mkdirSync(lock)
  } catch (er) {
    throw er.code === 'EEXIST'
      ? new Error(`another run is using ${npmCliDir} (remove ${lock} if none is)`)
      : er
  }
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
    fs.rmSync(lock, { recursive: true, force: true })
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
    // the helper's own token, in a form only scrub() can recognise
    "process.stderr.write('fetched helper-token from the keychain\\n')",
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
  // another host, for redirects and tarballs that lead away from the
  // registry; it listens on both stacks, as `localhost` may resolve to ::1
  const elsewhereSeen = []
  const elsewhere = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      elsewhereSeen.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ name: 'landed', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: 'landed', version: '1.0.0' } } }))
    })
  })
  await new Promise((resolve, reject) => elsewhere.once('error', reject).listen(0, '::', resolve))
    .catch(() => new Promise(resolve => elsewhere.listen(0, '127.0.0.1', resolve)))
  const otherPort = elsewhere.address().port
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null })
      res.setHeader('content-type', 'application/json')
      // a registry that rejects the credential and quotes it back
      if (req.url.startsWith('/echo')) {
        res.statusCode = 401
        return res.end(JSON.stringify({ error: `rejected: ${req.headers.authorization}` }))
      }
      // a registry that sends the client somewhere else: another host name,
      // or the same host on another port
      const redirects = {
        '/redirect-host': `http://localhost:${otherPort}/redirect-host`,
        '/redirect-port': `http://127.0.0.1:${otherPort}/redirect-port`,
      }
      const target = redirects[req.url.split('?')[0]]
      if (target) {
        res.statusCode = 302
        res.setHeader('location', target)
        return res.end()
      }
      // a package whose tarball lives on another host
      const foreign = { '/foreign-host': 'localhost', '/foreign-port': '127.0.0.1' }[req.url]
      if (foreign) {
        const name = req.url.slice(1)
        return res.end(JSON.stringify({
          name,
          'dist-tags': { latest: '1.0.0' },
          versions: { '1.0.0': { name, version: '1.0.0', dist: { tarball: `http://${foreign}:${otherPort}/${name}.tgz` } } },
        }))
      }
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

  const run = async (name, {
    args = ['view', 'demo', 'version'], user = '', project = '', pkg = {}, userconfigFlag = true, globalconfigFlag = true, env = {}, files = {},
  }) => {
    // the repository, and beside it the user's own files: npm does not trust
    // a user or global config file that lies inside the project
    const dir = path.join(root, name, 'repo')
    const home = path.join(root, name, 'home')
    fs.mkdirSync(dir, { recursive: true })
    fs.mkdirSync(home)
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.1', ...pkg }))
    fs.writeFileSync(path.join(home, 'user.npmrc'), user)
    fs.writeFileSync(path.join(dir, '.npmrc'), project.replaceAll('<dir>', dir))
    fs.writeFileSync(path.join(dir, 'repo-user.npmrc'), helperLine)
    // more files the repository carries, relative to it
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
      fs.writeFileSync(path.join(dir, name), content.replaceAll('<dir>', dir))
    }
    seen.length = 0
    elsewhereSeen.length = 0
    const { stdout, stderr, failed } = await new Promise(resolve => execFile(process.execPath, [
      path.join(npmCliDir, 'bin', 'npm-cli.js'), ...args,
      `--registry=${registry}`,
      // a --userconfig flag would outrank a project redirect, so the redirect
      // scenario leaves it out
      ...(userconfigFlag ? [`--userconfig=${path.join(home, 'user.npmrc')}`] : []),
      // a child npm gets this from its parent's environment instead, and a
      // prefix chooses it when there is none
      ...(env.npm_config_globalconfig || !globalconfigFlag ? [] : [`--globalconfig=${path.join(home, 'global.npmrc')}`]),
      `--cache=${path.join(home, 'cache')}`,
      '--prefer-online',
    ], { cwd: dir, timeout: 60000, env: { ...process.env, HOME: home, USERPROFILE: home, ...env } }, (err, out, errOut) =>
      resolve({ stdout: out, stderr: errOut + (err ? `\n${err.message}` : ''), failed: !!err })))
    return {
      name,
      failed,
      output: stdout + stderr,
      stdout: stdout.trim(),
      requests: seen.map(s => `${s.method} ${s.authorization || '-'}`),
      elsewhere: elsewhereSeen.map(s => `${s.method} ${s.url} ${s.authorization || "-"}`),
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
  const cleanUp = () => {
    if (restore) {
      restore()
      restore = null
    }
    server.close()
    elsewhere.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
  const onSignal = sig => {
    // process.exit() skips the finally below
    try {
      cleanUp()
    } finally {
      process.exit(128 + (os.constants.signals[sig] || 1))
    }
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.once(sig, onSignal)
  }

  try {
    restore = overlay()

    const user = await run('user-config', { user: helperLine })
    expect(user, 'view succeeds', !user.failed && user.stdout === '1.0.0')
    expect(user, 'every request carries the helper token', user.requests.length && auths(user).join() === 'Bearer helper-token')
    expect(user, 'helper stderr reaches the user', user.notices.some(l => l.includes('helper says hello')))
    expect(user, 'a credential in stderr is masked', !user.notices.some(l => l.includes('leaked-in-stderr')))
    expect(user, 'the helper token echoed on stderr is hidden', user.notices.some(l => l.includes('fetched *** from')) &&
      !user.notices.some(l => l.includes('helper-token')))

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

    // what a child npm started by a script in another repository sees: the
    // parent's globalconfig in the environment, the repository's in .npmrc
    const child = await run('child-project-globalconfig', {
      project: 'globalconfig=<dir>/repo-user.npmrc\n',
      env: { npm_config_globalconfig: path.join(root, 'parent-global.npmrc') },
    })
    expect(child, 'view still reaches the registry', !child.failed && child.requests.length)
    expect(child, 'the repository file supplies no credential', auths(child).join() === '-')
    expect(child, 'the helper is reported as ignored', child.notices.some(l => l.includes('selected by project config')))

    // the same through a real parent: npm runs a script that starts npm in a
    // directory with no .npmrc, which can only know that the userconfig it
    // inherits was chosen by the parent's project from the marker npm exports
    const elsewhere = path.join(root, 'elsewhere')
    fs.mkdirSync(elsewhere)
    const npmCli = path.join(npmCliDir, 'bin', 'npm-cli.js')
    const parent = await run('parent-runs-child', {
      args: ['run', 'child'],
      project: 'userconfig=<dir>/repo-user.npmrc\n',
      userconfigFlag: false,
      pkg: { scripts: { child: `cd "${elsewhere}" && "${process.execPath}" "${npmCli}" view demo version --registry=${registry}` } },
    })
    expect(parent, 'the child npm reaches the registry', !parent.failed && parent.requests.length)
    expect(parent, 'the repository file supplies no credential to it', auths(parent).join() === '-')

    // a repository's node-options would reach a node-based helper through
    // NODE_OPTIONS and could read the credential it prints
    const nodeOptions = await run('project-node-options', {
      user: helperLine,
      project: 'node-options=--require=<dir>/evil.js\n',
      files: {
        'evil.js': "if (/helper\\.js$/.test(process.argv[1] || '')) require('fs').writeFileSync(__dirname + '/pwned', '')\n",
      },
    })
    expect(nodeOptions, 'the helper token is still sent', nodeOptions.requests.length && auths(nodeOptions).join() === 'Bearer helper-token')
    expect(nodeOptions, 'the repository code never ran in the helper', !fs.existsSync(path.join(root, nodeOptions.name, 'repo', 'pwned')))

    // `npm --prefix client` makes client/etc/npmrc the global config file
    const prefix = await run('prefix-into-repository', {
      args: ['--prefix', 'client', 'view', 'demo', 'version'],
      globalconfigFlag: false,
      files: { 'client/package.json': '{}', 'client/etc/npmrc': helperLine },
    })
    expect(prefix, 'view still reaches the registry', !prefix.failed && prefix.requests.length)
    expect(prefix, 'the repository file supplies no credential', auths(prefix).join() === '-')
    expect(prefix, 'the helper is reported as ignored', prefix.notices.some(l => l.includes('is inside the project')))

    // The helper's token and its encodings, searched for in everything npm
    // left behind: what it printed, its debug log and timing file, and its
    // HTTP cache. A registry that quotes the rejected credential back in a
    // 401 body is compared with a stored _authToken, so that what npm does
    // with any credential is not counted against the helper.
    const encodings = token => [token, Buffer.from(token).toString('base64'), encodeURIComponent(`Bearer ${token}`)]
    const leaks = (result, token) => {
      const home = path.join(root, result.name, 'home')
      const found = new Set()
      const search = (where, text) => {
        for (const form of encodings(token)) {
          if (text.includes(form)) {
            found.add(where)
          }
        }
      }
      search('output', result.output)
      const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(file)
        } else if (entry.name !== 'user.npmrc') {
          search(path.relative(home, file).split(path.sep).slice(0, 2).join('/'), fs.readFileSync(file, 'latin1'))
        }
      })
      walk(home)
      return [...found]
    }
    const silly = ['--loglevel=silly', '--timing']
    const canaries = []
    for (const [args, what] of [
      [['view', 'demo', 'version', ...silly], 'view'],
      [['publish', ...silly], 'publish'],
      [['whoami', ...silly], 'whoami'],
    ]) {
      canaries.push(await run(`canary-${what}`, { args, user: helperLine }))
    }
    for (const canary of canaries) {
      const found = leaks(canary, 'helper-token')
      expect(canary, 'the helper token reached the registry', canary.requests.some(r => r.endsWith('Bearer helper-token')))
      expect(canary, `and nowhere else: output, logs, timing, cache${found.length ? ` (found in ${found.join(', ')})` : ''}`,
        found.length === 0)
    }
    const echoHelper = await run('echo-401-helper', { args: ['view', 'echo-pkg', ...silly], user: helperLine })
    const echoToken = await run('echo-401-token', {
      args: ['view', 'echo-pkg', ...silly], user: `${nerf}:_authToken=helper-token\n`,
    })
    const helperLeaks = leaks(echoHelper, 'helper-token')
    const tokenLeaks = leaks(echoToken, 'helper-token')
    expect(echoHelper, `a 401 that quotes the credential leaks no more than a stored token does ` +
      `(helper: ${helperLeaks.join(', ') || 'nowhere'}; _authToken: ${tokenLeaks.join(', ') || 'nowhere'})`,
    helperLeaks.every(where => tokenLeaks.includes(where)))

    // A registry that sends npm elsewhere: whatever reaches the other host is
    // compared with what a stored _authToken would send there. A different
    // host name must get no credential; the same host on another port gets
    // what a stored token gets (scheme and port are not compared).
    const hostile = []
    for (const [what, args, mustBeBare] of [
      ['redirect-host', ['view', 'redirect-host', 'version'], true],
      ['redirect-port', ['view', 'redirect-port', 'version'], false],
      ['foreign-host', ['cache', 'add', 'foreign-host@1.0.0'], true],
      ['foreign-port', ['cache', 'add', 'foreign-port@1.0.0'], true],
    ]) {
      const viaHelper = await run(`${what}-helper`, { args, user: helperLine })
      const viaToken = await run(`${what}-token`, { args, user: `${nerf}:_authToken=helper-token\n` })
      hostile.push(viaHelper, viaToken)
      const sent = r => r.elsewhere.filter(line => line.endsWith('Bearer helper-token'))
      expect(viaHelper, 'the request reached the other host', viaHelper.elsewhere.length > 0)
      expect(viaHelper, `it carries no more than a stored token would (helper: ${sent(viaHelper).length}, ` +
        `_authToken: ${sent(viaToken).length})`, sent(viaHelper).length <= sent(viaToken).length)
      if (mustBeBare) {
        expect(viaHelper, 'and no credential at all', sent(viaHelper).length === 0)
      }
    }

    const login = await run('login-with-helper', { args: ['login', '--auth-type=web'], user: helperLine })
    expect(login, 'login refuses with ETOKENHELPER', login.failed && login.notices.some(l => l.includes('ETOKENHELPER')))
    expect(login, 'nothing is sent', login.requests.length === 0)
    expect(login, 'no token is saved', fs.readFileSync(path.join(root, login.name, 'home', 'user.npmrc'), 'utf8') === helperLine)

    const results = [user, project, redirect, stale, publish, publishConfig, child, parent, nodeOptions, prefix, ...canaries, echoHelper, echoToken, ...hostile, login]
    console.log(JSON.stringify(results.map(({ output, ...rest }) => rest), null, 2))
    for (const c of checks) {
      console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.scenario}: ${c.what}`)
    }
    const ok = checks.every(c => c.ok)
    console.log(ok ? 'PASS' : 'FAIL')
    process.exitCode = ok && process.exitCode !== 1 ? 0 : 1
  } finally {
    cleanUp()
  }
}

main()
