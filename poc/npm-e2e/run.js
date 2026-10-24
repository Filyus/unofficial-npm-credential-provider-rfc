'use strict'

// End-to-end check of the Phase 1a `tokenHelper` prototype: a real npm, from a
// local npm/cli checkout with the prototype npm-registry-fetch laid over its
// bundled copy (the `getAuthorization` seam), against a local registry that
// records every request and the Authorization header it carried.
//
//   node poc/npm-e2e/run.js <npm-cli checkout> <npm-registry-fetch checkout>
//
// Both checkouts must carry the prototype's commits (the `token-helper` branches, or the
// patches of poc/patches applied, as CI does). The overlay is
// undone before the script exits, including on Ctrl+C.

const { execFile, execFileSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const [npmCliDir, fetchDir] = process.argv.slice(2).map(p => path.resolve(p))
if (!npmCliDir || !fetchDir) {
  console.error('usage: node poc/npm-e2e/run.js <npm-cli checkout> <npm-registry-fetch checkout>')
  process.exit(2)
}

const OVERLAY = ['auth.js', 'index.js']
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
// including its own token, so quoting, stderr forwarding and masking are all
// exercised. `js` is the body of the node script the helper starts.
const HELPER_JS = [
  "process.stderr.write('helper says hello\\n')",
  // the helper's own token, which npm hides wherever it appears
  "process.stderr.write('fetched helper-token from the keychain\\n')",
  "process.stdout.write('helper-token\\n')",
].join('\n')
const writeHelper = (root, name = 'helper', js = HELPER_JS) => {
  const dir = path.join(root, 'token helpers')
  fs.mkdirSync(dir, { recursive: true })
  const script = path.join(dir, `${name}.js`)
  fs.writeFileSync(script, js)
  if (process.platform === 'win32') {
    const helper = path.join(dir, `${name}.cmd`)
    fs.writeFileSync(helper, `@"${process.execPath}" "${script}"\r\n`)
    return helper
  }
  // a shell wrapper, so a node path with spaces cannot break a shebang
  const helper = path.join(dir, name)
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
  const handle = (req, res) => {
    req.resume()
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null })
      res.setHeader('content-type', 'application/json')
      // trusted publishing: the id token is exchanged for a token
      if (req.url.startsWith('/-/npm/v1/oidc/token/exchange/')) {
        return res.end(JSON.stringify({ token: 'oidc-token' }))
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
  }
  const server = http.createServer(handle)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  // the same registry on an address of this machine that is not a loopback
  // one; a machine with no such address skips the checks that need it
  const lanAddress = Object.values(os.networkInterfaces()).flat()
    .find(i => i && i.family === 'IPv4' && !i.internal)?.address
  const lan = lanAddress && http.createServer(handle)
  if (lan) {
    await new Promise(resolve => lan.listen(0, lanAddress, resolve))
  }
  // a proxy a repository's .npmrc names: it records what it is asked to
  // forward and refuses
  const proxySeen = []
  const proxy = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      proxySeen.push({ method: req.method, url: req.url, authorization: req.headers.authorization || null })
      res.statusCode = 502
      res.end('refused')
    })
  })
  proxy.on('connect', (req, socket) => {
    proxySeen.push({ method: 'CONNECT', url: req.url, authorization: req.headers['proxy-authorization'] || null })
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`
  const { port } = server.address()
  const registry = `http://127.0.0.1:${port}/`
  const nerf = `//127.0.0.1:${port}/`
  const helper = writeHelper(root)
  const helperLine = `${nerf}:tokenHelper=${helper}\n`
  const npmCli = path.join(npmCliDir, 'bin', 'npm-cli.js')
  // A helper that leaves a file behind when it starts, for the checks whose
  // point is that a helper did not run: an absent file proves nothing unless
  // the same helper is seen to leave it where it does run. One per scenario.
  const markedHelper = (name, regKey = nerf) => {
    const marker = path.join(root, 'ran', name)
    fs.mkdirSync(path.dirname(marker), { recursive: true })
    const script = writeHelper(root, `marked-${name}`, [
      `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`,
      "process.stdout.write('helper-token\\n')",
    ].join('\n'))
    return { line: `${regKey}:tokenHelper=${script}\n`, ran: () => fs.existsSync(marker) }
  }

  const allResults = []

  // `<dir>` is the repository and `<home>` the user's home in every value a
  // scenario gives; `<root>/<name>` holds both, and `<outside>` is a directory
  // beside them that belongs to neither
  const run = async (name, {
    args = ['view', 'demo', 'version'], registryUrl = registry, user = '', project = '', pkg = {}, userconfigFlag = true, globalconfigFlag = true, env = {}, files = {}, homeFiles = {}, outsideFiles = {},
    // false: a repository root that holds no package.json; cwd: where npm starts, inside the repository
    packageJson = true, cwd = '',
  }) => {
    // the repository, and beside it the user's own files
    const dir = path.join(root, name, 'repo')
    const home = path.join(root, name, 'home')
    const outside = path.join(root, name, 'outside')
    const fill = text => text.replaceAll('<dir>', dir).replaceAll('<home>', home).replaceAll('<outside>', outside)
    fs.mkdirSync(dir, { recursive: true })
    fs.mkdirSync(home)
    if (packageJson) {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.1', ...pkg }))
    }
    fs.writeFileSync(path.join(home, 'user.npmrc'), fill(user))
    fs.writeFileSync(path.join(dir, '.npmrc'), fill(project))
    fs.writeFileSync(path.join(dir, 'repo-user.npmrc'), helperLine)
    // more files the repository carries, relative to it; the user's, relative to home
    for (const [where, list] of [[dir, files], [home, homeFiles], [outside, outsideFiles]]) {
      for (const [file, content] of Object.entries(list)) {
        fs.mkdirSync(path.dirname(path.join(where, file)), { recursive: true })
        fs.writeFileSync(path.join(where, file), fill(content))
      }
    }
    seen.length = 0
    elsewhereSeen.length = 0
    proxySeen.length = 0
    const { stdout, stderr, failed, code } = await new Promise(resolve => execFile(process.execPath, [
      npmCli, ...args,
      `--registry=${registryUrl}`,
      // a --userconfig flag would outrank a project redirect, so the redirect
      // scenarios leave it out
      ...(userconfigFlag ? [`--userconfig=${path.join(home, 'user.npmrc')}`] : []),
      // a child npm gets this from its parent's environment instead
      ...(env.npm_config_globalconfig || !globalconfigFlag ? [] : [`--globalconfig=${path.join(home, 'global.npmrc')}`]),
      `--cache=${path.join(home, 'cache')}`,
      '--prefer-online',
      // a helper that works shows its stderr at this level
      '--loglevel=verbose',
    ], { cwd: path.join(dir, cwd), timeout: 60000, env: { ...process.env, HOME: home, USERPROFILE: home, ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, fill(v)])) } }, (err, out, errOut) =>
      resolve({ stdout: out, stderr: errOut + (err ? `\n${err.message}` : ''), failed: !!err, code: err ? err.code : 0 })))
    // E2E_SHOW=<scenario name> prints everything npm said in that scenario
    if (process.env.E2E_SHOW === name) {
      console.log(`--- ${name}\n${stdout}${stderr}\n---`)
    }
    const result = {
      name,
      failed,
      code,
      output: stdout + stderr,
      stdout: stdout.trim(),
      // the weekly check for a newer npm asks the registry for the packument of
      // `npm`; it is kept apart, and no scenario's request count includes it
      requests: seen.filter(s => s.url !== '/npm').map(s => `${s.method} ${s.authorization || '-'}`),
      updateCheck: [...seen.filter(s => s.url === '/npm'), ...proxySeen.filter(s => s.url.endsWith('/npm'))]
        .map(s => s.authorization || '-'),
      proxy: proxySeen.filter(s => !s.url.endsWith('/npm')).map(s => `${s.method} ${s.url} ${s.authorization || '-'}`),
      elsewhere: elsewhereSeen.map(s => `${s.method} ${s.url} ${s.authorization || "-"}`),
      notices: stderr.split(/\r?\n/).filter(l =>
        /tokenHelper|token-helper|ETOKENHELPER|ENEEDAUTH|Ignoring|helper says|helper-token/.test(l)),
    }
    allResults.push(result)
    return result
  }

  // Each check names the scenario and what must hold; a scenario that never
  // reached the registry fails rather than passing on an empty list.
  const checks = []
  const notes = []
  const expect = (result, what, ok) => checks.push({ scenario: result.name, what, ok: !!ok })
  const auths = r => [...new Set(r.requests.map(x => x.split(' ').slice(1).join(' ')))]

  // handlers first, so an interrupt during the overlay itself is covered; on
  // Windows only Ctrl+C (SIGINT) and Ctrl+Break (SIGBREAK) reach a handler
  let restore = null
  const cleanUp = () => {
    if (restore) {
      restore()
      restore = null
    }
    server.close()
    lan?.close()
    proxy.close()
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
    expect(redirect, 'the helper is reported as ignored', redirect.notices.some(l => l.includes('project config sets userconfig')))

    // a project `prefix=` chooses the global file and nothing else: the user's
    // file keeps its helper, and its own route setting is not the project's
    const prefixed = await run('project-prefix-leaves-the-user-file', {
      user: `${helperLine}strict-ssl=false\n`,
      project: 'prefix=<dir>/prefix\n',
    })
    expect(prefixed, 'view succeeds', !prefixed.failed && prefixed.stdout === '1.0.0')
    expect(prefixed, 'the helper in the user file supplies the credential', prefixed.requests.length && auths(prefixed).join() === 'Bearer helper-token')
    expect(prefixed, 'the user file is not reported as ignored', !prefixed.notices.some(l => l.includes('project config sets')))

    const stale = await run('helper-beats-stale-token', { user: `${helperLine}${nerf}:_authToken=stale\n` })
    expect(stale, 'the helper wins', stale.requests.length && auths(stale).join() === 'Bearer helper-token')
    expect(stale, 'npm warns once, naming the _authToken it ignores',
      stale.notices.filter(l => l.includes(`${nerf}:_authToken`) && l.includes('ignored')).length === 1)

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

    // trusted publishing: the exchange for an OIDC token is made with the id
    // token, and the publish that follows carries the token it returned; the
    // helper is not used for either
    const oidc = await run('oidc-beats-helper', {
      args: ['publish'],
      user: `${helperLine}${nerf}:_authToken=stored\n`,
      env: { GITLAB_CI: 'true', NPM_ID_TOKEN: 'id-token' },
    })
    expect(oidc, 'the exchange carries the id token', oidc.requests.includes('POST Bearer id-token'))
    expect(oidc, 'the PUT carries the OIDC token', oidc.requests.includes('PUT Bearer oidc-token'))
    expect(oidc, 'no request carries the helper token', !oidc.requests.some(r => r.endsWith('helper-token')))

    // a helper that fails is npm's error, with npm's own exit status, and no
    // other credential is tried
    const failing = writeHelper(root, 'failing', "process.stderr.write('no keychain today\\n')\nprocess.exit(3)")
    const failed = await run('failing-helper', {
      user: `${nerf}:tokenHelper=${failing}\n${nerf}:_authToken=stored\n`,
    })
    expect(failed, 'view fails with ETOKENHELPER', failed.failed && failed.output.includes('ETOKENHELPER') && failed.output.includes('exited with status 3'))
    expect(failed, 'npm exits with its own status, 1, not the helper\'s 3', failed.code === 1)
    expect(failed, 'the helper\'s stderr is a warning', failed.output.split(/\r?\n/).some(l => /warn token-helper no keychain today/.test(l)))
    expect(failed, 'no request is sent, with the stored token or without', failed.requests.length === 0)

    // a helper that runs npm itself: that npm sees the guard and fails with
    // ETOKENHELPER instead of running a helper, so nothing loops and nothing
    // is sent from it
    const nestedConfig = path.join(root, 'nested-user.npmrc')
    const nested = writeHelper(root, 'nested', [
      "const { spawnSync } = require('child_process')",
      `const r = spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(npmCli)}, 'view', 'demo', 'version',`,
      `  ${JSON.stringify(`--registry=${registry}`)}, ${JSON.stringify(`--userconfig=${nestedConfig}`)},`,
      `  ${JSON.stringify(`--globalconfig=${nestedConfig}.global`)}, ${JSON.stringify(`--cache=${nestedConfig}.cache`)}],`,
      "  { env: process.env, encoding: 'utf8', timeout: 20000 })",
      "process.stderr.write('nested npm exited ' + r.status + ' ' + (/ETOKENHELPER/.test(r.stderr) && /own npm cannot run a token helper/.test(r.stderr) ? 'with ETOKENHELPER' : 'otherwise') + '\\n')",
      "process.stdout.write('helper-token\\n')",
    ].join('\n'))
    fs.writeFileSync(nestedConfig, `${nerf}:tokenHelper=${nested}\n`)
    const recursion = await run('recursion-guard', { user: `${nerf}:tokenHelper=${nested}\n` })
    expect(recursion, 'view succeeds with the helper token', !recursion.failed && recursion.requests.at(-1) === 'GET Bearer helper-token')
    // the control is the same `view` with a helper that runs no npm: how many
    // requests a view makes is npm's business, not this check's
    expect(recursion, 'the helper\'s own npm sent nothing', user.requests.length > 0 && recursion.requests.length === user.requests.length)
    expect(recursion, 'and failed with ETOKENHELPER, saying a token helper\'s own npm cannot run one',
      recursion.output.includes('nested npm exited 1 with ETOKENHELPER'))

    const elsewhereDir = path.join(root, 'elsewhere')
    fs.mkdirSync(elsewhereDir)
    // a user or global file whose path the command line or the environment
    // chose, and that lies inside the repository: `npm ci --prefix sub` makes
    // sub/etc/npmrc the global file, a CI job writes
    // NPM_CONFIG_USERCONFIG=$CI_PROJECT_DIR/.npmrc. The repository can have
    // written either, so neither supplies a helper. (`view` stands for the
    // command: an install of a project with no dependencies sends no request,
    // and the config rule is the same for every command.)
    const insideRepo = []
    for (const [name, options] of [
      ['prefix-sub-global-file', {
        args: ['view', 'demo', 'version', '--prefix', 'sub'],
        globalconfigFlag: false,
        files: { 'sub/etc/npmrc': helperLine, 'sub/package.json': '{}' },
      }],
      ['env-userconfig-into-the-checkout', {
        userconfigFlag: false,
        env: { NPM_CONFIG_USERCONFIG: '<dir>/repo-user.npmrc' },
      }],
      ['env-prefix-into-the-checkout', {
        globalconfigFlag: false,
        env: { NPM_CONFIG_PREFIX: '<dir>/sub' },
        files: { 'sub/etc/npmrc': helperLine },
      }],
      // the common CI shape: the install runs for a subdirectory, from the root
      // of the repository, with the user file at the root
      ['prefix-client-env-userconfig-at-root', {
        args: ['view', 'demo', 'version', '--prefix', 'client'],
        userconfigFlag: false,
        env: { NPM_CONFIG_USERCONFIG: '<dir>/repo-user.npmrc' },
        files: { 'client/package.json': '{}' },
      }],
      ['userconfig-flag-into-the-checkout', {
        args: ['view', 'demo', 'version', '--userconfig', 'repo-user.npmrc'],
        userconfigFlag: false,
      }],
    ]) {
      const result = await run(name, options)
      insideRepo.push(result)
      expect(result, 'view still reaches the registry', !result.failed && result.requests.length > 0)
      expect(result, 'the repository file supplies no credential', auths(result).join() === '-')
      expect(result, 'the helper is reported as ignored, with the reason: the directory that holds a package.json',
        result.notices.some(l => l.includes('chosen on the command line or in the environment and lies inside') &&
          l.includes('which holds package.json')))
    }

    // The same rule from the file's side: the file's own directory and each one
    // above it, up to home (never looked at) or, for a file outside home, the
    // filesystem root. Each refusal is set beside the same layout with the
    // mark taken away: that one must run its helper, which also proves that
    // the file a refused helper did not leave is where a run leaves it.
    const located = []
    const pair = async (name, mark, build) => {
      const held = markedHelper(name)
      const free = markedHelper(`${name}-without-the-mark`)
      const refusedRun = await run(name, build(held.line, true))
      const freeRun = await run(`${name}-without-the-mark`, build(free.line, false))
      located.push(refusedRun, freeRun)
      expect(refusedRun, 'view still reaches the registry', !refusedRun.failed && refusedRun.requests.length > 0)
      expect(refusedRun, 'the file supplies no credential, and its helper was not run', auths(refusedRun).join() === '-' && !held.ran())
      expect(refusedRun, `the warning names the directory and what it holds (${mark})`,
        refusedRun.notices.some(l => l.includes('lies inside') && l.includes(`which holds ${mark}`)))
      expect(freeRun, `control: the same layout without the ${mark} is the user's, its helper runs and its token is sent`,
        !freeRun.failed && free.ran() && auths(freeRun).join() === 'Bearer helper-token')
    }
    const ci = { userconfigFlag: false, env: { NPM_CONFIG_USERCONFIG: '<dir>/ci.npmrc' } }
    // a repository root with a .git and no package.json, the file at the root, npm run from a package below
    await pair('located-git-root', '.git', (line, mark) => ({
      ...ci, packageJson: false, cwd: 'pkg',
      files: { 'ci.npmrc': line, 'pkg/package.json': '{}', ...(mark ? { '.git/HEAD': 'ref: refs/heads/main\n' } : {}) },
    }))
    // a worktree or a submodule has a .git that is a file
    await pair('located-git-file', '.git', (line, mark) => ({
      ...ci, packageJson: false, cwd: 'pkg',
      files: { 'ci.npmrc': line, 'pkg/package.json': '{}', ...(mark ? { '.git': 'gitdir: ../main/.git/worktrees/w\n' } : {}) },
    }))
    // a project's `location=global` does not switch the rule off
    await pair('located-location-global', 'package.json', (line, mark) => ({
      ...ci, packageJson: mark, project: 'location=global\n', files: { 'ci.npmrc': line },
    }))
    // below home, one directory down: the walk looks at it, and stops at home itself
    await pair('located-below-home', 'package.json', (line, mark) => ({
      userconfigFlag: false, env: { NPM_CONFIG_USERCONFIG: '<home>/cfg/x.npmrc' },
      homeFiles: { 'cfg/x.npmrc': line, ...(mark ? { 'cfg/package.json': '{}' } : {}) },
    }))
    // a git-managed dotfiles directory below home is refused, the false refusal the limits name
    await pair('located-dotfiles-git', '.git', (line, mark) => ({
      userconfigFlag: false, env: { NPM_CONFIG_USERCONFIG: '<home>/.config/npm/npmrc' },
      homeFiles: { '.config/npm/npmrc': line, ...(mark ? { '.config/.git/HEAD': 'ref: refs/heads/main\n' } : {}) },
    }))
    // a file outside home, with no repository around it, is the user's: the walk goes up to the root
    await pair('located-outside-home', 'package.json', (line, mark) => ({
      userconfigFlag: false, env: { NPM_CONFIG_USERCONFIG: '<outside>/x.npmrc' },
      outsideFiles: { 'x.npmrc': line, ...(mark ? { 'package.json': '{}' } : {}) },
    }))
    // home itself is never looked at: a package.json there does not make the user's file a project's
    const homeMarked = markedHelper('located-home-with-package-json')
    const homeRun = await run('located-home-with-package-json', {
      user: homeMarked.line, homeFiles: { 'package.json': '{}', '.git/HEAD': 'ref: refs/heads/main\n' },
      userconfigFlag: false, env: { NPM_CONFIG_USERCONFIG: '<home>/user.npmrc' },
    })
    located.push(homeRun)
    expect(homeRun, 'a file chosen in a home that holds a package.json and a .git is the user\'s: its helper runs',
      !homeRun.failed && homeMarked.ran() && auths(homeRun).join() === 'Bearer helper-token')

    // A user file that was refused (the project chose it, or it lies in the
    // checkout) names no global file: its `globalconfig=` is the repository's
    // word as much as the file is, so the global file it names is untrusted
    // too, though that file lies where nothing marks it. A repository alone is
    // enough: its .npmrc chooses u.npmrc, which names g.npmrc, which holds the
    // helper. The control is the user's own file, given the usual way, naming a
    // global file outside the repository: the helper runs.
    const chain = { userconfigFlag: false, globalconfigFlag: false }
    const named = markedHelper('user-file-names-global')
    const namedRun = await run('user-file-names-global', {
      ...chain, project: 'userconfig=<dir>/u.npmrc\n',
      files: { 'u.npmrc': 'globalconfig=<dir>/g.npmrc\n', 'g.npmrc': named.line },
    })
    const namedControl = markedHelper('user-file-names-global-control')
    const namedControlRun = await run('user-file-names-global-control', {
      globalconfigFlag: false, user: 'globalconfig=<outside>/g.npmrc\n', outsideFiles: { 'g.npmrc': namedControl.line },
    })
    // CI pointing a file in the checkout, the environment form of the same chain
    const namedEnv = markedHelper('user-file-names-global-env')
    const namedEnvRun = await run('user-file-names-global-env', {
      ...chain, env: { NPM_CONFIG_USERCONFIG: '<dir>/u.npmrc' },
      files: { 'u.npmrc': 'globalconfig=<dir>/g.npmrc\n', 'g.npmrc': namedEnv.line },
    })
    located.push(namedRun, namedControlRun, namedEnvRun)
    for (const [result, marked, what] of [
      [namedRun, named, 'a user file the project chose'],
      [namedEnvRun, namedEnv, 'a user file the environment put inside the checkout'],
    ]) {
      expect(result, 'view still reaches the registry', !result.failed && result.requests.length > 0)
      expect(result, `the global file that ${what} names supplies no credential, and its helper was not run`,
        auths(result).join() === '-' && !marked.ran())
      expect(result, 'the global config is reported as ignored, because the user file that names it is not the user\'s own',
        result.notices.some(l => l.includes('Ignoring global config') && l.includes('sets globalconfig')))
    }
    expect(namedControlRun, 'control: the global file that the user\'s own file names, outside the repository, is the user\'s: its helper runs and its token is sent',
      !namedControlRun.failed && namedControl.ran() && auths(namedControlRun).join() === 'Bearer helper-token')

    // DESTDIR moves npm's default global prefix on Unix (/usr/local becomes
    // $DESTDIR/usr/local), so a repository that holds the file at that path
    // and is the DESTDIR makes it the global file. The path comes from this
    // node's own prefix, as npm computes it. The control is the helper in the
    // global file the harness uses everywhere else, with no DESTDIR.
    if (process.platform === 'win32') {
      notes.push('DESTDIR is only used on Unix: the destdir-into-the-checkout checks were skipped')
    } else {
      const destdir = markedHelper('destdir-into-the-checkout')
      const destdirFile = path.join(path.dirname(path.dirname(process.execPath)), 'etc', 'npmrc')
      const destdirRun = await run('destdir-into-the-checkout', {
        globalconfigFlag: false, env: { DESTDIR: '<dir>' }, files: { [destdirFile]: destdir.line },
      })
      const destdirControl = markedHelper('destdir-into-the-checkout-control')
      const destdirControlRun = await run('destdir-into-the-checkout-control', {
        homeFiles: { 'global.npmrc': destdirControl.line },
      })
      located.push(destdirRun, destdirControlRun)
      expect(destdirRun, 'view still reaches the registry', !destdirRun.failed && destdirRun.requests.length > 0)
      expect(destdirRun, 'a DESTDIR that is the checkout makes its global file the repository\'s: no credential is sent, and its helper was not run',
        auths(destdirRun).join() === '-' && !destdir.ran())
      expect(destdirControlRun, 'control: the same helper in the global file the user gave, with no DESTDIR, runs and its token is sent',
        !destdirControlRun.failed && destdirControl.ran() && auths(destdirControlRun).join() === 'Bearer helper-token')
    }

    // a value that is not an existing file is never printed, whichever message it is in
    const pasted = '/9j/4AAQSkZJRgABAQAAAQABAAD+AbCdEfGh=='
    const pastedToken = await run('pasted-token-is-not-shown', { user: `${nerf}:tokenHelper=${pasted}\n` })
    expect(pastedToken, 'view fails with ETOKENHELPER', pastedToken.failed && pastedToken.output.includes('ETOKENHELPER'))
    expect(pastedToken, 'the message names the key and says the value is not shown', pastedToken.output.includes('(the value is not shown)'))
    expect(pastedToken, 'nothing of the value is printed anywhere', !pastedToken.output.includes('4AAQSkZJRg') && !pastedToken.output.includes('AbCdEfGh'))
    const pastedLogin = await run('pasted-token-login', { args: ['login', '--auth-type=web'], user: `${nerf}:tokenHelper=${pasted}\n` })
    expect(pastedLogin, 'login refuses without printing it', pastedLogin.failed && pastedLogin.output.includes('(the value is not shown)') && !pastedLogin.output.includes('4AAQSkZJRg'))

    // NODE_ENV and COLOR are not taken out of a helper's environment: neither
    // carries code or a credential into it, so the helper of a nested npm gets
    // them as its npm has them (and NODE_ENV is production here because the
    // parent was run with --omit=dev)
    const probe = writeHelper(root, 'probe', [
      "process.stderr.write('probe NODE_ENV=' + process.env.NODE_ENV + ' COLOR=' + process.env.COLOR + '\\n')",
      "process.stdout.write('helper-token\\n')",
    ].join('\n'))
    const probeUser = path.join(root, 'probe-user.npmrc')
    fs.writeFileSync(probeUser, `${nerf}:tokenHelper=${probe}\n`)
    const probed = await run('nested-node-env-and-color', {
      args: ['run', 'child', '--omit=dev'],
      pkg: { scripts: { child: `cd "${elsewhereDir}" && "${process.execPath}" "${npmCli}" view demo version --registry=${registry} --userconfig="${probeUser}" --globalconfig="${probeUser}.global" --cache="${probeUser}.cache" --loglevel=verbose` } },
    })
    expect(probed, 'the helper of the nested npm ran', probed.output.includes('probe NODE_ENV='))
    expect(probed, 'and got the NODE_ENV and the COLOR its environment holds, which npm does not remove', /probe NODE_ENV=production COLOR=\S+/.test(probed.output) &&
      !probed.output.includes('COLOR=undefined'))

    // what a child npm started by a script in another repository sees: the
    // parent's globalconfig in the environment, the repository's in .npmrc
    const child = await run('child-project-globalconfig', {
      project: 'globalconfig=<dir>/repo-user.npmrc\n',
      env: { npm_config_globalconfig: path.join(root, 'parent-global.npmrc') },
    })
    expect(child, 'view still reaches the registry', !child.failed && child.requests.length)
    expect(child, 'the repository file supplies no credential', auths(child).join() === '-')
    expect(child, 'the helper is reported as ignored', child.notices.some(l => l.includes('project config sets globalconfig')))

    // the same through a real parent: npm runs a script that starts npm in a
    // directory with no .npmrc. The userconfig it inherits is an environment
    // value that names a file in the repository, which the location rule
    // refuses for the child as it does for the parent
    const parent = await run('parent-runs-child', {
      args: ['run', 'child'],
      project: 'userconfig=<dir>/repo-user.npmrc\n',
      userconfigFlag: false,
      pkg: { scripts: { child: `cd "${elsewhereDir}" && "${process.execPath}" "${npmCli}" view demo version --registry=${registry}` } },
    })
    expect(parent, 'the child npm reaches the registry', !parent.failed && parent.requests.length)
    expect(parent, 'the repository file supplies no credential to it', auths(parent).join() === '-')

    // Other ways a repository's scripts start npm. A child that stays in the
    // project is refused: it reads the project's own .npmrc, which sets
    // userconfig for it as well.
    const childScript = (cwd) => [
      "const { spawnSync } = require('child_process')",
      'const env = { ...process.env }',
      `spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(npmCli)}, 'view', 'demo', 'version', ` +
        `${JSON.stringify(`--registry=${registry}`)}], { cwd: ${cwd}, env, stdio: 'inherit' })`,
    ].join('\n')
    const chosenUserconfig = { project: 'userconfig=<dir>/repo-user.npmrc\n', userconfigFlag: false }
    const children = []
    for (const [name, options] of [
      ['child-in-the-repository', {
        args: ['run', 'child'],
        pkg: { scripts: { child: `"${process.execPath}" child.js` } },
        files: { 'child.js': childScript('__dirname') },
      }],
      ['child-of-npm-exec', {
        args: ['exec', '-c', `"${process.execPath}" child.js`],
        files: { 'child.js': childScript('__dirname') },
      }],
      ['child-of-a-workspace-script', {
        args: ['run', 'child', '--workspace', 'a'],
        pkg: { workspaces: ['packages/*'] },
        files: {
          'packages/a/package.json': JSON.stringify({ name: 'a', version: '1.0.0', scripts: { child: `"${process.execPath}" child.js` } }),
          'packages/a/child.js': childScript('__dirname'),
        },
      }],
    ]) {
      const result = await run(name, { ...chosenUserconfig, ...options })
      children.push(result)
      expect(result, 'the child npm reaches the registry', result.requests.length > 0)
      expect(result, 'the repository file supplies no credential to it', auths(result).join() === '-')
    }
    // A child that leaves the project is refused as well when the file the
    // repository's userconfig names lies in the repository: the child sees an
    // environment value that names a file the location rule marks.
    const outside = await run('child-outside-the-project-file-in-the-repository', {
      ...chosenUserconfig,
      args: ['run', 'child'],
      pkg: { scripts: { child: `"${process.execPath}" child.js` } },
      files: { 'child.js': childScript(JSON.stringify(elsewhereDir)) },
    })
    children.push(outside)
    expect(outside, 'a child that starts npm outside the project reaches the registry', outside.requests.length > 0)
    expect(outside, 'and gets no credential from the repository file: it lies in the repository, which the location rule sees from the file', auths(outside).join() === '-')

    // A project whose `userconfig` names a file that is not in the repository.
    // A child that stays in the project reads the same `userconfig=` and refuses
    // the file. A child that leaves the project sees only an environment value
    // for a file no mark surrounds; the parent, which refused the file, names it
    // in npm_config_token_helper_untrusted and the child refuses it too (this was
    // a limit while that marker was retired). The helpers leave a file when they
    // run, so that "not run" is seen against a run of the same helper
    // (child-route-control).
    const picked = { project: 'userconfig=<outside>/picked.npmrc\n', userconfigFlag: false }
    const pickedScripts = cwd => ({
      args: ['run', 'child'],
      pkg: { scripts: { child: `"${process.execPath}" child.js` } },
      files: { 'child.js': childScript(cwd) },
    })
    const markedKept = markedHelper('picked-kept')
    const pickedKept = await run('project-picked-file-outside', {
      ...picked, ...pickedScripts('__dirname'), outsideFiles: { 'picked.npmrc': markedKept.line },
    })
    children.push(pickedKept)
    expect(pickedKept, 'the child npm reaches the registry', pickedKept.requests.length > 0)
    expect(pickedKept, 'the helper of a file the project chose is not run in a child that stays in the project, though the file is outside the repository', !markedKept.ran() && auths(pickedKept).join() === '-')
    const markedAway = markedHelper('picked-away')
    const pickedAway = await run('project-picked-file-outside-child-leaves', {
      ...picked, ...pickedScripts(JSON.stringify(elsewhereDir)), outsideFiles: { 'picked.npmrc': markedAway.line },
    })
    children.push(pickedAway)
    expect(pickedAway, 'the child that starts npm outside the project reaches the registry', pickedAway.requests.length > 0)
    expect(pickedAway, 'and does not run the helper of a file outside the repository that the project chose: the parent refused it and said so in the environment', !markedAway.ran() && auths(pickedAway).join() === '-')

    // a repository's node-options would reach a node-based helper through
    // NODE_OPTIONS and could read the credential it prints
    const evil = "if (/helper\\.js$/.test(process.argv[1] || '')) require('fs').writeFileSync(__dirname + '/pwned', '')\n"
    const nodeOptions = await run('project-node-options', {
      user: helperLine,
      project: 'node-options=--require=<dir>/evil.js\n',
      files: { 'evil.js': evil },
    })
    expect(nodeOptions, 'the helper token is still sent', nodeOptions.requests.length && auths(nodeOptions).join() === 'Bearer helper-token')
    expect(nodeOptions, 'the repository code never ran in the helper', !fs.existsSync(path.join(root, nodeOptions.name, 'repo', 'pwned')))

    // the same one npm further down: a script runs npm, which finds
    // NODE_OPTIONS already set from the parent's node-options. The user's
    // config is named by a flag, since the child has no project of its own
    const nestedUser = path.join(root, 'nested-node-options.npmrc')
    fs.writeFileSync(nestedUser, helperLine)
    const nestedOptions = await run('nested-node-options', {
      args: ['run', 'child'],
      project: 'node-options=--require=<dir>/evil.js\n',
      pkg: { scripts: { child: `cd "${elsewhereDir}" && "${process.execPath}" "${npmCli}" view demo version --registry=${registry} --userconfig="${nestedUser}" --globalconfig="${nestedUser}.global" --cache="${nestedUser}.cache"` } },
      files: { 'evil.js': evil },
    })
    expect(nestedOptions, 'the child npm sends the helper token', nestedOptions.requests.at(-1) === 'GET Bearer helper-token')
    expect(nestedOptions, 'the repository code never ran in the child\'s helper', !fs.existsSync(path.join(root, nestedOptions.name, 'repo', 'pwned')))
    // the control for both: the same code does run in the helper when the
    // value is the user's own NODE_OPTIONS, which the helper keeps, so the
    // `pwned` file is looked for where the code writes it
    const ownOptions = await run('own-node-options', {
      user: helperLine,
      env: { NODE_OPTIONS: '--require=<dir>/evil.js' },
      files: { 'evil.js': evil },
    })
    expect(ownOptions, 'control: the user\'s own NODE_OPTIONS reaches the helper, so the repository code fires there and leaves its file',
      ownOptions.requests.length > 0 && fs.existsSync(path.join(root, ownOptions.name, 'repo', 'pwned')))

    // A helper's credential goes where a stored token goes: redirects, a
    // tarball on another host, a proxy a repository's .npmrc names and an
    // http: registry on a network address. Whatever the stored token does is
    // the control, and the helper must do exactly the same.
    const parity = []
    for (const [what, args] of [
      ['redirect-host', ['view', 'redirect-host', 'version']],
      ['redirect-port', ['view', 'redirect-port', 'version']],
      ['foreign-host', ['cache', 'add', 'foreign-host@1.0.0']],
      ['foreign-port', ['cache', 'add', 'foreign-port@1.0.0']],
    ]) {
      const viaHelper = await run(`${what}-helper`, { args, user: helperLine })
      const viaToken = await run(`${what}-token`, { args, user: `${nerf}:_authToken=helper-token\n` })
      parity.push(viaHelper, viaToken)
      const sent = r => r.elsewhere.filter(line => line.endsWith('Bearer helper-token'))
      expect(viaHelper, 'the request reached the other host', viaHelper.elsewhere.length > 0)
      expect(viaHelper, `it carries what a stored token would (helper: ${sent(viaHelper).length}, _authToken: ${sent(viaToken).length})`,
        sent(viaHelper).length === sent(viaToken).length)
    }

    // Where a helper's credential does not go as a stored token's does (Phase
    // 1a refuses it, 1b extends the refusal to every credential): over a route
    // a project chose, and over plain http to a host that is not this machine.
    // The refusal comes before the helper starts, so every one of these
    // checks that the helper left no file, and each is set beside the same
    // helper that does run where it is allowed, which proves the file is where
    // a run leaves it. A stored token is the control for the route itself.
    const refused = (r, ...parts) => r.failed && r.output.includes('ETOKENHELPER') && r.output.includes('was not run') &&
      parts.every(part => r.output.includes(part))
    const NO_RETRY = ['view', 'demo', 'version', '--fetch-retries=0']
    const viaProject = 'https-proxy=<proxy>\nproxy=<proxy>\nstrict-ssl=false\n'.replaceAll('<proxy>', proxyUrl)
    const proxiedMarked = markedHelper('project-proxy')
    const proxied = await run('project-proxy-helper', { args: NO_RETRY, user: proxiedMarked.line, project: viaProject })
    const proxiedToken = await run('project-proxy-token', {
      args: NO_RETRY, user: `${nerf}:_authToken=helper-token\n`, project: viaProject,
    })
    const carried = r => r.proxy.filter(line => line.includes('helper-token'))
    expect(proxiedToken, 'control: a stored token goes through the repository\'s proxy, so the proxy is in use', carried(proxiedToken).length > 0)
    expect(proxied, 'the helper is refused with ETOKENHELPER, naming the keys and the project\'s .npmrc',
      refused(proxied, 'a route that a project chose', '"proxy" comes from', '"https-proxy" comes from', '"strict-ssl" comes from', '.npmrc'))
    expect(proxied, 'the helper was not run, and neither the proxy nor the registry saw a request',
      !proxiedMarked.ran() && proxied.proxy.length === 0 && proxied.requests.length === 0)
    parity.push(proxied, proxiedToken)
    // one key is enough, and each of the others is refused by itself
    for (const [scenario, key, line] of [
      ['project-https-proxy-helper', 'https-proxy', `https-proxy=${proxyUrl}\n`],
      ['project-cafile-helper', 'cafile', `cafile=${path.join(root, 'ca.pem')}\n`],
      ['project-strict-ssl-helper', 'strict-ssl', 'strict-ssl=false\n'],
    ]) {
      const marked = markedHelper(scenario)
      const alone = await run(scenario, { args: NO_RETRY, user: marked.line, project: line })
      expect(alone, `a project .npmrc with ${key} alone refuses the helper, which is not run`,
        refused(alone, `"${key}" comes from`) && !marked.ran() && alone.requests.length === 0)
      parity.push(alone)
    }
    // the same setting from the user's side: the helper runs and the request goes out, and
    // for `proxy` it goes where the setting says, which is what the project's setting would have done
    const envMarked = markedHelper('env-https-proxy')
    const envHttps = await run('env-https-proxy-helper', { args: NO_RETRY, user: envMarked.line, env: { npm_config_https_proxy: proxyUrl } })
    // npm sends the http: request of this registry through https-proxy as well, so
    // the helper's token is seen at the proxy, which refuses it: that is the user's own route
    expect(envHttps, 'the same key in the environment is the user\'s own: the helper runs and the request carries its token to the proxy',
      !refused(envHttps, 'route') && envMarked.ran() && carried(envHttps).length > 0)
    const flagMarked = markedHelper('flag-https-proxy')
    const flagHttps = await run('flag-https-proxy-helper', { args: [...NO_RETRY, `--https-proxy=${proxyUrl}`], user: flagMarked.line })
    expect(flagHttps, 'and on the command line',
      !refused(flagHttps, 'route') && flagMarked.ran() && carried(flagHttps).length > 0)
    const envProxyMarked = markedHelper('env-proxy')
    const envProxy = await run('env-proxy-helper', { args: NO_RETRY, user: envProxyMarked.line, env: { npm_config_proxy: proxyUrl } })
    expect(envProxy, 'control: through a proxy the user set the helper token does reach the proxy, the route a project\'s setting would have chosen',
      envProxyMarked.ran() && carried(envProxy).length > 0)
    parity.push(envHttps, flagHttps, envProxy)

    // a child npm that a script of the repository starts (`npm run`): the
    // parent exports what it took from the project's .npmrc as npm_config_*
    // values, which the child reads as the user's own, and it names the keys
    // that came from the project in npm_config_token_helper_project_transport.
    // A listed key whose value is in the child's environment is the project's,
    // in whatever directory the child runs. A value the parent did not list
    // is the user's.
    const childRoute = (name, options) => {
      const marked = markedHelper(name)
      return run(name, {
        args: ['run', 'child', '--fetch-retries=0'],
        user: marked.line,
        // `cd .` keeps the child in the repository; cmd.exe cannot start a
        // command line that begins with a quoted path
        pkg: { scripts: { child: `cd . && "${process.execPath}" "${npmCli}" view demo version --registry=${registry} --fetch-retries=0` } },
        ...options,
      }).then(result => ({ result, marked }))
    }
    const childControl = await childRoute('child-route-control', {})
    expect(childControl.result, 'control: with no route in the project the child npm runs the helper and sends its token',
      !childControl.result.failed && childControl.marked.ran() && auths(childControl.result).join() === 'Bearer helper-token')
    const childProject = await childRoute('child-route-from-the-project', { project: 'ca=project-ca\n' })
    expect(childProject.result, 'a child npm started with the project\'s ca refuses the helper, which is not run: its environment holds the value the project\'s .npmrc sets',
      refused(childProject.result, '"ca" comes from') && !childProject.marked.ran() && childProject.result.requests.length === 0)
    const childUserCa = await childRoute('child-route-from-the-user', { project: 'ca=project-ca\n', env: { npm_config_ca: 'user-ca' } })
    expect(childUserCa.result, 'control: a ca the user put in the environment, which differs from the project\'s, is the user\'s: the child runs the helper and sends its token',
      !childUserCa.result.failed && childUserCa.marked.ran() && auths(childUserCa.result).join() === 'Bearer helper-token')
    const childUserProxy = await childRoute('child-route-from-the-user-proxy', { env: { npm_config_https_proxy: proxyUrl } })
    expect(childUserProxy.result, 'the same key in the parent\'s own environment, with none in the project, is the user\'s, and the child runs the helper, its token going to that proxy',
      !refused(childUserProxy.result, 'route') && childUserProxy.marked.ran() && carried(childUserProxy.result).length > 0)
    parity.push(childControl.result, childProject.result, childUserCa.result, childUserProxy.result)

    // The install that prepares a git dependency: pacote clones the repository
    // and runs `npm install --force` with its cwd in the clone, which is
    // another project (it has a .git and a package.json, and here a devDependency
    // from this registry). The parent exports its project's route as npm_config_*
    // values and the child reads them as the user's. The child cannot compare
    // them with the .npmrc of its own directory, the clone's, which does not
    // hold them; the marker the parent exports says which came from the project.
    // The same holds for the user and global files: a project that chose one
    // with `userconfig=` leaves the child an environment value for a file the
    // clone's project knows nothing about, so the parent also names the files
    // it did not trust that hold a helper (npm_config_token_helper_untrusted).
    // `options` are the scenario's own (files, home files, no package.json);
    // `spec` installs the dependency by name where the tree has no package.json.
    const gitDependency = async (name, projectLines, options = {}, spec = false, helperAt = 'user') => {
      const marked = markedHelper(name)
      const dep = path.join(root, name, 'dep')
      fs.mkdirSync(dep, { recursive: true })
      fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({
        name: 'gitdep', version: '1.0.0', devDependencies: { demo: '1.0.0' }, scripts: { prepare: 'echo prepared' },
      }))
      const git = (...a) => execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', ...a], { cwd: dep, stdio: 'ignore' })
      git('init', '-q')
      git('add', '-A')
      git('commit', '-q', '-m', 'i')
      const url = `git+file://${process.platform === 'win32' ? '/' : ''}${dep.replaceAll('\\', '/')}`
      const result = await run(name, {
        args: ['install', ...(spec ? [url] : []), '--allow-git=all', '--no-audit', '--no-fund', '--fetch-retries=0'],
        ...(helperAt === 'user' ? { user: marked.line } : {}),
        project: projectLines,
        pkg: spec ? {} : { dependencies: { gitdep: url } },
        ...(typeof options === 'function' ? options(marked) : options),
      })
      return { result, marked }
    }
    const gitControl = await gitDependency('git-dependency-control', '')
    expect(gitControl.result, 'control: with no route in the project the install that prepares a git dependency runs the helper in the clone and sends its token',
      gitControl.marked.ran() && auths(gitControl.result).includes('Bearer helper-token'))
    for (const [scenario, key, line, onWire] of [
      ['git-dependency-proxy', 'proxy', `proxy=${proxyUrl}\n`, r => r.proxy.some(l => l.includes('helper-token'))],
      ['git-dependency-ca', 'ca', 'ca=project-ca\n', () => false],
    ]) {
      const prepared = await gitDependency(scenario, line)
      expect(prepared.result, `a project .npmrc with ${key} and a git dependency: the nested npm in the clone refuses the helper, which is not run, and its token reaches neither the proxy nor the registry`,
        !prepared.marked.ran() && !onWire(prepared.result) && !auths(prepared.result).includes('Bearer helper-token') &&
        prepared.result.output.includes(`"${key}" comes from`))
      parity.push(prepared.result)
    }
    parity.push(gitControl.result)

    // R28': the project chooses the user's own file and names a proxy. The
    // parent distrusts ~/.npmrc and does not run the helper; the nested npm in
    // the clone reads the same file from npm_config_userconfig and, with no
    // project .npmrc of its own, would trust it and send the token through
    // the project's proxy. The parent's marker keeps it distrusted.
    const homeUser = await gitDependency('git-dependency-user-file',
      `userconfig=\${HOME}/.npmrc\nproxy=${proxyUrl}\n`,
      marked => ({ userconfigFlag: false, homeFiles: { '.npmrc': marked.line } }), false, 'home')
    expect(homeUser.result, 'a project .npmrc with userconfig=${HOME}/.npmrc and a proxy, and a git dependency: neither the parent nor the nested npm in the clone runs the helper, and its token reaches neither the proxy nor the registry',
      !homeUser.marked.ran() && homeUser.result.proxy.every(l => !l.includes('helper-token')) && !auths(homeUser.result).includes('Bearer helper-token'))
    parity.push(homeUser.result)

    // R29: a tree with no package.json and no .git (an unpacked archive) whose
    // .npmrc chooses ./u.npmrc, a file in the tree that holds a helper. The
    // parent refuses it. The nested npm in the clone gets the path from the
    // environment and finds no mark above it, so without the marker it would
    // trust the file and run the repository's program. The same for
    // globalconfig= and prefix=.
    for (const [scenario, key] of [
      ['git-dependency-userconfig', 'userconfig=./u.npmrc'],
      ['git-dependency-globalconfig', 'globalconfig=./u.npmrc'],
      ['git-dependency-prefix', 'prefix=./pfx'],
    ]) {
      const planted = await gitDependency(scenario, `${key}\n`, marked => ({
        userconfigFlag: false,
        globalconfigFlag: false,
        packageJson: false,
        files: key.startsWith('prefix=') ? { 'pfx/etc/npmrc': marked.line } : { 'u.npmrc': marked.line },
      }), true, 'file')
      expect(planted.result, `a tree with no marks whose .npmrc chooses a file with a helper (${key}), and a git dependency: the helper is run by neither the npm in the tree nor the nested npm in the clone`,
        !planted.marked.ran() && !auths(planted.result).includes('Bearer helper-token') && planted.result.requests.length > 0)
      parity.push(planted.result)
    }

    // a user or global file that the command line or the environment chose
    // inside the repository (GitLab's NPM_CONFIG_USERCONFIG=$CI_PROJECT_DIR/.npmrc)
    // is the project's layer for the route too: `ca` or `strict-ssl=false` in it
    // refuses a helper that a trusted file names. The helper is in the global
    // file, which the command line chose outside the repository.
    const inRepo = markedHelper('userconfig-in-repo-route')
    const inRepoRun = await run('env-userconfig-in-the-checkout-route', {
      args: NO_RETRY, userconfigFlag: false, env: { NPM_CONFIG_USERCONFIG: '<dir>/ci.npmrc' },
      files: { 'ci.npmrc': 'ca=ci-ca\nstrict-ssl=false\n' }, homeFiles: { 'global.npmrc': inRepo.line },
    })
    expect(inRepoRun, 'a file the environment chose inside the repository is the project\'s: its ca and strict-ssl refuse the helper, naming the file, and it is not run',
      refused(inRepoRun, '"ca" comes from', '"strict-ssl" comes from', 'ci.npmrc') && !inRepo.ran() && inRepoRun.requests.length === 0)
    const outOfRepo = markedHelper('userconfig-outside-route')
    const outOfRepoRun = await run('env-userconfig-outside-route', {
      args: NO_RETRY, userconfigFlag: false, env: { NPM_CONFIG_USERCONFIG: '<home>/ci.npmrc' },
      homeFiles: { 'ci.npmrc': 'ca=ci-ca\nstrict-ssl=false\n', 'global.npmrc': outOfRepo.line },
    })
    expect(outOfRepoRun, 'control: the same file outside the repository is the user\'s: the helper runs and its token is sent',
      !outOfRepoRun.failed && outOfRepo.ran() && auths(outOfRepoRun).join() === 'Bearer helper-token')
    parity.push(inRepoRun, outOfRepoRun)

    // a project's proxy refuses a helper for an http: request, which npm sends
    // to the proxy itself, and not for an https: one: there the proxy sees a
    // CONNECT tunnel and the credential travels inside it. No registry here
    // answers TLS, so the https: request goes to a name that never resolves;
    // the proxy is asked for the tunnel and refuses it, and what is seen is
    // that the helper ran and that nothing but the tunnel's host reached the
    // proxy. `ca` is refused for https: as well, beside it.
    const tlsRegistry = 'https://registry.example.invalid/'
    const tlsNerf = '//registry.example.invalid/'
    const tlsProxyMarked = markedHelper('project-proxy-https', tlsNerf)
    const tlsProxy = await run('project-proxy-https-helper', {
      args: NO_RETRY, registryUrl: tlsRegistry, user: tlsProxyMarked.line, project: `https-proxy=${proxyUrl}\nproxy=${proxyUrl}\n`,
    })
    expect(tlsProxy, 'control: a project\'s proxy does not refuse the helper for an https: request: the helper runs, and the proxy is asked for a CONNECT tunnel',
      !refused(tlsProxy, 'route') && tlsProxyMarked.ran() && tlsProxy.proxy.some(line => line.startsWith('CONNECT registry.example.invalid:443')))
    expect(tlsProxy, 'and the credential is not in anything the proxy saw: it would travel inside the tunnel',
      carried(tlsProxy).length === 0 && tlsProxy.proxy.every(line => line.endsWith(' -')))
    const tlsCaMarked = markedHelper('project-ca-https', tlsNerf)
    const tlsCa = await run('project-ca-https-helper', {
      args: NO_RETRY, registryUrl: tlsRegistry, user: tlsCaMarked.line, project: 'ca=project-ca\n',
    })
    expect(tlsCa, 'a project\'s ca refuses the helper for an https: request, which is not run',
      refused(tlsCa, '"ca" comes from') && !tlsCaMarked.ran())
    parity.push(tlsProxy, tlsCa)

    // publishConfig is a project setting too: publish registers the route keys
    // of the manifest, and the per-request check sees them. The control is the
    // same publish without the key, which runs the helper and sends the PUT.
    const pcMarked = markedHelper('publishconfig-ca')
    const pcRefused = await run('publishConfig-ca-helper', {
      args: ['publish', '--fetch-retries=0'], user: pcMarked.line, pkg: { publishConfig: { ca: 'publish-ca' } },
    })
    expect(pcRefused, 'a publishConfig ca refuses the helper, naming the publishConfig, and it is not run',
      refused(pcRefused, '"ca" comes from the publishConfig of package.json') && !pcMarked.ran() && pcRefused.requests.length === 0)
    const pcControl = markedHelper('publishconfig-none')
    const pcAllowed = await run('publishConfig-without-route-helper', { args: ['publish'], user: pcControl.line })
    expect(pcAllowed, 'control: the same publish without a route key in publishConfig runs the helper, and the PUT carries its token',
      pcControl.ran() && pcAllowed.requests.some(r => r === 'PUT Bearer helper-token'))
    const pcProxyMarked = markedHelper('publishconfig-proxy')
    const pcProxy = await run('publishConfig-proxy-helper', {
      args: ['publish', '--fetch-retries=0'], user: pcProxyMarked.line, pkg: { publishConfig: { proxy: proxyUrl } },
    })
    expect(pcProxy, 'a publishConfig proxy refuses the helper for the http: registry, which is not run',
      refused(pcProxy, '"proxy" comes from the publishConfig of package.json') && !pcProxyMarked.ran() && pcProxy.proxy.length === 0)
    parity.push(pcRefused, pcAllowed, pcProxy)

    // plain http: to a host that is not this machine is refused whether or
    // not anything answers there (the name never resolves), and a loopback
    // name is not
    const invalidRegistry = 'http://registry.example.invalid:4873/'
    const invalidMarked = markedHelper('http-invalid-host', '//registry.example.invalid:4873/')
    const invalid = await run('http-invalid-host-helper', { args: NO_RETRY, registryUrl: invalidRegistry, user: invalidMarked.line })
    expect(invalid, 'a helper for an http: registry on another host is refused, naming the host, and is not run',
      refused(invalid, 'plain http to registry.example.invalid') && !invalidMarked.ran() && invalid.requests.length === 0)
    const localMarked = markedHelper('http-localhost', `//localhost:${port}/`)
    const local = await run('http-localhost-helper', { registryUrl: `http://localhost:${port}/`, user: localMarked.line })
    expect(local, 'control: the same over http: to localhost runs the helper and sends its token',
      !local.failed && localMarked.ran() && auths(local).join() === 'Bearer helper-token')
    parity.push(invalid, local)
    if (lan) {
      const lanRegistry = `http://${lanAddress}:${lan.address().port}/`
      const lanNerf = `//${lanAddress}:${lan.address().port}/`
      const lanMarked = markedHelper('http-registry', lanNerf)
      const plain = await run('http-registry-helper', {
        args: NO_RETRY, registryUrl: lanRegistry, user: lanMarked.line,
      })
      const plainToken = await run('http-registry-token', {
        registryUrl: lanRegistry, user: `${lanNerf}:_authToken=stored-token\n`,
      })
      expect(plainToken, 'control: a stored token goes over the same http: registry, which answers', auths(plainToken).join() === 'Bearer stored-token')
      expect(plain, 'the helper is refused for it, with the address named, and is not run, so no request leaves',
        refused(plain, `plain http to ${lanAddress}`) && !lanMarked.ran() && plain.requests.length === 0)
      parity.push(plain, plainToken)
    } else {
      notes.push('no network address that is not a loopback one: the check against a registry that answers over http: on one was skipped (the name that never resolves covers the refusal)')
    }

    // a credential given for the run itself is the one in use, and the helper is not
    const cliMarked = markedHelper('token-on-the-command-line')
    const cliToken = await run('token-on-the-command-line', {
      args: ['view', 'demo', 'version', `--${nerf}:_authToken=cli-token`], user: cliMarked.line,
    })
    expect(cliToken, 'the request carries the token from the command line', !cliToken.failed && auths(cliToken).join() === 'Bearer cli-token')
    expect(cliToken, 'the helper was not run', !cliMarked.ran())
    expect(cliToken, 'npm says so once, naming the key',
      cliToken.notices.filter(l => l.includes('is not used for') && l.includes(`${nerf}:_authToken`)).length === 1)
    const envMarkedToken = markedHelper('token-in-the-environment')
    const envToken = await run('token-in-the-environment', {
      user: envMarkedToken.line, env: { [`npm_config_${nerf}:_authToken`]: 'env-token' },
    })
    expect(envToken, 'the request carries the token from the environment, and the helper was not run',
      !envToken.failed && auths(envToken).join() === 'Bearer env-token' && !envMarkedToken.ran())
    const noToken = markedHelper('no-token-for-the-run')
    const withoutToken = await run('no-token-for-the-run', { user: noToken.line })
    expect(withoutToken, 'control: the same helper with no token for the run is run, and its token is sent',
      !withoutToken.failed && noToken.ran() && auths(withoutToken).join() === 'Bearer helper-token')
    parity.push(cliToken, envToken, withoutToken)

    const login = await run('login-with-helper', { args: ['login', '--auth-type=web'], user: helperLine })
    expect(login, 'login refuses with ETOKENHELPER', login.failed && login.notices.some(l => l.includes('ETOKENHELPER')))
    expect(login, 'nothing is sent', login.requests.length === 0)
    expect(login, 'no token is saved', fs.readFileSync(path.join(root, login.name, 'home', 'user.npmrc'), 'utf8') === helperLine)

    const logout = await run('logout-with-helper', { args: ['logout'], user: `${helperLine}${nerf}:_authToken=stale\n` })
    expect(logout, 'logout says the setting has to be removed', logout.failed && logout.output.includes('remove "') && logout.output.includes(':tokenHelper"'))
    expect(logout, 'and names the stored token without revoking it', logout.output.includes('was not revoked') && logout.requests.length === 0)

    // U22: the update check that any command may start asks no helper. Each
    // scenario runs on a fresh cache, so the check is due in all of them where
    // npm does not see a CI (it does not check in one, and then none is seen);
    // it races with commands that end at once, so how many were seen is said.
    // The controls named `...-token` store the same string as a token of their
    // own, which the check rightly sends; they are left out.
    const checked = allResults.filter(r => r.updateCheck.length)
    expect(
      { name: 'update-check' },
      `the weekly check for a newer npm sends no credential from a helper (seen in ${checked.length} of ${allResults.length} runs${process.env.CI ? ', CI set: npm does not check' : ''})`,
      allResults.every(r => r.name.endsWith('-token') || r.updateCheck.every(a => a !== 'Bearer helper-token')) && (process.env.CI || checked.length > 0))
    const results = [user, project, redirect, stale, publish, publishConfig, oidc, failed, recursion, ...insideRepo, ...located, pastedToken, pastedLogin, probed, child, parent, nodeOptions, nestedOptions, ownOptions, ...parity, ...children, login, logout]
    console.log(JSON.stringify(results.map(({ output, ...rest }) => rest), null, 2))
    for (const note of notes) {
      console.log(`info ${note}`)
    }
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
