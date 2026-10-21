'use strict'
// A reference provider for the Azure Artifacts example (examples/azure-artifacts.md):
// a Microsoft Entra sign-in by device code, the refresh token kept in the
// store (the OS keychain in a real build), short-lived session tokens minted
// from it with the SessionTokens API, and in a pipeline the job token or the
// identity's own Entra token. One credential serves the whole organization,
// so the provider keeps one cache per organization, whatever feed a request
// names.
//
// What comes from the page: the hello and its registries, one session token
// with `vso.packaging_write` for read, publish, deprecate and dist-tag (an
// install that saves a version from an upstream needs it), a package-bound
// `vso.packaging_manage` token for unpublish, basic for session tokens and
// PATs and bearer for Entra and job tokens, the authority found from the
// feed's X-VSS-ResourceTenant and WWW-Authenticate headers and checked
// against an allowlist of the provider's own (credprovider's cover the feed
// and SPS hosts), the 90 seconds of the device flow, a 403 answered
// `other` and never by a wider token, and a retry that would get the same
// Entra token again answered with a diagnosis. Beyond the page, as this
// provider's own policy: an interactive write (publish, deprecate, dist-tag,
// unpublish) asks the person first, and the machine's own Entra token serves a
// write with no one to ask only where `ciPublisher` in the provider's
// configuration says so; a new login revokes what the replaced one minted.
// Recalled, not read, and so unverified here: the SessionTokens paths, query
// and fields and the way a token is revoked (DELETE with `authorizationId`),
// the Entra v2.0 device-code and token endpoint shapes (these are the
// documented OAuth 2.0 ones), the members of the authority allowlist, `SYSTEM_COLLECTIONURI`
// as the organization a job token belongs to, that the registry URL answers an
// unauthenticated request with the tenant headers and an authenticated one
// with 200. Read in Microsoft's documents: `az account get-access-token`'s
// output fields `accessToken` and `expires_on` (Azure CLI 2.54.0 and later), and
// that a YAML pipeline must map `System.AccessToken` into `env`. ILLUSTRATIVE: the
// client id, and `https://az.example.test/`, which stands for running
// `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798`
// (a run cannot depend on az being installed, so the fake answers it over HTTP).

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { serve, ok, err, log, Answer } = require('../lib/protocol.js')
const { loadContext, plain } = require('../lib/context.js')

const CLIENT_ID = 'example-npm-credential-provider'
const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798'
const ENTRA_SCOPE = `${AZURE_DEVOPS_RESOURCE}/.default offline_access`
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
// authorities the provider signs in at: https, one of these hosts, the tenant as the path
const AUTHORITY_HOSTS = new Set(['login.microsoftonline.com', 'login.windows.net', 'login.microsoft.com', 'sts.windows.net'])
const TENANT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9.-]+)$/i
// Entra's multi-tenant endpoints: a sign-in there picks its own tenant, and a feed names one
const MULTI_TENANT = new Set(['common', 'organizations', 'consumers'])
const isTenant = (value) => TENANT.test(value) && !MULTI_TENANT.has(value.toLowerCase())
const WRITE_SCOPE = 'vso.packaging_write'
const MANAGE_SCOPE = 'vso.packaging_manage'
// The credprovider's default for a SelfDescribing token; a manage token is
// short, since nothing may depend on revoking it after stdin closes.
const SESSION_SECONDS = 4 * 3600
const MANAGE_SECONDS = 15 * 60
// An access token with less than this left is renewed before use.
const ACCESS_MARGIN = 60
// The credprovider's device flow gives up after 90 seconds, inside the
// 5-minute budget of an interactive request.
const DEVICE_WAIT_MS = 90 * 1000
const SERVED_OPERATIONS = new Set(['read', 'publish', 'deprecate', 'dist-tag', 'unpublish'])
const AZ_URL = 'https://az.example.test/get-access-token'
const PAT_USERNAME = 'npm'
// the time npm gives a `logout` is 30 seconds; the calls it makes end inside it
const LOGOUT_MS = 25 * 1000
// inside npm's 5 minutes for an interactive `get`, as the AWS provider's prompts are
const PRESENCE_MS = 4.5 * 60 * 1000
// how a write names itself in the presence prompt
const WRITES = {
  publish: 'Publish',
  deprecate: 'Deprecate',
  'dist-tag': 'Change the dist-tags of',
  unpublish: 'Unpublish',
}

// a protocol answer raised from deep inside a helper (lib's `Answer`, which `serve` answers itself)
const fail = (message) => new Answer(err('other', message))

const nameOf = (req) => (req.scope ? `${req.scope}/${req.package}` : req.package)

// `https://login.microsoftonline.com/<tenant>`, or null for anything else
const checkedAuthority = (value) => {
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const tenant = url.pathname.replace(/^\/|\/$/g, '')
  if (url.protocol !== 'https:' || !AUTHORITY_HOSTS.has(url.hostname) || url.port || url.username || url.search || !isTenant(tenant)) {
    return null
  }
  return `https://${url.hostname}/${tenant}`
}

const start = (args) => {
  const ctx = loadContext(args.config)
  const org = args.org || ctx.config.org
  if (!org || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(org)) {
    throw new Error('--org, or org in the configuration, names the organization this provider serves')
  }
  // an exact prefix: the path in the casing the user's config has, the legacy host in lowercase as
  // npm compares hosts, and `https:` only
  const prefixes = [`https://pkgs.dev.azure.com/${org}/`, `https://${org.toLowerCase()}.pkgs.visualstudio.com/`]
  // Judged on the parsed URL, whose path is normalised: a prefix of the raw text
  // would serve `https://pkgs.dev.azure.com/contoso/../other-org/`, which a
  // registry client resolves to another organization. https only, the default
  // port, no user information.
  const served = (registry) => {
    let url
    try {
      url = new URL(registry)
    } catch {
      return false
    }
    if (url.protocol !== 'https:' || url.port || url.username || url.password) {
      return false
    }
    return prefixes.some((prefix) => {
      const own = new URL(prefix)
      return url.host === own.host && url.pathname.startsWith(own.pathname)
    })
  }
  const sessionsUrl = (extra) => `https://vssps.dev.azure.com/${org}/_apis/Token/SessionTokens?api-version=7.1-preview.1${extra}`

  // what this provider keeps for the organization: { authority, refreshToken,
  // accessToken, accessExpiresAt, pat, session: { token, expiresAt }, minted,
  // signIn }, `signIn` being the id of the login or PAT that made the entry
  const readAccount = () => ctx.readStore()[org] || {}
  const writeAccount = (account) => {
    const store = ctx.readStore()
    if (Object.keys(account).length) {
      store[org] = account
    } else {
      delete store[org]
    }
    ctx.writeStore(store)
  }

  // What a call changed in an account object it read earlier (a long install: a
  // refresh or a mint takes time, and `npm logout` or `npm login` may run in
  // another process meanwhile). The store is read again, and the keys are written
  // onto what it holds only if that is still the same sign-in; an entry that was
  // removed stays removed, and one that another login replaced is not overwritten
  // with the stale one. A key the object no longer has is removed. Returns
  // whether anything was written.
  const persist = (account, keys) => {
    const store = ctx.readStore()
    const current = store[org]
    if (!current || !Object.keys(current).length || current.signIn !== account.signIn) {
      return false
    }
    for (const key of keys) {
      if (account[key] === undefined) {
        delete current[key]
      } else {
        current[key] = account[key]
      }
    }
    ctx.writeStore(store)
    return true
  }

  // the Entra token last handed out bare, and the one the registry rejected,
  // to tell a token source that serves the same token again
  let bare = null
  let rejected = null

  // --- the Entra authority -------------------------------------------------

  // The feed's own answer to a request without credentials names the tenant
  // (X-VSS-ResourceTenant) and the authority (`authorization_uri` of
  // WWW-Authenticate). The request's `authChallenges` are never used for it.
  const findAuthority = async (registry) => {
    const probed = await ctx.request('GET', registry)
    const tenant = (probed.headers['x-vss-resourcetenant'] || '').split(',')[0].trim()
    const challenge = /authorization_uri="([^"]*)"/i.exec(probed.headers['www-authenticate'] || '')
    const named = challenge && checkedAuthority(challenge[1])
    if (challenge && !named) {
      throw fail(`Azure Artifacts named a Microsoft Entra authority that is not on the allowlist, so no sign-in was started for the ${org} organization.`)
    }
    if (!named && !isTenant(tenant)) {
      throw fail(`Azure Artifacts did not say which Microsoft Entra tenant the ${org} organization belongs to (HTTP ${probed.status}).`)
    }
    const authority = named || checkedAuthority(`https://login.microsoftonline.com/${tenant}`)
    if (!authority || (tenant && tenant.toLowerCase() !== authority.split('/').pop().toLowerCase())) {
      throw fail(`Azure Artifacts named two different Microsoft Entra tenants for the ${org} organization, so no sign-in was started.`)
    }
    return authority
  }

  // --- the person's own sign-in ---------------------------------------------

  const deviceLogin = async (authority) => {
    const started = await ctx.request('POST', `${authority}/oauth2/v2.0/devicecode`, {
      form: { client_id: CLIENT_ID, scope: ENTRA_SCOPE },
    })
    if (started.status !== 200 || !started.json || !started.json.device_code) {
      throw fail(`Microsoft Entra did not start a sign-in (HTTP ${started.status}).`)
    }
    const { device_code: deviceCode, user_code: userCode, verification_uri: uri } = started.json
    let interval = started.json.interval ?? 5
    const deadline = ctx.clockMs() + Math.min((started.json.expires_in ?? 90) * 1000, DEVICE_WAIT_MS)
    // nothing can be finished when the step cannot be shown: stop before polling, and store nothing
    if (!ctx.showToPerson(`Open ${uri} and enter the code ${userCode}`)) {
      throw fail(`There is no terminal to show the Microsoft Entra sign-in for the ${org} organization on, so it was not started. Nothing was stored. Run npm login from a terminal.`)
    }
    for (;;) {
      await ctx.sleep(Math.min(interval * 1000, Math.max(0, deadline - ctx.clockMs())))
      const polled = await ctx.request('POST', `${authority}/oauth2/v2.0/token`, {
        form: { grant_type: DEVICE_GRANT, client_id: CLIENT_ID, device_code: deviceCode },
      })
      if (polled.status === 200 && polled.json && polled.json.refresh_token) {
        return polled.json
      }
      const code = polled.json && polled.json.error
      if (code === 'slow_down') {
        interval += 5
      } else if (code === 'authorization_declined') {
        throw fail(`The Microsoft Entra sign-in for the ${org} organization was declined. Nothing was stored. Run npm login again.`)
      } else if (code !== 'authorization_pending') {
        throw fail(`Microsoft Entra refused the sign-in for the ${org} organization (${code || `HTTP ${polled.status}`}). Nothing was stored.`)
      }
      if (ctx.clockMs() >= deadline) {
        throw fail(`The Microsoft Entra sign-in for the ${org} organization was not completed within ${DEVICE_WAIT_MS / 1000} seconds. Nothing was stored. Run npm login again.`)
      }
    }
  }

  // An Entra access token for Azure DevOps from the stored login: the cached
  // one while it has time left, else a refresh. A refresh the authority
  // refuses means the login is gone, which only `npm login` mends.
  const entraAccess = async (account, until) => {
    if (account.accessToken && account.accessExpiresAt - ctx.now() > ACCESS_MARGIN) {
      return account.accessToken
    }
    const authority = checkedAuthority(account.authority || '')
    if (!authority) {
      throw fail(`The stored Microsoft Entra sign-in for the ${org} organization has no valid authority. Run npm login.`)
    }
    const now = ctx.now()
    const refreshed = await ctx.request('POST', `${authority}/oauth2/v2.0/token`, {
      form: { grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: account.refreshToken, scope: ENTRA_SCOPE },
      until,
    })
    if (refreshed.status !== 200 || !refreshed.json || !refreshed.json.access_token) {
      throw fail(`Microsoft Entra did not renew the sign-in for the ${org} organization. Run npm login.`)
    }
    account.refreshToken = refreshed.json.refresh_token ?? account.refreshToken
    account.accessToken = refreshed.json.access_token
    account.accessExpiresAt = now + refreshed.json.expires_in
    persist(account, ['refreshToken', 'accessToken', 'accessExpiresAt'])
    return account.accessToken
  }

  // --- session tokens ---------------------------------------------------------

  const mint = async (account, scope, seconds, label) => {
    const access = await entraAccess(account)
    const validTo = new Date((ctx.now() + seconds) * 1000).toISOString()
    const res = await ctx.request('POST', sessionsUrl('&tokenType=selfdescribing'), {
      token: access,
      body: { displayName: `npm-credential-provider ${label}`, scope, validTo },
    })
    if (res.status !== 200 && res.status !== 201) {
      throw fail(`Azure Artifacts answered ${res.status} to a session token for the ${org} organization.`)
    }
    const minted = res.json
    // the service may grant less than was asked: its validTo is the one
    const expiresAt = minted && Math.floor(Date.parse(minted.validTo) / 1000)
    if (!minted || !minted.token || !Number.isInteger(expiresAt)) {
      throw fail('Azure Artifacts gave a session token without a usable expiry.')
    }
    account.minted = [
      ...(account.minted || []).filter((held) => held.expiresAt > ctx.now()),
      { authorizationId: minted.authorizationId, expiresAt },
    ]
    return { token: minted.token, expiresAt }
  }

  // Best effort at the service for every session token the account still holds a
  // handle of; what fails is said on stderr and never stops the rest.
  // `until`, if given, is the time on the context's clock by which it must be over
  const revokeMinted = async (account, why, until) => {
    for (const held of account.minted || []) {
      try {
        await revoke(account, held.authorizationId, until)
      } catch (error) {
        const cause = error instanceof Answer ? 'the sign-in is gone' : error.message
        log(`${why}: a session token could not be revoked, it expires on its own date (${cause})`)
      }
    }
  }

  const revoke = async (account, authorizationId, until) => {
    const access = await entraAccess(account, until)
    const res = await ctx.request('DELETE', sessionsUrl(`&authorizationId=${encodeURIComponent(authorizationId)}`), { token: access, until })
    if (res.status !== 200 && res.status !== 204) {
      throw new Error(`HTTP ${res.status}`)
    }
  }

  // --- credentials of the pipeline or the machine --------------------------------

  // The job token only where the pipeline maps it in and says the
  // organization it belongs to; that is the one of this provider.
  const jobToken = () => {
    const collection = process.env.SYSTEM_COLLECTIONURI
    if (!process.env.SYSTEM_ACCESSTOKEN || !collection) {
      return null
    }
    try {
      const url = new URL(collection)
      const named = url.hostname === 'dev.azure.com' ? url.pathname.split('/')[1] : url.hostname.replace(/\.visualstudio\.com$/, '')
      // organization names are not case-sensitive, and a URL parser lowercases the legacy host
      return named.toLowerCase() === org.toLowerCase() ? process.env.SYSTEM_ACCESSTOKEN : null
    } catch {
      return null
    }
  }

  // The machine's own Entra identity, found without asking anyone for a token:
  // a workload identity (the federated token file is the pipeline's) or the
  // Azure CLI's. A function that fetches `{ token, expiresAt }`, or null where
  // neither is set up. What is set up is known before any call is made, so a
  // request that will be refused is refused before the identity is used.
  const identitySource = () => {
    if (process.env.AZURE_ARTIFACTS_ENTRA_SOURCE === 'az') {
      return async () => {
        const res = await ctx.request('GET', AZ_URL)
        if (res.status !== 200 || !res.json || !res.json.accessToken || !Number.isInteger(res.json.expires_on)) {
          throw fail('The Azure CLI gave no Microsoft Entra token. Run az login.')
        }
        return { token: res.json.accessToken, expiresAt: res.json.expires_on }
      }
    }
    const { AZURE_CLIENT_ID: clientId, AZURE_TENANT_ID: tenantId, AZURE_FEDERATED_TOKEN_FILE: file } = process.env
    if (!clientId || !tenantId || !file) {
      return null
    }
    let assertion
    try {
      assertion = fs.readFileSync(path.resolve(__dirname, file), 'utf8').trim()
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null
      }
      throw error
    }
    return async () => {
      const authority = checkedAuthority(`https://login.microsoftonline.com/${tenantId}`)
      if (!authority) {
        throw fail('AZURE_TENANT_ID is not a tenant of a Microsoft Entra authority.')
      }
      const now = ctx.now()
      const res = await ctx.request('POST', `${authority}/oauth2/v2.0/token`, {
        form: {
          grant_type: 'client_credentials',
          client_id: clientId,
          scope: `${AZURE_DEVOPS_RESOURCE}/.default`,
          client_assertion_type: ASSERTION_TYPE,
          client_assertion: assertion,
        },
      })
      if (res.status !== 200 || !res.json || !res.json.access_token) {
        throw fail(`Microsoft Entra refused the workload identity (HTTP ${res.status}).`)
      }
      return { token: res.json.access_token, expiresAt: now + res.json.expires_in }
    }
  }

  // The person's presence for a write, asked on the controlling terminal and
  // only when the request is interactive: the credential about to be released
  // is a write one. A read asks nothing. Unanswered in time is `other`.
  const confirmWrite = async (req) => {
    if (!Object.hasOwn(WRITES, req.operation) || !req.interactive) {
      return
    }
    const subject = `${nameOf(req)}${req.version ? `@${req.version}` : ''}`
    const question =
      req.operation === 'unpublish'
        ? `Mint a 15-minute Owner token (vso.packaging_manage) to unpublish ${subject} in the ${org} organization?`
        : `${WRITES[req.operation]} ${subject} in the ${org} organization?`
    const answered = await ctx.confirmWithin(question, PRESENCE_MS)
    if (answered === null) {
      throw fail(`The ${req.operation} of ${subject} was not confirmed within 4 minutes 30 seconds. No credential was released.`)
    }
    if (!answered) {
      throw fail(`The ${req.operation} of ${subject} was not confirmed. No credential was released.`)
    }
  }

  // --- handlers ------------------------------------------------------------------

  const answerBare = (token, expiresAt) =>
    ok('get', {
      auth: { type: 'bearer', token },
      cache: 'expires',
      expiresAt,
      operationIndependent: true,
      granularity: 'registry',
    })

  const refusal = (req) => {
    const name = nameOf(req)
    if (req.operation === 'publish') {
      return err(
        'other',
        `Azure Artifacts refused the publish of ${name} ${req.version} with 403 and did not say why. Microsoft documents that a version that exists, or once existed, in the feed or in an upstream cannot be published again; a missing Contributor role is the other usual reason, and the provider cannot tell which applies. No other credential is released for this request. If the version existed, publish a new one; otherwise ask a feed owner for the Contributor role.`,
        ['the registry answered 403 to the publish'],
      )
    }
    return err(
      'other',
      `Azure Artifacts refused the ${req.operation} of ${name} with 403. The credential the provider holds for the ${org} organization is the widest it releases for this request, and no other is released. Ask a feed owner for the role the operation needs.`,
    )
  }

  const get = async (req) => {
    if (!served(req.registry)) {
      return err('url-not-supported')
    }
    if (!SERVED_OPERATIONS.has(req.operation)) {
      return err('operation-not-supported')
    }
    const retried = req.retry === true
    // a 403 is not cured by another token of the same identity: the version
    // exists, or the role is missing, and a wider token only deletes
    if (retried && req.httpStatus === 403) {
      return refusal(req)
    }

    const job = jobToken()
    if (job) {
      if (retried) {
        return err('other', 'Azure Artifacts rejected the pipeline job token, and a job token has no refresh. Check that the job runs in the organization the provider serves and that the build identity has a role on the feed.')
      }
      await confirmWrite(req)
      return ok('get', {
        auth: { type: 'bearer', token: job },
        cache: 'session',
        operationIndependent: true,
        granularity: 'registry',
      })
    }

    const account = readAccount()
    if (account.pat) {
      if (retried) {
        return err('other', `Azure Artifacts rejected the personal access token stored for the ${org} organization. The provider keeps it: run npm logout and npm login to replace it.`)
      }
      await confirmWrite(req)
      return ok('get', {
        auth: { type: 'basic', username: PAT_USERNAME, password: account.pat },
        cache: 'session',
        operationIndependent: true,
        granularity: 'registry',
      })
    }
    if (account.refreshToken) {
      return fromLogin(req, account)
    }

    const source = identitySource()
    if (!source) {
      return err('not-found')
    }
    // The bare Entra token is not packaging-scoped and works in every
    // organization of the tenant: it is handed out only where nothing else can
    // exist (a pipeline's identity, `interactive` false). A person at a
    // terminal signs in with `npm login`, which mints a packaging token. The
    // refusal comes before the identity is asked for anything.
    if (req.interactive) {
      return err(
        'other',
        `The only credential on this machine for the ${org} organization is an Entra token that is not limited to packaging, and this provider hands such a token out only where no person can sign in. Run npm login.`,
      )
    }
    // `interactive: false` is also a developer's `npm publish > log.txt`, where nobody can be
    // asked: a write with this token needs the provider's own configuration to say
    // that the machine's identity is a publisher (never an environment variable)
    if (Object.hasOwn(WRITES, req.operation) && !ctx.config.ciPublisher) {
      return err(
        'other',
        `The ${req.operation} of ${nameOf(req)} needs a person's presence or a credential minted for it, and the only credential here is an Entra token that is not limited to packaging. This provider releases that token for a write only when its own configuration says the machine's identity is a publisher (ciPublisher).`,
      )
    }
    const identity = await source()
    if (retried && rejected === identity.token) {
      return err(
        'other',
        `Azure Artifacts rejected an Entra token that has not expired. The token source returns the same token again. Check that the signed-in tenant is the one connected to the ${org} organization and that the identity is a member of it, then run npm login.`,
      )
    }
    bare = identity.token
    return answerBare(identity.token, identity.expiresAt)
  }

  const fromLogin = async (req, account) => {
    await confirmWrite(req)
    if (req.operation === 'unpublish') {
      // bound to the package and never reused
      const minted = await mint(account, MANAGE_SCOPE, MANAGE_SECONDS, `unpublish ${nameOf(req)} ${ctx.now()}`)
      persist(account, ['minted'])
      return ok('get', {
        auth: { type: 'basic', username: 'VssSessionToken', password: minted.token },
        cache: 'never',
        operationIndependent: false,
        granularity: 'package',
      })
    }
    // one token for the organization: read, publish, deprecate and dist-tag
    let held = account.session
    if (!held || held.expiresAt - ctx.now() <= ACCESS_MARGIN) {
      held = await mint(account, WRITE_SCOPE, SESSION_SECONDS, `session ${ctx.now()}`)
      account.session = held
      persist(account, ['session', 'minted'])
    }
    return ok('get', {
      auth: { type: 'basic', username: 'VssSessionToken', password: held.token },
      cache: 'expires',
      expiresAt: held.expiresAt,
      operationIndependent: true,
      granularity: 'registry',
    })
  }

  // Drops what was handed to npm and the copy kept for the organization. The
  // refresh token and a stored PAT are `login`'s, removed only by `logout`.
  const erase = async (req) => {
    if (!served(req.registry)) {
      return err('url-not-supported')
    }
    if (bare) {
      rejected = bare
    }
    const account = readAccount()
    if (account.session && req.granularity !== 'package') {
      delete account.session
      persist(account, ['session'])
    }
    return ok('erase')
  }

  const login = async (req) => {
    if (!served(req.registry)) {
      return err('url-not-supported')
    }
    if (req.token) {
      // a PAT the user supplied replaces the sign-in; it is checked the way
      // it will be used, as basic, before it is kept
      const checked = await ctx.request('GET', req.registry, {
        headers: { authorization: `Basic ${Buffer.from(`${PAT_USERNAME}:${req.token}`).toString('base64')}` },
      })
      if (checked.status !== 200) {
        return err('other', `Azure Artifacts did not accept the personal access token (HTTP ${checked.status}). Nothing was stored.`)
      }
      await revokeMinted(readAccount(), 'replaced')
      writeAccount({ pat: req.token, signIn: crypto.randomUUID() })
      return ok('login')
    }
    if (!req.interactive) {
      return err('other', 'Signing in to Microsoft Entra needs a terminal, and none is available.')
    }
    const authority = await findAuthority(req.registry)
    const granted = await deviceLogin(authority)
    const now = ctx.now()
    const confirmed = await ctx.request('GET', req.registry, { token: granted.access_token })
    if (confirmed.status !== 200) {
      return err('other', `Azure Artifacts did not accept the new sign-in (HTTP ${confirmed.status}). Nothing was stored.`)
    }
    // what the replaced sign-in minted is revoked with it, not left valid with no handle kept
    await revokeMinted(readAccount(), 'replaced')
    writeAccount({
      signIn: crypto.randomUUID(),
      authority,
      refreshToken: granted.refresh_token,
      accessToken: granted.access_token,
      accessExpiresAt: now + granted.expires_in,
    })
    return ok('login')
  }

  // best effort at the service, then everything of the organization is gone
  const logout = async (req) => {
    if (!served(req.registry)) {
      return err('url-not-supported')
    }
    const account = readAccount()
    if (!Object.keys(account).length) {
      return err('not-found')
    }
    if (account.pat) {
      log('logout: a personal access token cannot be revoked without an Entra token; it was removed here only')
    }
    // the local credentials go first, so that a service that stalls or a logout that
    // is killed cannot leave them stored: what the account minted is revoked from the
    // copy, best effort, inside the 30 seconds npm gives a logout. The copy's refresh
    // of the Entra token writes nothing back (`persist` finds the entry gone).
    const copy = structuredClone(account)
    writeAccount({})
    await revokeMinted(copy, 'logout', ctx.clockMs() + LOGOUT_MS)
    return ok('logout')
  }

  return {
    hello: { v: [1], capabilities: ['login', 'logout', 'erase'], registries: prefixes },
    handlers: { get, erase, login, logout },
  }
}

serve(start)
