'use strict'
// What a scenario's state becomes on a real Verdaccio, and the plumbing around
// it: an HTTP client, the registration of users and the minting and revoking of
// tokens through the server's own API, a recording proxy the provider talks
// through, and the normal form in which a fake's exchanges and a real
// server's are compared.

const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const zlib = require('node:zlib')
const { start, tempRoot, writeConfig } = require('./server.js')

// The registry of the scenarios is `https://npm.example.test/verdaccio/`; a real
// Verdaccio serves from its root, so the proxy takes the prefix off.
const PREFIX = '/verdaccio'

const call = async (base, method, route, { token, basic, body, headers } = {}) => {
  const sent = { ...(headers || {}) }
  if (token) {
    sent.authorization = `Bearer ${token}`
  } else if (basic) {
    sent.authorization = `Basic ${Buffer.from(basic).toString('base64')}`
  }
  if (body !== undefined) {
    sent['content-type'] = 'application/json'
  }
  const response = await fetch(`${base}${route}`, { method, headers: sent, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: response.status, headers: Object.fromEntries(response.headers), json, text }
}

const userRoute = (name) => `/-/user/org.couchdb.user:${encodeURIComponent(name)}`

// `npm login` as npm-profile does it: add the user, and for a user that exists
// (409) authenticate with Basic on the revision route
const loginToken = async (base, name, password) => {
  let res = await call(base, 'PUT', userRoute(name), { body: { name, password } })
  if (res.status === 409) {
    res = await call(base, 'PUT', `${userRoute(name)}/-rev/undefined`, { basic: `${name}:${password}`, body: { name, password } })
  }
  if (!res.json || !res.json.token) {
    throw new Error(`setup: no login token for ${name} (HTTP ${res.status} ${res.text})`)
  }
  return res.json.token
}

const mintToken = async (base, login, password, readonly) => {
  const res = await call(base, 'POST', '/-/npm/v1/tokens', { token: login, body: { password, readonly } })
  if (res.status !== 200 || !res.json || !res.json.token) {
    throw new Error(`setup: no ${readonly ? 'read-only' : 'full'} token (HTTP ${res.status} ${res.text})`)
  }
  return { token: res.json.token, key: res.json.key }
}

// a gzipped tar with one file, package/package.json: the 7.x line reads the manifest out of
// the tarball it is sent
const tarball = (manifest) => {
  const content = Buffer.from(JSON.stringify(manifest))
  const header = Buffer.alloc(512)
  const put = (text, at, length) => header.write(text, at, length, 'ascii')
  put('package/package.json', 0, 100)
  put('0000644\0', 100, 8)
  put('0000000\0', 108, 8)
  put('0000000\0', 116, 8)
  put(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12)
  put('00000000000\0', 136, 12)
  put('        ', 148, 8)
  put('0', 156, 1)
  put('ustar\0', 257, 6)
  put('00', 263, 2)
  const sum = header.reduce((total, byte) => total + byte, 0)
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512)
  return zlib.gzipSync(Buffer.concat([header, content, padding, Buffer.alloc(1024)]))
}

// a package a real publish accepts: Verdaccio checks the attachment against `dist.shasum`
const packument = (name, version) => {
  const manifest = { name, version }
  const data = tarball(manifest)
  const bare = name.split('/').pop()
  return {
    _id: name,
    name,
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        ...manifest,
        dist: {
          shasum: crypto.createHash('sha1').update(data).digest('hex'),
          integrity: `sha512-${crypto.createHash('sha512').update(data).digest('base64')}`,
          tarball: `http://localhost/${name}/-/${bare}-${version}.tgz`,
        },
      },
    },
    _attachments: { [`${name}-${version}.tgz`]: { content_type: 'application/octet-stream', data: data.toString('base64'), length: data.length } },
  }
}
const packageRoute = (name) => `/${name.replace('/', '%2f')}`

// A rule's groups as Verdaccio can read them: htpasswd gives a user no group
// but their own name, so a group becomes its members.
const expandRules = (rules, users) => {
  const members = (group) => {
    if (group.startsWith('$')) {
      return [group]
    }
    const names = Object.entries(users).filter(([, user]) => (user.groups || []).includes(group)).map(([name]) => name)
    return names.length ? names : [group]
  }
  const expand = (list) => (list ? [...new Set(list.flatMap(members))] : undefined)
  return rules.map((rule) => ({ ...rule, access: expand(rule.access), publish: expand(rule.publish), unpublish: expand(rule.unpublish), stage: expand(rule.stage) }))
}

const jwtShaped = (token) => token.split('.').length === 3

// Starts a Verdaccio from a scenario's `state` and sets it up through the
// API: the users registered (the first phase leaves registration open), the
// test package published by a user the rules let publish, a token minted for
// each entry of `state.tokens` (and revoked for a `dead` one). The second phase
// is the same storage with registration closed and the scenario's rules only.
// `tokens` maps a scenario's token to the real one, `keys` its key to the real key.
const realize = async ({ bin, state, jwt, flags, packages }) => {
  const users = state.users || {}
  const rules = expandRules(state.rules || [], users)
  const root = tempRoot()
  let server = null
  try {
    server = await start(bin, writeConfig(root, { rules, maxUsers: 1000, jwt, flags }))
    const base = server.url
    const logins = {}
    for (const [name, user] of Object.entries(users)) {
      logins[name] = await loginToken(base, name, user.password)
    }
    // the registry's packages, published by a user the rules let publish them (none, none published)
    const ruleOf = (name) => rules.find((rule) => (rule.pattern.endsWith('*') ? name.startsWith(rule.pattern.slice(0, -1)) : rule.pattern === name))
    for (const [name, versions] of Object.entries(state.packages || packages || {})) {
      const rule = ruleOf(name)
      const publisher = Object.keys(users).find((user) => rule && (rule.publish || []).includes(user))
      for (const version of publisher ? versions : []) {
        const res = await call(base, 'PUT', packageRoute(name), { token: logins[publisher], body: packument(name, version) })
        if (res.status !== 201) {
          throw new Error(`setup: ${name}@${version} was not published by ${publisher} (HTTP ${res.status} ${res.text})`)
        }
      }
    }
    const tokens = new Map()
    const keys = new Map()
    for (const [fake, entry] of Object.entries(state.tokens || {})) {
      if (entry.login) {
        tokens.set(fake, logins[entry.user])
        continue
      }
      const minted = await mintToken(base, logins[entry.user], users[entry.user].password, Boolean(entry.readonly))
      tokens.set(fake, minted.token)
      if (entry.key) {
        keys.set(entry.key, minted.key)
      }
      if (entry.dead) {
        const res = await call(base, 'DELETE', `/-/npm/v1/tokens/token/${encodeURIComponent(minted.key)}`, { token: logins[entry.user] })
        if (res.status !== 200) {
          throw new Error(`setup: the key of ${fake} was not revoked (HTTP ${res.status} ${res.text})`)
        }
      }
    }
    await server.stop()
    server = await start(bin, writeConfig(root, { rules, maxUsers: state.registration === 'open' ? 1000 : -1, jwt, flags }))
    return {
      url: server.url,
      tokens,
      keys,
      logins,
      output: () => server.output(),
      stop: async () => {
        await server.stop()
        fs.rmSync(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    if (server) {
      error.message += `\n--- verdaccio ---\n${server.output().slice(-2000)}`
      await server.stop()
    }
    fs.rmSync(root, { recursive: true, force: true })
    throw error
  }
}

// A proxy the provider (and the harness, for what npm would send) talks to:
// it records every exchange with the real server and relays it. Requests
// carrying `x-harness: npm` are npm's, the others the provider's.
const startProxy = (upstream) =>
  new Promise((resolve) => {
    const records = []
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', async () => {
        const raw = Buffer.concat(chunks)
        const route = req.url.startsWith(`${PREFIX}/`) ? req.url.slice(PREFIX.length) : null
        if (route === null) {
          res.writeHead(404)
          res.end()
          return
        }
        const headers = { ...req.headers }
        for (const name of ['host', 'connection', 'content-length', 'transfer-encoding']) {
          delete headers[name]
        }
        try {
          const response = await fetch(`${upstream}${route}`, { method: req.method, headers, body: raw.length ? raw : undefined })
          const text = await response.text()
          const answered = Object.fromEntries(response.headers)
          let json = null
          try {
            json = text ? JSON.parse(text) : null
          } catch {
            json = null
          }
          let body = null
          try {
            body = raw.length ? JSON.parse(raw.toString('utf8')) : null
          } catch {
            body = null
          }
          records.push({ src: req.headers['x-harness'] ? 'npm' : 'provider', method: req.method, route, headers: req.headers, body, status: response.status, answered, json })
          for (const name of ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']) {
            delete answered[name]
          }
          res.writeHead(response.status, answered)
          res.end(text)
        } catch (error) {
          res.writeHead(502)
          res.end(String(error))
        }
      })
    })
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        records,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections()
            server.close(done)
          }),
      }),
    )
  })

module.exports = { PREFIX, call, loginToken, mintToken, packument, packageRoute, realize, startProxy, jwtShaped, userRoute }
