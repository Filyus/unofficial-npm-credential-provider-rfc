'use strict'
// A real Verdaccio as a Node process: installed from npm into a directory of
// its own, configured from a generated file in a temporary directory, and
// always killed at the end. No docker, so a run is the same locally and in CI.

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

// npm's own script, so that no shell is needed to run it (a `.cmd` shim needs one on Windows):
// beside the node binary on Windows, in ../lib on the others
const npmCli = () => {
  const bin = path.dirname(process.execPath)
  return [path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((file) => fs.existsSync(file))
}

// Installs `verdaccio@<version>` into `dir` (once: an install that is there is
// reused) and returns the path of its executable script. npm is run with empty
// user and global configurations of its own, so nothing of the machine's is read
// or changed.
const install = (version, dir) => {
  const bin = path.join(dir, 'node_modules', 'verdaccio', 'bin', 'verdaccio')
  const manifest = path.join(dir, 'node_modules', 'verdaccio', 'package.json')
  if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).version === version) {
    return bin
  }
  fs.mkdirSync(dir, { recursive: true })
  const userconfig = path.join(dir, 'user.npmrc')
  const globalconfig = path.join(dir, 'global.npmrc')
  fs.writeFileSync(userconfig, '')
  fs.writeFileSync(globalconfig, '')
  const args = ['install', '--prefix', dir, `verdaccio@${version}`, '--no-audit', '--no-fund', '--userconfig', userconfig, '--globalconfig', globalconfig]
  const cli = npmCli()
  const result = cli
    ? spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { encoding: 'utf8', shell: process.platform === 'win32' })
  if (result.status !== 0) {
    throw new Error(`npm install verdaccio@${version} failed:\n${result.stdout}\n${result.stderr}`)
  }
  const installed = JSON.parse(fs.readFileSync(manifest, 'utf8')).version
  if (installed !== version) {
    throw new Error(`asked for verdaccio@${version}, got ${installed}`)
  }
  return bin
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

// The configuration the example assumes (examples/verdaccio.md, "Configuration"):
// htpasswd, the default opaque AES tokens (`security.api.legacy`, no JWT) unless
// `jwt` is given, the `packages` rules for the scoped test package. `maxUsers` is
// what lets the setup register its users; the run itself uses -1 (nobody can
// register). A rule's group is a list of user names, since htpasswd gives a user
// no group but their own name.
const writeConfig = (root, { rules, maxUsers, jwt, flags }) => {
  const config = {
    storage: './storage',
    auth: { htpasswd: { file: './htpasswd', max_users: maxUsers } },
    uplinks: {},
    packages: {
      ...Object.fromEntries(
        rules.map((rule) => [
          rule.pattern,
          { access: rule.access.join(' '), publish: rule.publish.join(' '), unpublish: rule.unpublish.join(' '), ...(rule.stage ? { stage: rule.stage.join(' ') } : {}) },
        ]),
      ),
      '**': { access: '$all' },
    },
    log: { type: 'stdout', format: 'pretty', level: process.env.VERDACCIO_LIVE_LOG || 'warn' },
    security: jwt ? { api: { legacy: false, jwt: { sign: { expiresIn: jwt } } } } : { api: { legacy: true } },
    ...(flags ? { flags } : {}),
  }
  const file = path.join(root, 'config.yaml')
  // JSON is YAML
  fs.writeFileSync(file, JSON.stringify(config, null, 2))
  return file
}

// whatever happens to the run, no server outlives it
const running = new Set()
process.on('exit', () => {
  for (const child of running) {
    child.kill()
  }
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Starts the server on a free 127.0.0.1 port and waits until `/-/ping` answers.
const start = async (bin, configFile) => {
  const port = await freePort()
  const child = spawn(process.execPath, [bin, '--config', configFile, '--listen', `127.0.0.1:${port}`], {
    cwd: path.dirname(configFile),
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: path.dirname(configFile), USERPROFILE: path.dirname(configFile), XDG_DATA_HOME: path.dirname(configFile), XDG_CONFIG_HOME: path.dirname(configFile) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  running.add(child)
  child.on('exit', () => running.delete(child))
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  let exited = false
  child.on('exit', () => (exited = true))
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60000
  for (;;) {
    if (exited) {
      throw new Error(`verdaccio exited before it answered:\n${output}`)
    }
    try {
      const res = await fetch(`${url}/-/ping`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        break
      }
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill()
      throw new Error(`verdaccio did not answer /-/ping in 60 s:\n${output}`)
    }
    await sleep(100)
  }
  return {
    url,
    output: () => output,
    stop: () =>
      new Promise((resolve) => {
        if (exited) {
          return resolve()
        }
        child.once('exit', resolve)
        child.kill()
        setTimeout(() => {
          if (!exited) {
            child.kill('SIGKILL')
          }
        }, 5000).unref()
      }),
  }
}

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'verdaccio-live-'))

module.exports = { install, writeConfig, start, tempRoot }
