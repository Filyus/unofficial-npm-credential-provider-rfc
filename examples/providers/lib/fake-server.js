'use strict'
// A stand-in for a vendor's API on 127.0.0.1, for the conformance run only.
// A provider's fake answers each request from a state the scenario sets,
// the way the vendor documents it; the server records every request so a
// scenario can check what the provider asked for.

const http = require('node:http')

const startFake = (handle) =>
  new Promise((resolve) => {
    const requests = []
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body = null
        if (raw) {
          body = req.headers['content-type']?.includes('json')
            ? JSON.parse(raw)
            : Object.fromEntries(new URLSearchParams(raw))
        }
        const url = new URL(req.url, 'http://fake')
        const token = (req.headers.authorization || '').replace(/^Bearer /, '') || null
        const request = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), token, body }
        requests.push(request)
        let answer
        try {
          answer = handle(request) || { status: 404, json: { error: 'no such route' } }
        } catch (error) {
          answer = { status: 500, json: { error: error.message } }
        }
        res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.headers || {}) })
        res.end(answer.json === undefined ? '' : JSON.stringify(answer.json))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections()
            server.close(done)
          }),
      })
    })
  })

module.exports = { startFake }
