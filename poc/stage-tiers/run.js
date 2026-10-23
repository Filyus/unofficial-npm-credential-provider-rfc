'use strict'

// The live test in phase-2-implementation.md ("The npmjs.com stage token test"): which npmjs.com tokens serve the
// staged-publishing reads. It is run by hand, by whoever owns the tokens.
//
//   node poc/stage-tiers/run.js pack <dir> <package-name> <version>
//     writes a minimal package to stage (package.json and a README that says
//     not to approve it), so no real build is needed
//
//   node poc/stage-tiers/run.js check <token-dir> <stage-id> <package-name>
//     sends R1-R4 of that test once without credentials and once
//     per token file, and prints what came back
//
// <token-dir> holds one file per token, named after the test plan: T1, T2,
// T3, T4, T5, T6, T3b, with or without a .txt or .npmrc extension. A file
// holds the bare token, or an .npmrc line `//registry.npmjs.org/:_authToken=…`
// (what `npm login --userconfig <file>` writes). Missing files are skipped.
//
// Tokens never reach argv, the output or the results file: each is read from
// its file, sent only to registry.npmjs.org, and redacted from every body
// printed. Redirects are not followed, so a tarball served from another host
// never sees the Authorization header; the Location host is reported instead.

const fs = require('fs')
const path = require('path')

const REGISTRY = 'https://registry.npmjs.org'
const TOKENS = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T3b']

const usage = () => {
  console.error('usage: node poc/stage-tiers/run.js pack <dir> <package-name> <version>')
  console.error('       node poc/stage-tiers/run.js check <token-dir> <stage-id> <package-name>')
  process.exit(2)
}

const pack = (dir, name, version) => {
  if (!name || !version) {
    usage()
  }
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    console.error(`${dir} is not empty; pick a new directory`)
    process.exit(1)
  }
  fs.mkdirSync(dir, { recursive: true })
  const note = 'Staged only to test which npm tokens can read /-/stage. Do not approve; reject it.'
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name,
    version,
    description: note,
    files: ['README.md'],
    publishConfig: { access: 'public', tag: 'tokentest' },
  }, null, 2) + '\n')
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}@${version}\n\n${note}\n`)
  console.log(`wrote ${name}@${version} to ${dir}; dist-tag "tokentest", so even an approval would not move "latest"`)
}

const readToken = file => {
  const text = fs.readFileSync(file, 'utf8')
  const npmrc = /^\s*\/\/registry\.npmjs\.org\/:_authToken\s*=\s*(\S+)\s*$/m.exec(text)
  const token = (npmrc ? npmrc[1] : text).trim()
  if (!token || /\s/.test(token)) {
    throw new Error(`${path.basename(file)} does not hold one token or one _authToken line`)
  }
  return token
}

const findTokens = dir => {
  const files = fs.readdirSync(dir)
  return TOKENS.flatMap(name => {
    const file = files.find(f => f === name || f === `${name}.txt` || f === `${name}.npmrc`)
    return file ? [{ name, token: readToken(path.join(dir, file)) }] : []
  })
}

// how many staged items a list body holds, whatever the envelope
const countItems = body => {
  if (Array.isArray(body)) {
    return body.length
  }
  for (const key of ['objects', 'items', 'data', 'results', 'stages']) {
    if (body && Array.isArray(body[key])) {
      return body[key].length
    }
  }
  return null
}

const request = async (url, token) => {
  const headers = { accept: 'application/json' }
  if (token) {
    headers.authorization = `Bearer ${token}`
  }
  const res = await fetch(url, { headers, redirect: 'manual' })
  const redact = text => token ? text.split(token).join('<token>') : text
  const out = {
    status: res.status,
    wwwAuthenticate: res.headers.get('www-authenticate'),
    npmNotice: res.headers.get('npm-notice'),
  }
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location')
    out.redirectHost = location ? new URL(location, url).host : null
    await res.body?.cancel()
    return out
  }
  if (url.endsWith('/tarball')) {
    // only whether it is served; the bytes do not matter
    out.contentType = res.headers.get('content-type')
    await res.body?.cancel()
    return out
  }
  const text = redact(await res.text())
  try {
    const json = JSON.parse(text)
    out.items = countItems(json)
    out.body = json
  } catch {
    out.body = text.slice(0, 300)
  }
  return out
}

const check = async (dir, stageId, pkg) => {
  if (!stageId || !pkg) {
    usage()
  }
  const tokens = findTokens(dir)
  if (!tokens.length) {
    console.error(`no token files (${TOKENS.join(', ')}) in ${dir}`)
    process.exit(1)
  }
  const requests = [
    ['R1', `${REGISTRY}/-/stage?page=0&perPage=100`],
    ['R2', `${REGISTRY}/-/stage?page=0&perPage=100&package=${encodeURIComponent(pkg)}`],
    ['R3', `${REGISTRY}/-/stage/${encodeURIComponent(stageId)}`],
    ['R4', `${REGISTRY}/-/stage/${encodeURIComponent(stageId)}/tarball`],
  ]
  const results = []
  for (const { name, token } of [{ name: 'none', token: null }, ...tokens]) {
    for (const [id, url] of requests) {
      let r
      try {
        r = await request(url, token)
      } catch (err) {
        r = { error: err.message }
      }
      const seesStage = r.body !== undefined && JSON.stringify(r.body).includes(stageId)
      results.push({ token: name, request: id, ...r, seesStage })
      const parts = [
        `${name.padEnd(4)} ${id}`,
        r.error ? `error ${r.error}` : String(r.status),
        r.items != null ? `${r.items} items` : '',
        id !== 'R4' && r.status === 200 ? (seesStage ? 'stage S present' : 'stage S absent') : '',
        r.redirectHost ? `redirect to ${r.redirectHost}` : '',
        r.wwwAuthenticate ? `WWW-Authenticate: ${r.wwwAuthenticate}` : '',
        r.npmNotice ? `npm-notice: ${r.npmNotice}` : '',
        r.status >= 400 && r.body ? `body: ${JSON.stringify(r.body).slice(0, 160)}` : '',
      ]
      console.log(parts.filter(Boolean).join('  '))
    }
  }
  // stage ids and package names are not secrets; tokens never enter `results`
  const file = path.join(dir, 'results.json')
  fs.writeFileSync(file, JSON.stringify({ stageId, package: pkg, at: new Date().toISOString(), results }, null, 2) + '\n')
  console.log(`\nwrote ${file} (no tokens in it)`)
}

const [mode, ...args] = process.argv.slice(2)
if (mode === 'pack') {
  pack(...args)
} else if (mode === 'check') {
  check(...args).catch(err => {
    console.error(err.message)
    process.exit(1)
  })
} else {
  usage()
}
