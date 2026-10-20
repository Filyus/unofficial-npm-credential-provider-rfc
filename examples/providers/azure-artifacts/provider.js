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
// Entra token again answered with a diagnosis.
// Recalled, not read, and so unverified here: the SessionTokens paths, query
// and fields and the way a token is revoked (DELETE with `authorizationId`),
// the Entra v2.0 device-code and token endpoint shapes (these are the
// documented OAuth 2.0 ones), the members of the authority allowlist, `SYSTEM_COLLECTIONURI`
// as the organization a job token belongs to, that the registry URL answers an
// unauthenticated request with the tenant headers and an authenticated one
// with 200, and `az account get-access-token`'s output. ILLUSTRATIVE: the
// client id, and `https://az.example.test/`, which stands for running
// `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798`
// (a run cannot depend on az being installed, so the fake answers it over HTTP).

const fs = require('node:fs')
const path = require('node:path')
const { serve, ok, err, log } = require('../lib/protocol.js')
const { loadContext } = require('../lib/context.js')

const CLIENT_ID = 'example-npm-credential-provider'
const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798'
const ENTRA_SCOPE = `${AZURE_DEVOPS_RESOURCE}/.default offline_access`
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'
// authorities the provider signs in at: https, one of these hosts, the tenant as the path
const AUTHORITY_HOSTS = new Set(['login.microsoftonline.com', 'login.windows.net', 'login.microsoft.com', 'sts.windows.net'])
const TENANT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9.-]+)$/i
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

// A protocol answer raised from deep inside a helper.
class Answer extends Error {
  constructor(answer) {
    super(answer.Err ? answer.Err.kind : 'answer')
    this.answer = answer
  }
}
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
  if (url.protocol !== 'https:' || !AUTHORITY_HOSTS.has(url.hostname) || url.port || url.username || url.search || !TENANT.test(tenant)) {
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
  const prefixes = [`https://pkgs.dev.azure.com/${org}/`, `https://${org}.pkgs.visualstudio.com/`]
  // an exact prefix, in the casing the user's config has, and `https:` only
  const served = (registry) => prefixes.some((prefix) => registry.startsWith(prefix))
  const sessionsUrl = (extra) => `https://vssps.dev.azure.com/${org}/_apis/Token/SessionTokens?api-version=7.1-preview.1${extra}`

  // what this provider keeps for the organization: { authority, refreshToken,
  // accessToken, accessExpiresAt, pat, session: { token, expiresAt }, minted }
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
    if (!named && !TENANT.test(tenant)) {
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
    ctx.showToPerson(`Open ${uri} and enter the code ${userCode}`)
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
  const entraAccess = async (account) => {
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
    })
    if (refreshed.status !== 200 || !refreshed.json || !refreshed.json.access_token) {
      throw fail(`Microsoft Entra did not renew the sign-in for the ${org} organization. Run npm login.`)
    }
    account.refreshToken = refreshed.json.refresh_token ?? account.refreshToken
    account.accessToken = refreshed.json.access_token
    account.accessExpiresAt = now + refreshed.json.expires_in
    writeAccount(account)
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

  const revoke = async (account, authorizationId) => {
    const access = await entraAccess(account)
    const res = await ctx.request('DELETE', sessionsUrl(`&authorizationId=${encodeURIComponent(authorizationId)}`), { token: access })
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
      return named === org ? process.env.SYSTEM_ACCESSTOKEN : null
    } catch {
      return null
    }
  }

  // An Entra token of the machine's own identity: a workload identity (the
  // federated token file is the pipeline's) or the Azure CLI's. `{ token,
  // expiresAt }`, or null where neither is set up.
  const identityToken = async () => {
    if (process.env.AZURE_ARTIFACTS_ENTRA_SOURCE === 'az') {
      const res = await ctx.request('GET', AZ_URL)
      if (res.status !== 200 || !res.json || !res.json.accessToken || !Number.isInteger(res.json.expires_on)) {
        throw fail('The Azure CLI gave no Microsoft Entra token. Run az login.')
      }
      return { token: res.json.accessToken, expiresAt: res.json.expires_on }
    }
    const { AZURE_CLIENT_ID: clientId, AZURE_TENANT_ID: tenantId, AZURE_FEDERATED_TOKEN_FILE: file } = process.env
    if (!clientId || !tenantId || !file) {
      return null
    }
    const authority = checkedAuthority(`https://login.microsoftonline.com/${tenantId}`)
    let assertion
    try {
      assertion = fs.readFileSync(path.resolve(__dirname, file), 'utf8').trim()
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null
      }
      throw error
    }
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
        `Azure Artifacts refused the publish of ${name} ${req.version} with 403. For a publish this usually means the version already exists, or once existed, in the feed or in an upstream, and versions are never reused. No other credential is released for this request. Publish a new version.`,
        ['Azure Artifacts answers 403 for a duplicate or deleted version'],
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

    const identity = await identityToken()
    if (!identity) {
      return err('not-found')
    }
    // The bare Entra token is not packaging-scoped and works in every
    // organization of the tenant: it is handed out only where nothing else can
    // exist (a pipeline's identity, `interactive` false). A person at a
    // terminal signs in with `npm login`, which mints a packaging token.
    if (req.interactive) {
      return err(
        'other',
        `The only credential on this machine for the ${org} organization is an Entra token that is not limited to packaging, and this provider hands such a token out only where no person can sign in. Run npm login.`,
      )
    }
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
    if (req.operation === 'unpublish') {
      // bound to the package and never reused
      const minted = await mint(account, MANAGE_SCOPE, MANAGE_SECONDS, `unpublish ${nameOf(req)} ${ctx.now()}`)
      writeAccount(account)
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
      writeAccount(account)
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
      writeAccount(account)
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
      const { origin } = new URL(req.registry)
      const base = ctx.config.endpoints && ctx.config.endpoints[origin]
      const checked = await fetch(base ? base + req.registry.slice(origin.length) : req.registry, {
        headers: { authorization: `Basic ${Buffer.from(`${PAT_USERNAME}:${req.token}`).toString('base64')}` },
        redirect: 'manual',
      })
      if (checked.status !== 200) {
        return err('other', `Azure Artifacts did not accept the personal access token (HTTP ${checked.status}). Nothing was stored.`)
      }
      writeAccount({ pat: req.token })
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
    writeAccount({
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
    for (const held of account.minted || []) {
      try {
        await revoke(account, held.authorizationId)
      } catch (error) {
        const why = error instanceof Answer ? 'the sign-in is gone' : error.message
        log(`logout: a session token could not be revoked, it expires on its own date (${why})`)
      }
    }
    writeAccount({})
    return ok('logout')
  }

  // an answer raised from a helper is that handler's answer
  const guarded = (handler) => async (req) => {
    try {
      return await handler(req)
    } catch (error) {
      if (error instanceof Answer) {
        return error.answer
      }
      throw error
    }
  }

  return {
    hello: { v: [1], capabilities: ['login', 'logout', 'erase'], registries: prefixes },
    handlers: { get: guarded(get), erase: guarded(erase), login: guarded(login), logout: guarded(logout) },
  }
}

serve(start)
