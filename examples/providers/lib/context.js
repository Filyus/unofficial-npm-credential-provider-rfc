'use strict'
// What a reference provider reads besides the protocol: its own
// configuration file, named by `--config`. That file says where the
// provider keeps what it stores (a JSON file standing in for the OS
// keychain), which address answers for each registry host, and how the
// person at the machine is reached. Nothing here comes from npm.

const fs = require('node:fs')
const path = require('node:path')

const loadContext = (configPath) => {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const storePath = path.resolve(path.dirname(configPath), config.store)
  const scripted = config.person && config.person.mode === 'scripted'
  const answers = scripted ? [...(config.person.presence || [])] : []

  const readStore = () => {
    try {
      return JSON.parse(fs.readFileSync(storePath, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {}
      }
      throw error
    }
  }

  const writeStore = (store) => {
    const fd = fs.openSync(storePath, 'w', 0o600)
    try {
      fs.writeSync(fd, `${JSON.stringify(store, null, 2)}\n`)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }

  // Seconds since the epoch. The conformance run sets the clock, in a file
  // it moves forward between requests (a retry comes when a token has
  // lapsed), so that a transcript's `expiresAt` is reproducible.
  const clockPath = config.clock && path.resolve(path.dirname(configPath), config.clock)
  const now = () =>
    clockPath ? Number(fs.readFileSync(clockPath, 'utf8')) : config.now ?? Math.floor(Date.now() / 1000)

  // The address that answers for a registry or API URL: the configured
  // endpoint for its origin, or the URL itself.
  const endpoint = (url) => {
    const { origin } = new URL(url)
    const base = config.endpoints && config.endpoints[origin]
    return base ? base + url.slice(origin.length) : url
  }

  const request = async (method, url, { token, body, form } = {}) => {
    const headers = {}
    if (token) {
      headers.authorization = `Bearer ${token}`
    }
    let payload
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      payload = new URLSearchParams(form).toString()
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    const response = await fetch(endpoint(url), { method, headers, body: payload, redirect: 'manual' })
    const text = await response.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: response.status, headers: Object.fromEntries(response.headers), json }
  }

  // User presence. A real run asks on the controlling terminal, never on
  // stdin, which belongs to the protocol; the conformance run scripts the
  // answers. Only called when the request says `interactive: true`.
  const confirm = async (question) => {
    if (scripted) {
      if (!answers.length) {
        throw new Error(`no scripted answer for: ${question}`)
      }
      // the run checks that every scripted answer was asked for
      fs.appendFileSync(path.resolve(path.dirname(configPath), config.person.log), `${question}\n`)
      return answers.shift()
    }
    return askTerminal(question)
  }

  // A browser or device-code step the person completes. Scripted runs have
  // the fake identity provider complete it; a real run would open the URL.
  const showToPerson = (text) => {
    if (!scripted) {
      writeTerminal(`${text}\n`)
    }
  }

  return { config, readStore, writeStore, now, request, confirm, showToPerson }
}

const terminalPaths = () =>
  process.platform === 'win32' ? { input: 'CONIN$', output: 'CONOUT$' } : { input: '/dev/tty', output: '/dev/tty' }

const writeTerminal = (text) => {
  const fd = fs.openSync(terminalPaths().output, 'w')
  try {
    fs.writeSync(fd, text)
  } finally {
    fs.closeSync(fd)
  }
}

// Asynchronous, so that a provider's own deadline on the prompt can fire.
const askTerminal = (question) =>
  new Promise((resolve, reject) => {
    writeTerminal(`${question} [y/N] `)
    const input = fs.createReadStream(terminalPaths().input)
    let answer = ''
    input.on('data', (chunk) => {
      answer += chunk
      if (answer.includes('\n')) {
        input.destroy()
        resolve(/^y(es)?$/i.test(answer.trim()))
      }
    })
    input.on('error', reject)
  })

module.exports = { loadContext }
