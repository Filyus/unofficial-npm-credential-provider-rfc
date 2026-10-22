'use strict'
// What a scenario's state becomes on a real GitLab, and the plumbing around it: an HTTP
// client, the instance set up once through GitLab's own interfaces (an admin token made in
// the Rails console, then the REST API for users, a group, projects, a package and an
// OAuth application), a scripted person who signs in on the web and approves a device
// code, and a recording proxy the provider talks through.

const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const http = require('node:http')
const { packument } = require('./world.js')

const TRACE = Boolean(process.env.GITLAB_LIVE_TRACE)
const trace = (...args) => {
  if (TRACE) {
    console.log('   ', ...args)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const random = (length) => crypto.randomBytes(length).toString('hex').slice(0, length)

const call = async (base, method, route, { token, basic, body, form, headers, cookie, redirect = 'manual', timeoutMs = 120000 } = {}) => {
  const sent = { ...(headers || {}) }
  if (token) {
    sent.authorization = `Bearer ${token}`
  } else if (basic) {
    sent.authorization = `Basic ${Buffer.from(basic).toString('base64')}`
  }
  if (cookie) {
    sent.cookie = cookie
  }
  let payload
  if (form) {
    sent['content-type'] = 'application/x-www-form-urlencoded'
    payload = new URLSearchParams(form).toString()
  } else if (body !== undefined) {
    sent['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const response = await fetch(`${base}${route}`, { method, headers: sent, body: payload, redirect, signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: response.status, headers: Object.fromEntries(response.headers), setCookie: response.headers.getSetCookie(), json, text }
}

// ------------------------------------------------------------------ the Rails console

// `docker exec <container> gitlab-rails runner <ruby>`: the ruby prints `RESULT:<json>`; the
// last such line is returned, parsed. Slow (about half a minute a call), so few and batched.
const rails = (container, ruby) => {
  const result = spawnSync('docker', ['exec', container, 'gitlab-rails', 'runner', ruby], { encoding: 'utf8', timeout: 600000 })
  if (result.status !== 0) {
    throw new Error(`gitlab-rails runner failed (${result.status}):\n${result.stdout}\n${result.stderr}`)
  }
  const line = result.stdout.split('\n').reverse().find((text) => text.startsWith('RESULT:'))
  if (!line) {
    throw new Error(`gitlab-rails runner printed no RESULT line:\n${result.stdout}\n${result.stderr}`)
  }
  return JSON.parse(line.slice('RESULT:'.length))
}

// ------------------------------------------------------------------ the web, as a person

const decode = (text) => text.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const attrsOf = (text) => Object.fromEntries([...text.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((match) => [match[1], decode(match[2] ?? match[3] ?? '')]))
const formsOf = (html) =>
  [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map((match) => {
    const attrs = attrsOf(match[1])
    const inner = match[2]
    const fields = [...inner.matchAll(/<input\b([^>]*)>/gi)].map((input) => attrsOf(input[1])).filter((input) => input.name).map((input) => ({ name: input.name, value: input.value ?? '', type: (input.type || 'text').toLowerCase() }))
    const buttons = [...inner.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)].map((button) => ({ ...attrsOf(button[1]), text: decode(button[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() }))
    return { action: attrs.action || '', method: (attrs.method || 'get').toLowerCase(), fields, buttons }
  })
const titleOf = (html) => (/<title>([\s\S]*?)<\/title>/i.exec(html) || [])[1]?.replace(/\s+/g, ' ').trim()
const textOf = (html) => decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()

// A browser with a cookie jar: follows redirects by hand, so each page is seen.
class Web {
  constructor(base) {
    this.base = base
    this.jar = new Map()
  }

  async fetch(target, { form } = {}) {
    let url = new URL(target, this.base)
    let method = form ? 'POST' : 'GET'
    let payload = form
    for (let hops = 0; hops < 10; hops += 1) {
      const cookie = [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ')
      const res = await call(url.origin, method, url.pathname + url.search, { form: payload, cookie, headers: { accept: 'text/html' } })
      for (const set of res.setCookie) {
        const [pair] = set.split(';')
        const at = pair.indexOf('=')
        this.jar.set(pair.slice(0, at), pair.slice(at + 1))
      }
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        url = new URL(res.headers.location, url)
        // the instance's own external URL is http://localhost:8929, and so is `base`
        method = 'GET'
        payload = undefined
        continue
      }
      return { status: res.status, url: url.href, html: res.text }
    }
    throw new Error('too many redirects')
  }

  async signIn(login, password) {
    const page = await this.fetch('/users/sign_in')
    const form = formsOf(page.html).find((candidate) => candidate.fields.some((field) => field.name === 'user[login]'))
    if (!form) {
      throw new Error(`no sign-in form at ${page.url} (HTTP ${page.status}, title ${titleOf(page.html)}): ${textOf(page.html).slice(0, 300)}`)
    }
    const fields = Object.fromEntries(form.fields.map((field) => [field.name, field.value]))
    fields['user[login]'] = login
    fields['user[password]'] = password
    const after = await this.fetch(form.action || '/users/sign_in', { form: fields })
    if (formsOf(after.html).some((candidate) => candidate.fields.some((field) => field.name === 'user[login]'))) {
      throw new Error(`signing in as ${login} failed at ${after.url} (HTTP ${after.status}): ${textOf(after.html).slice(0, 300)}`)
    }
    return after
  }
}

// The person who has the code: opens the verification page, types the user code, and
// presses the button that authorizes. What is on each page is traced, and what could not
// be done is said with the page's text, since the forms are read from the HTML.
const approveDevice = async (web, device) => {
  let page = await web.fetch(device.verification_uri_complete || `${device.verification_uri}?user_code=${encodeURIComponent(device.user_code)}`)
  for (let step = 0; step < 6; step += 1) {
    const forms = formsOf(page.html)
    trace(`device page ${step}: ${page.url} HTTP ${page.status} "${titleOf(page.html)}" forms ${JSON.stringify(forms.map((form) => ({ action: form.action, fields: form.fields.map((f) => f.name), buttons: form.buttons.map((b) => b.text || b.name) })))}`)
    const confirm = forms.find((form) => form.buttons.some((button) => /authori[sz]e/i.test(`${button.text} ${button.value || ''}`)) && !form.fields.some((field) => field.name === '_method' && field.value === 'delete'))
    const typing = forms.find((form) => form.fields.some((field) => /user_code/.test(field.name)))
    if (confirm) {
      const fields = Object.fromEntries(confirm.fields.map((field) => [field.name, field.value]))
      const button = confirm.buttons.find((candidate) => /authori[sz]e/i.test(`${candidate.text} ${candidate.value || ''}`))
      if (button.name) {
        fields[button.name] = button.value ?? ''
      }
      page = await web.fetch(confirm.action, { form: fields })
      trace(`device page after authorizing: ${page.url} HTTP ${page.status} "${titleOf(page.html)}": ${textOf(page.html).slice(0, 200)}`)
      return page
    }
    if (typing) {
      const fields = Object.fromEntries(typing.fields.map((field) => [field.name, field.value]))
      const name = typing.fields.find((field) => /user_code/.test(field.name)).name
      fields[name] = device.user_code
      page = await web.fetch(typing.action || page.url, { form: fields })
      continue
    }
    break
  }
  throw new Error(`could not approve the device code: at ${page.url} (HTTP ${page.status}, "${titleOf(page.html)}"): ${textOf(page.html).slice(0, 400)}`)
}

// ------------------------------------------------------------------ the instance

const expiryDate = (seconds) => new Date((Math.floor(seconds / 86400) + 1) * 86400 * 1000).toISOString().slice(0, 10)
const packageRoute = (name) => `/${name.replace('/', '%2f')}`

// The instance as one run sets it up. Everything here is made once; a scenario then
// resets what it touches (`reset`) and makes the tokens it needs (`realize`).
const setUpInstance = async ({ url, container, log }) => {
  const step = async (name, fn, { optional = false } = {}) => {
    try {
      const value = await fn()
      log(`setup: ${name}`)
      return value
    } catch (error) {
      log(`setup: ${name} FAILED${optional ? ' (optional)' : ''}: ${error.message}`)
      if (!optional) {
        throw error
      }
      return null
    }
  }
  const instance = { url, container, users: {}, sessions: {}, skipped: {} }
  const admin = `glpat-${random(20)}`
  instance.admin = admin
  await step('admin token from the Rails console', async () => {
    rails(
      container,
      `user = User.find_by_username('root')
token = user.personal_access_tokens.create(scopes: [:api], name: 'live-harness', expires_at: 30.days.from_now.to_date)
token.set_token('${admin}')
token.save!
puts 'RESULT:' + JSON.generate({ id: token.id })`,
    )
  })
  const api = (method, route, options = {}) => call(url, method, `/api/v4${route}`, { token: admin, ...options })
  instance.api = api
  const must = async (what, promise, statuses = [200, 201]) => {
    const res = await promise
    if (!statuses.includes(res.status)) {
      throw new Error(`${what}: HTTP ${res.status} ${res.text.slice(0, 500)}`)
    }
    return res.json
  }
  const version = await step('version', async () => must('version', api('GET', '/version')))
  instance.version = version.version
  instance.revision = version.revision
  log(`GitLab ${version.version} (revision ${version.revision}, enterprise: ${version.enterprise})`)

  await step('rate limits off', async () => {
    const res = await api('PUT', '/application/settings', {
      body: {
        throttle_protected_paths_enabled: false,
        throttle_unauthenticated_api_enabled: false,
        throttle_authenticated_api_enabled: false,
        throttle_unauthenticated_web_enabled: false,
        throttle_authenticated_web_enabled: false,
        throttle_unauthenticated_packages_api_enabled: false,
        throttle_authenticated_packages_api_enabled: false,
        throttle_unauthenticated_enabled: false,
        signup_enabled: false,
        usage_ping_enabled: false,
      },
    })
    if (res.status !== 200) {
      throw new Error(`HTTP ${res.status} ${res.text.slice(0, 300)}`)
    }
  }, { optional: true })

  const group = await step('group acme', () => must('group', api('POST', '/groups', { body: { name: 'acme', path: 'acme', visibility: 'private' } })))
  instance.group = group
  for (const [name, level] of [['maint', 40], ['dev', 30], ['outsider', null]]) {
    const password = `Pw-${random(24)}`
    const user = await step(`user ${name}`, () => must(`user ${name}`, api('POST', '/users', { body: { email: `${name}@example.test`, username: name, name: `Live ${name}`, password, skip_confirmation: true, projects_limit: 0 } })))
    instance.users[name] = { id: user.id, username: name, password, level }
  }
  instance.projects = {}
  for (const name of ['widgets', 'other']) {
    const project = await step(`project acme/${name}`, () => must(`project ${name}`, api('POST', '/projects', { body: { name, path: name, namespace_id: group.id, visibility: 'private', initialize_with_readme: true } })))
    instance.projects[name] = { id: String(project.id), path: project.path_with_namespace, defaultBranch: project.default_branch }
    for (const user of Object.values(instance.users).filter((candidate) => candidate.level)) {
      if (name === 'widgets') {
        await step(`${user.username} is a member of ${name}`, () => must('member', api('POST', `/projects/${project.id}/members`, { body: { user_id: user.id, access_level: user.level } })))
      }
    }
  }
  const app = await step('OAuth application', () =>
    must('application', api('POST', '/applications', { body: { name: 'npm-credential-provider-gitlab', redirect_uri: 'http://localhost/callback', scopes: 'api', confidential: false, device_code_enabled: true } })),
  )
  instance.clientId = app.application_id
  // the device authorization grant is a setting of the application (`device_code_enabled`, off for
  // an application the API creates, whatever the request says); an administrator turns it on in the
  // application's settings, which is the Rails console here, and it is said whether it was needed
  await step('device authorization works', async () => {
    const ask = () => call(url, 'POST', '/oauth/authorize_device', { form: { client_id: instance.clientId, scope: 'api' } })
    let res = await ask()
    log(`setup: device authorization of an application the API made: HTTP ${res.status} ${res.text.slice(0, 160)}`)
    if (res.status !== 200) {
      rails(container, `app = Doorkeeper::Application.find_by(uid: '${instance.clientId}')\napp.update!(device_code_enabled: true)\nputs 'RESULT:' + JSON.generate({ device_code_enabled: app.reload.device_code_enabled })`)
      res = await ask()
      log(`setup: device authorization after device_code_enabled was turned on in the console: HTTP ${res.status} ${res.text.slice(0, 200)}`)
    }
    if (res.status !== 200) {
      throw new Error('the device authorization grant is not available')
    }
  }, { optional: true })
  await step('the package @acme/widgets 2.4.0', () => publish(instance, instance.projects.widgets.id, '@acme/widgets', '2.4.0', admin))
  return instance
}

const publish = async (instance, projectId, name, version, token) => {
  const res = await call(instance.url, 'PUT', `/api/v4/projects/${projectId}/packages/npm${packageRoute(name)}`, { token, body: packument(name, version) })
  if (res.status >= 300) {
    throw new Error(`publishing ${name}@${version} to project ${projectId}: HTTP ${res.status} ${res.text.slice(0, 300)}`)
  }
  return res
}

// What a scenario may have left in the widgets project: deploy tokens, packages but 2.4.0.
const reset = async (instance, log) => {
  const project = instance.projects.widgets.id
  const tokens = await instance.api('GET', `/projects/${project}/deploy_tokens?per_page=100`)
  for (const token of tokens.json || []) {
    await instance.api('DELETE', `/projects/${project}/deploy_tokens/${token.id}`)
  }
  const packages = await instance.api('GET', `/projects/${project}/packages?per_page=100&package_type=npm`)
  let kept = false
  for (const entry of packages.json || []) {
    if (entry.name === '@acme/widgets' && entry.version === '2.4.0' && !kept) {
      kept = true
    } else {
      const res = await instance.api('DELETE', `/projects/${project}/packages/${entry.id}`)
      log && trace(`reset: package ${entry.name}@${entry.version} deleted: HTTP ${res.status}`)
    }
  }
  if (!kept) {
    await publish(instance, project, '@acme/widgets', '2.4.0', instance.admin)
  }
}

// ------------------------------------------------------------------ tokens

const webFor = async (instance, username) => {
  if (!instance.sessions[username]) {
    const web = new Web(instance.url)
    await web.signIn(username, instance.users[username].password)
    instance.sessions[username] = web
  }
  return instance.sessions[username]
}

// An OAuth access and refresh token for `username`, as the device authorization grant
// gives them: the code asked for, a person (signed in on the web) approving it, the token
// endpoint polled.
const oauthPair = async (instance, username) => {
  const device = await call(instance.url, 'POST', '/oauth/authorize_device', { form: { client_id: instance.clientId, scope: 'api' } })
  if (device.status !== 200 || !device.json?.device_code) {
    if (instance.deviceGrantWorks === false || process.env.GITLAB_LIVE_POOL === '1') {
      return pooledPair(instance, username)
    }
    instance.deviceGrantWorks = false
    console.log(`the device authorization grant is refused (HTTP ${device.status} ${device.text.slice(0, 200)}): OAuth tokens come from the Rails console instead`)
    return pooledPair(instance, username)
  }
  await approveDevice(await webFor(instance, username), device.json)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const res = await call(instance.url, 'POST', '/oauth/token', { form: { client_id: instance.clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.json.device_code } })
    if (res.status === 200 && res.json?.access_token) {
      return { access: res.json.access_token, refresh: res.json.refresh_token, expiresIn: res.json.expires_in }
    }
    const code = res.json?.error
    if (code !== 'authorization_pending' && code !== 'slow_down') {
      throw new Error(`device token: HTTP ${res.status} ${res.text.slice(0, 300)}`)
    }
    await sleep(code === 'slow_down' ? 6000 : 1500)
  }
  throw new Error('the device code was not approved')
}

// the person approves a device code the provider showed
const approve = async (instance, username, device) => approveDevice(await webFor(instance, username), device)

// OAuth tokens made by Doorkeeper in the Rails console, for an instance whose device grant
// cannot be used: a pool of them, made in one call since each call takes half a minute.
const pooledPair = async (instance, username) => {
  if (!instance.pool) {
    const made = rails(
      instance.container,
      `app = Doorkeeper::Application.find_by(uid: '${instance.clientId}')
out = {}
{ 'maint' => 20, 'dev' => 3 }.each do |name, count|
  user = User.find_by_username(name)
  out[name] = (1..count).map do
    t = Doorkeeper::AccessToken.create!(application_id: app.id, resource_owner_id: user.id, scopes: 'api', expires_in: 7200, use_refresh_token: true, organization_id: Organizations::Organization.default_organization.id)
    { access: t.plaintext_token, refresh: t.plaintext_refresh_token }
  end
end
puts 'RESULT:' + JSON.generate(out)`,
    )
    instance.pool = made
  }
  const pair = instance.pool[username].shift()
  if (!pair) {
    throw new Error(`the pool of OAuth tokens for ${username} is empty`)
  }
  return { access: pair.access, refresh: pair.refresh, expiresIn: 7200 }
}

const revokeOauth = (instance, token) => call(instance.url, 'POST', '/oauth/revoke', { form: { client_id: instance.clientId, token } })

const createDeployToken = async (instance, projectId, { scopes, name, expires }) => {
  const res = await instance.api('POST', `/projects/${projectId}/deploy_tokens`, { body: { name: name || `live ${random(6)}`, scopes, expires_at: expires || expiryDate(Date.now() / 1000 + 3600) } })
  if (res.status !== 201 || !res.json?.token) {
    throw new Error(`deploy token: HTTP ${res.status} ${res.text.slice(0, 300)}`)
  }
  return res.json
}

// A CI job token for a running job of `projectId`, made in the Rails console: a pipeline
// and one running job of the maint user.
const jobToken = (instance, projectId) =>
  rails(
    instance.container,
    `project = Project.find(${Number(projectId)})
user = User.find_by_username('maint')
ref = project.default_branch
sha = project.repository.commit(ref).sha
partition = (Ci::Partition.current.id rescue nil) || 100
pipeline = Ci::Pipeline.new(project: project, ref: ref, sha: sha, source: :push, user: user, status: 'running', partition_id: partition)
pipeline.save!(validate: false)
stage = Ci::Stage.new(project: project, pipeline: pipeline, name: 'test', position: 0, partition_id: pipeline.partition_id)
stage.save!(validate: false)
attrs = { project: project, pipeline: pipeline, user: user, name: 'live', ref: ref, stage_id: stage.id, stage_idx: 0, status: 'running', partition_id: pipeline.partition_id }
build = nil
10.times do
  begin
    build = Ci::Build.new(attrs)
    break
  rescue ActiveModel::UnknownAttributeError => e
    attrs.delete(e.attribute.to_sym)
  end
end
build.save!(validate: false)
puts 'RESULT:' + JSON.generate({ token: build.token, id: build.id })`,
  )

// ------------------------------------------------------------------ the recording proxy

const parseBody = (raw, type) => {
  if (!raw.length) {
    return null
  }
  const text = raw.toString('utf8')
  try {
    if ((type || '').includes('json')) {
      return JSON.parse(text)
    }
    if ((type || '').includes('x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(text))
    }
  } catch {
    return null
  }
  return null
}

// A proxy the provider (and the harness, for what npm would send) talks to: every
// exchange with the real server is recorded and relayed, redirects as they are. Requests
// carrying `x-harness` are npm's (its value says what for), the others the provider's.
// `before(record)` may change the world before the request is relayed (a scenario's
// concurrent logout); `after(record)` before the answer is (the person approving a code).
const startProxy = (upstream, { before, after } = {}) =>
  new Promise((resolve) => {
    const records = []
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', async () => {
        const raw = Buffer.concat(chunks)
        const headers = { ...req.headers }
        for (const name of ['host', 'connection', 'content-length', 'transfer-encoding', 'x-conformance-clock', 'x-harness']) {
          delete headers[name]
        }
        try {
          const record = { src: req.headers['x-harness'] ? 'npm' : 'provider', harness: req.headers['x-harness'] || null, method: req.method, route: req.url, headers: req.headers, body: parseBody(raw, req.headers['content-type']) }
          if (before) {
            await before(record)
          }
          const response = await fetch(`${upstream}${req.url}`, { method: req.method, headers, body: raw.length ? raw : undefined, redirect: 'manual' })
          const text = await response.text()
          const answered = Object.fromEntries(response.headers)
          let json = null
          try {
            json = text ? JSON.parse(text) : null
          } catch {
            json = null
          }
          Object.assign(record, { status: response.status, answered, json })
          records.push(record)
          if (after) {
            await after(record)
          }
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

module.exports = { call, rails, Web, formsOf, titleOf, textOf, setUpInstance, publish, reset, oauthPair, approve, revokeOauth, createDeployToken, jobToken, startProxy, expiryDate, packageRoute, sleep, trace }
