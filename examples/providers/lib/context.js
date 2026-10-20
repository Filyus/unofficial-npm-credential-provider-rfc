'use strict'
// What a reference provider reads besides the protocol: its own
// configuration file, named by `--config`. That file says where the
// provider keeps what it stores (a JSON file standing in for the OS
// keychain), which address answers for each registry host, and how the
// person at the machine is reached. Nothing here comes from npm.

const fs = require('node:fs')
const path = require('node:path')

const loadContext = (configPath) => {
  if (typeof configPath !== 'string') {
    throw new Error('--config <file> is required: the settings of a reference provider are in a JSON file')
  }
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

  // Written whole or not at all: to a file beside it, then renamed over it, so a
  // crash leaves the old store and not an empty one. The mode keeps the file to
  // its owner where there are modes; on Windows it is ignored, and a real
  // provider would use the credential store the platform has.
  const writeStore = (store) => {
    const temporary = `${storePath}.${process.pid}.tmp`
    const fd = fs.openSync(temporary, 'w', 0o600)
    try {
      fs.writeSync(fd, `${JSON.stringify(store, null, 2)}\n`)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temporary, storePath)
  }

  // Time comes from here, never from Date.now or setTimeout, so that a run
  // can make it synthetic. A real run uses the system clock. The
  // conformance run sets the time in a file it moves forward between
  // requests (a retry comes when a token has lapsed), and within a request
  // time passes only by `sleep`, which returns at once: a five-second poll
  // interval or a deadline of minutes costs nothing, and `expiresAt` stays
  // reproducible.
  const clockPath = config.clock && path.resolve(path.dirname(configPath), config.clock)
  let base = null
  let elapsedMs = 0
  const clockMs = () => {
    if (!clockPath) {
      return Date.now()
    }
    const set = Number(fs.readFileSync(clockPath, 'utf8')) * 1000
    if (set !== base) {
      base = set
      elapsedMs = 0
    }
    return base + elapsedMs
  }
  const now = () => Math.floor(clockMs() / 1000)
  // `sleep(ms)` is a promise with a `cancel()`. A real timer is cleared; a
  // synthetic one gives back the time it had taken if it had not fired, so a
  // deadline that was not the one to pass moves nothing.
  const sleep = (ms) => {
    let cancel
    let promise
    if (!clockPath) {
      promise = new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        cancel = () => clearTimeout(timer)
      })
    } else {
      clockMs()
      const taken = Math.max(0, ms)
      elapsedMs += taken
      promise = new Promise((resolve) => {
        const immediate = setImmediate(() => {
          cancel = () => {}
          resolve()
        })
        cancel = () => {
          clearImmediate(immediate)
          elapsedMs -= taken
        }
      })
    }
    promise.cancel = () => cancel()
    return promise
  }

  // What `task` answers, or null once `ms` have passed; whichever comes second is
  // given up: the timer is cleared and `signal` aborts what `task` waits on (the
  // read of the terminal), so the provider can exit as soon as it is done.
  const withDeadline = async (task, ms) => {
    const controller = new AbortController()
    const timer = sleep(ms)
    try {
      return await Promise.race([task(controller.signal), timer.then(() => null)])
    } finally {
      timer.cancel()
      controller.abort()
    }
  }

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
    if (clockPath) {
      // the fake API judges "too soon" by the provider's time, not its own
      headers['x-conformance-clock'] = String(clockMs())
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
  const confirm = async (question, signal) => {
    if (scripted) {
      if (!answers.length) {
        throw new Error(`no scripted answer for: ${question}`)
      }
      // the run checks that every scripted answer was asked for
      fs.appendFileSync(path.resolve(path.dirname(configPath), config.person.log), `${question}\n`)
      const answer = answers.shift()
      // "silent": the person never answers, and the provider's own
      // deadline, a `sleep`, decides
      return answer === 'silent' ? new Promise(() => {}) : answer
    }
    return askTerminal(question, signal)
  }

  // A browser or device-code step the person completes. Scripted runs have
  // the fake identity provider complete it; a real run would open the URL.
  // Returns whether the person could be shown it: a provider that cannot show
  // the step answers `other` at once, since nothing it started can be finished.
  // A scenario models a run with no terminal with `person.terminal: false`.
  const showToPerson = (text) => {
    if (scripted) {
      return config.person.terminal !== false
    }
    try {
      writeTerminal(`${text}\n`)
      return true
    } catch {
      // no controlling terminal: say so on stderr, never on stdout
      process.stderr.write('no controlling terminal to show the sign-in step on\n')
      return false
    }
  }

  // a presence prompt that gives up: `null` when `ms` pass first, as the RFC wants an unanswered prompt to end in `other`
  const confirmWithin = (question, ms) => withDeadline((signal) => confirm(question, signal), ms)

  return { config, readStore, writeStore, now, clockMs, sleep, withDeadline, request, confirm, confirmWithin, showToPerson }
}

// On Windows the device names, not `CONIN$` and `CONOUT$`: Node resolves a
// bare name against the current directory, which takes it out of the
// device namespace, and opening it for writing creates a file called
// CONOUT$ there.
const terminalPaths = () =>
  process.platform === 'win32'
    ? { input: '\\\\.\\CONIN$', output: '\\\\.\\CONOUT$' }
    : { input: '/dev/tty', output: '/dev/tty' }

const writeTerminal = (text) => {
  const fd = fs.openSync(terminalPaths().output, 'w')
  try {
    fs.writeSync(fd, text)
  } finally {
    fs.closeSync(fd)
  }
}

// Asynchronous, so that a provider's own deadline on the prompt can fire, and
// abortable, so that once it has the read of the terminal does not hold the
// process until someone presses Enter.
const askTerminal = (question, signal) =>
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
    signal?.addEventListener('abort', () => {
      input.destroy()
      resolve(false)
    }, { once: true })
  })

module.exports = { loadContext }
