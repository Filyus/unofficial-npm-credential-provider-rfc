'use strict'
// What a reference provider reads besides the protocol: its own
// configuration file, named by `--config`. That file says where the
// provider keeps what it stores (a JSON file standing in for the OS
// keychain), which address answers for each registry host, and how the
// person at the machine is reached. Nothing here comes from npm.

const fs = require('node:fs')
const path = require('node:path')
const tty = require('node:tty')
const { StringDecoder } = require('node:string_decoder')

// What a call that outlived its deadline throws. The message names the origin
// and not the URL: a path or a query can carry a secret.
class RequestTimeout extends Error {
  constructor(method, url, ms) {
    super(`${method} ${new URL(url).origin} did not answer within ${ms} ms`)
    this.name = 'RequestTimeout'
    this.code = 'ETIMEDOUT'
  }
}

// Vendor text the person reads on the terminal (a verification address, a user
// code, a package name) must not carry what a terminal acts on: C0 and C1
// controls (escape sequences, a carriage return that overwrites the line) and
// the bidirectional marks and overrides that reorder what is shown. Each is
// replaced by `?`. `showToPerson`, `confirm` and `ask` apply it to what they
// are given, so no provider can forget; a provider that puts the same text in
// an error message uses it too.
const plain = (text) => String(text).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, '?')

const loadContext = (configPath) => {
  if (typeof configPath !== 'string') {
    throw new Error('--config <file> is required: the settings of a reference provider are in a JSON file')
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const storePath = path.resolve(path.dirname(configPath), config.store)
  const scripted = config.person && config.person.mode === 'scripted'
  const answers = scripted ? [...(config.person.presence || [])] : []
  const typed = scripted ? [...(config.person.typed || [])] : []

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
    try {
      const fd = fs.openSync(temporary, 'w', 0o600)
      try {
        fs.writeSync(fd, `${JSON.stringify(store, null, 2)}\n`)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(temporary, storePath)
    } catch (error) {
      // the file beside the store holds secrets: a failed write does not leave it
      fs.rmSync(temporary, { force: true })
      throw error
    }
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

  // Every call has a deadline, so a vendor that accepts the connection and
  // says nothing cannot hold the provider past what npm will wait for.
  // `until` is a time on this context's clock (`clockMs()`); `timeoutMs` is a
  // bound on this call alone; neither given, the default is `requestTimeoutMs`
  // of the configuration, 30 s. Outside a run the time left is a real timer.
  // In a run time is synthetic and passes only by `sleep`, so an `until` that
  // is already past fails at once and one still ahead does not shorten the
  // real wait, which is `timeoutMs` or the default. An expired call throws a
  // `RequestTimeout`, which a provider that does not catch it answers `other`.
  const defaultTimeoutMs = Number.isFinite(config.requestTimeoutMs) ? config.requestTimeoutMs : 30000

  // `headers` adds to what the call sets (an `Accept`, an `npm-otp`); it cannot
  // replace the clock header a conformance run adds
  const request = async (method, url, { token, body, form, headers: extra, until, timeoutMs } = {}) => {
    const headers = { ...(extra || {}) }
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
    let limit = timeoutMs === undefined ? defaultTimeoutMs : timeoutMs
    if (until !== undefined) {
      const left = until - clockMs()
      if (left <= 0) {
        throw new RequestTimeout(method, url, 0)
      }
      if (!clockPath) {
        limit = Math.min(limit, left)
      }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), limit)
    let response
    let text
    try {
      response = await fetch(endpoint(url), { method, headers, body: payload, redirect: 'manual', signal: controller.signal })
      text = await response.text()
    } catch (error) {
      if (controller.signal.aborted) {
        throw new RequestTimeout(method, url, limit)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
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
  const confirm = async (given, signal) => {
    const question = plain(given)
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

  // A line the person types on the controlling terminal: a username, a
  // password, a one-time password. Never stdin, which belongs to the protocol.
  // The conformance run scripts the lines ("silent": nobody types, and the
  // provider's own deadline decides). `{ secret: true }` asks for the line
  // without echo where Node can turn it off (see `readSecretLine`, which says
  // where it cannot); a scripted line is logged as asked either way. An
  // unanswerable prompt (end of input, Ctrl-C) gives `null`.
  const ask = async (given, signal, { secret = false } = {}) => {
    const question = plain(given)
    if (scripted) {
      if (!typed.length) {
        throw new Error(`no scripted line for: ${question}`)
      }
      fs.appendFileSync(path.resolve(path.dirname(configPath), config.person.log), `${question}\n`)
      const line = typed.shift()
      return line === 'silent' ? new Promise(() => {}) : line
    }
    return (secret ? readSecretLine : readTerminalLine)(`${question} `, signal)
  }

  // `ask` that gives up: `null` when `ms` pass first
  const askWithin = (question, ms, options) => withDeadline((signal) => ask(question, signal, options), ms)

  // A browser or device-code step the person completes. Scripted runs have
  // the fake identity provider complete it; a real run would open the URL.
  // Returns whether the person could be shown it: a provider that cannot show
  // the step answers `other` at once, since nothing it started can be finished.
  // A scenario models a run with no terminal with `person.terminal: false`.
  // The text is shown line by line with `plain` applied to each, and a scripted
  // run records what it was given, sanitised, in `person.shownLog` (the
  // scenario's `expect.shown` checks it).
  const showToPerson = (given) => {
    const text = String(given).split('\n').map(plain).join('\n')
    if (scripted) {
      if (config.person.shownLog) {
        fs.appendFileSync(path.resolve(path.dirname(configPath), config.person.shownLog), `${JSON.stringify(text)}\n`)
      }
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

  return { config, readStore, writeStore, now, clockMs, sleep, withDeadline, request, confirm, confirmWithin, ask, askWithin, showToPerson }
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

// The first line of `input`, a readable stream, without its line ending: the
// text up to the first newline, decoded across chunk borders (a multi-byte
// character can be split between two chunks). Bytes after that newline are
// discarded with the stream: the terminal gives a line at a time, and what a
// person typed ahead belongs to nobody. At end of input (Ctrl-D, a closed
// console) what was typed so far is the answer, or `null` if nothing was: a
// prompt nobody can answer must not hold the process. An aborted read gives
// `null`; a stream error rejects.
const readLineFrom = (input, signal) =>
  new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8')
    let line = ''
    let settled = false
    const settle = (value, error) => {
      if (settled) {
        return
      }
      settled = true
      input.destroy()
      if (error) {
        reject(error)
      } else {
        resolve(value)
      }
    }
    input.on('data', (chunk) => {
      line += decoder.write(chunk)
      const newline = line.indexOf('\n')
      if (newline !== -1) {
        settle(line.slice(0, newline).replace(/\r$/, ''))
      }
    })
    input.on('end', () => {
      line += decoder.end()
      settle(line === '' ? null : line.replace(/\r$/, ''))
    })
    input.on('error', (error) => settle(null, error))
    if (signal) {
      if (signal.aborted) {
        settle(null)
      }
      signal.addEventListener('abort', () => settle(null), { once: true })
    }
  })

// Typed text with the keys of a line editor applied, for a terminal in raw
// mode where nothing is echoed and nothing edited for us: Enter ends the line,
// Backspace removes a character, Ctrl-C cancels, Ctrl-D ends it too (an empty
// line is then `null`, as at end of input), Ctrl-U clears. Returns the new text
// and whether the line is over (`done`, with `cancelled` for Ctrl-C).
const editSecret = (text, keys) => {
  let line = text
  for (const char of keys) {
    if (char === '\r' || char === '\n') {
      return { text: line, done: true, cancelled: false }
    }
    if (char === '\u0003') {
      return { text: '', done: true, cancelled: true }
    }
    if (char === '\u0004') {
      return { text: line, done: true, cancelled: line === '' }
    }
    if (char === '\u007f' || char === '\b') {
      line = Array.from(line).slice(0, -1).join('')
    } else if (char === '\u0015') {
      line = ''
    } else if (char >= ' ') {
      line += char
    }
  }
  return { text: line, done: false, cancelled: false }
}

// Raw mode that a secret prompt has turned on and not yet turned off. A provider
// that is stopped while one is open (npm's SIGTERM when a prompt outlives its
// time, an uncaught error, `process.exit`) must give the terminal back echoing:
// `exit` and SIGTERM handlers, installed for as long as a prompt is open, turn it
// off. The limits: SIGKILL and, on Windows, the termination of a process run no
// handler of ours, so a console left in raw mode by those is the person's to
// repair (`reset`, or closing the console); Ctrl-C while the prompt is open is the
// person's key press, read as input and answered as a cancelled prompt, not a signal.
const rawTerminals = new Set()
const restoreRawModes = () => {
  for (const terminal of rawTerminals) {
    try {
      terminal.setRawMode(false)
    } catch {
      // the stream is gone, and so is its mode
    }
  }
  rawTerminals.clear()
}
const onSigterm = () => {
  restoreRawModes()
  process.exit(143)
}
// `terminal` is in raw mode from now on; the returned function ends that
const guardRawMode = (terminal) => {
  if (!rawTerminals.size) {
    process.on('exit', restoreRawModes)
    process.on('SIGTERM', onSigterm)
  }
  rawTerminals.add(terminal)
  return () => {
    try {
      terminal.setRawMode(false)
    } catch {
      // the stream is going away either way
    }
    rawTerminals.delete(terminal)
    if (!rawTerminals.size) {
      process.removeListener('exit', restoreRawModes)
      process.removeListener('SIGTERM', onSigterm)
    }
  }
}

// What a person typed before a question was asked belongs to no question: a
// stray Enter, or a `y` meant for something else, must not answer a presence
// prompt. Before a prompt is written, whatever the terminal has buffered is read
// and thrown away: with the terminal in raw mode, which also releases a
// half-typed line, for as long as `ms` (the time keys already pressed take to
// arrive). The limits: Node has no `tcflush`, so this is a read for a short
// moment and not a flush, and a key pressed after it and before the question is
// shown still answers it; where the terminal cannot be put in raw mode (no TTY, a
// console that refuses) nothing is discarded.
const FLUSH_MS = 30
const discardBuffered = (input, ms = FLUSH_MS) =>
  new Promise((resolve) => {
    const discard = () => {}
    input.on('data', discard)
    setTimeout(() => {
      input.removeListener('data', discard)
      resolve()
    }, ms)
  })

const flushTypeAhead = async () => {
  let fd
  let terminal
  try {
    fd = fs.openSync(terminalPaths().input, 'r')
    if (!tty.isatty(fd)) {
      throw new Error('not a tty')
    }
    terminal = new tty.ReadStream(fd)
    terminal.setRawMode(true)
  } catch {
    if (terminal) {
      terminal.destroy()
    } else if (fd !== undefined) {
      fs.closeSync(fd)
    }
    return false
  }
  const release = guardRawMode(terminal)
  try {
    await discardBuffered(terminal)
  } finally {
    release()
    terminal.destroy()
  }
  return true
}

// The line of a prompt whose answer is a secret (a password, a one-time
// password), typed without echo where Node can: the terminal opened on its
// path is a TTY, and `setRawMode` turns echo off for as long as the read lasts
// (restored whatever the end). The limit: where it cannot (no TTY, a console
// that refuses raw mode, which some terminal emulators on Windows do), the line
// is read as `readTerminalLine` reads it, echoed, and the person is told so
// before typing ("input is shown"). Never stdin.
const readSecretLine = (prompt, signal) => {
  let fd
  let terminal
  try {
    fd = fs.openSync(terminalPaths().input, 'r')
    if (!tty.isatty(fd)) {
      throw new Error('not a tty')
    }
    terminal = new tty.ReadStream(fd)
    terminal.setRawMode(true)
  } catch {
    if (terminal) {
      terminal.destroy()
    } else if (fd !== undefined) {
      fs.closeSync(fd)
    }
    return readTerminalLine(`${prompt}(input is shown) `, signal)
  }
  const release = guardRawMode(terminal)
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8')
    let text = ''
    let settled = false
    const settle = (value) => {
      if (settled) {
        return
      }
      settled = true
      release()
      terminal.destroy()
      try {
        writeTerminal('\n')
      } catch {
        // nothing to say it on
      }
      resolve(value)
    }
    terminal.on('end', () => settle(text === '' ? null : text))
    terminal.on('error', () => settle(null))
    if (signal) {
      if (signal.aborted) {
        settle(null)
      }
      signal.addEventListener('abort', () => settle(null), { once: true })
    }
    // keys typed ahead are discarded, then the question is written
    discardBuffered(terminal).then(() => {
      if (settled) {
        return
      }
      try {
        writeTerminal(prompt)
      } catch (error) {
        // nowhere to ask: the caller says so, as for any prompt
        settled = true
        release()
        terminal.destroy()
        reject(error)
        return
      }
      terminal.on('data', (chunk) => {
        const edited = editSecret(text, decoder.write(chunk))
        text = edited.text
        if (edited.done) {
          settle(edited.cancelled ? null : text)
        }
      })
    })
  })
}

// Asynchronous, so that a provider's own deadline on the prompt can fire, and
// abortable, so that once it has the read of the terminal does not hold the
// process until someone presses Enter. An aborted read gives `null`.
const readTerminalLine = async (prompt, signal) => {
  await flushTypeAhead()
  if (signal && signal.aborted) {
    return null
  }
  writeTerminal(prompt)
  return readLineFrom(fs.createReadStream(terminalPaths().input), signal)
}

const askTerminal = async (question, signal) => {
  const answer = await readTerminalLine(`${question} [y/N] `, signal)
  return answer !== null && /^y(es)?$/i.test(answer.trim())
}

module.exports = { loadContext, plain, readLineFrom, editSecret, discardBuffered, guardRawMode, restoreRawModes, RequestTimeout }
