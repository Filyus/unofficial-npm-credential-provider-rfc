'use strict'
// A fake Azure DevOps, Microsoft Entra and Azure CLI for azure-artifacts,
// answering from the state a scenario sets. One server stands behind every
// host the scenario lists, told apart by path. The shapes follow the
// documented OAuth 2.0 device-code and token endpoints; the SessionTokens
// path and fields are recalled, not read (see provider.js), and the feed
// answers its registry URL as the page describes: the tenant headers to a
// request without credentials, 200 to one a live token or PAT authorizes.
//
// state.feed:   tenant (what X-VSS-ResourceTenant says), authorizationUri
//               (what the WWW-Authenticate challenge names; default the
//               public authority and that tenant), pats (the PATs it accepts)
// state.entra:  interval, userCode, verificationUri, pending (polls answered
//               authorization_pending), refreshTokens { token: { lapsed } },
//               clients { id: { federatedToken, accessToken, expiresIn } }
// state.az:     accessToken, expires_on: what `az account get-access-token`
//               prints, the same until it is near expiry
// state.sessions: tokens { scope: [token, ...] }, a queue per scope that
//               each mint takes from
// The fake adds its counters: entra.devices, refreshes, clientGrants;
// az.calls; sessions.minted [{ scope, validTo }], revoked [authorizationId].

const json = (status, body, headers) => ({ status, json: body, headers })

const createFake = (state) => {
  const feed = (state.feed ??= {})
  const entra = (state.entra ??= {})
  const az = (state.az ??= {})
  const sessions = (state.sessions ??= {})
  entra.refreshTokens ??= {}
  entra.clients ??= {}
  entra.accessTokens = []
  entra.devices = 0
  entra.refreshes = 0
  entra.clientGrants = 0
  az.calls = 0
  sessions.tokens ??= {}
  sessions.minted = []
  sessions.revoked = []
  let counter = 0

  const issueAccess = () => {
    counter += 1
    const token = `example-entra-access-${counter}`
    entra.accessTokens.push(token)
    return token
  }

  const tokenEndpoint = ({ body }) => {
    if (body.grant_type === DEVICE_GRANT) {
      if (body.device_code !== 'example-device-code-1') {
        return json(400, { error: 'bad_verification_code' })
      }
      if (entra.pending > 0) {
        entra.pending -= 1
        return json(400, { error: 'authorization_pending' })
      }
      const refresh = `example-refresh-device-${entra.devices}`
      entra.refreshTokens[refresh] = {}
      return json(200, { access_token: issueAccess(), refresh_token: refresh, expires_in: 3600 })
    }
    if (body.grant_type === 'refresh_token') {
      const held = entra.refreshTokens[body.refresh_token]
      if (!held || held.lapsed) {
        return json(400, { error: 'invalid_grant' })
      }
      entra.refreshes += 1
      return json(200, { access_token: issueAccess(), expires_in: 3600 })
    }
    if (body.grant_type === 'client_credentials') {
      const client = entra.clients[body.client_id]
      if (!client || client.federatedToken !== body.client_assertion || body.client_assertion_type !== ASSERTION_TYPE) {
        return json(401, { error: 'invalid_client' })
      }
      entra.clientGrants += 1
      return json(200, { access_token: client.accessToken, expires_in: client.expiresIn })
    }
    return json(400, { error: 'unsupported_grant_type' })
  }

  const authorized = (token) => {
    if (!token) {
      return false
    }
    if (token.startsWith('Basic ')) {
      const password = Buffer.from(token.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':')
      return (feed.pats || []).includes(password)
    }
    return entra.accessTokens.includes(token)
  }

  const mint = ({ token, body }) => {
    if (!entra.accessTokens.includes(token)) {
      return json(401, { error: 'invalid_token' })
    }
    const entry = (sessions.tokens[body.scope] || []).shift()
    if (!entry) {
      return json(500, { error: `no token queued for ${body.scope}` })
    }
    sessions.minted.push({ scope: body.scope, validTo: body.validTo })
    return json(200, {
      token: entry,
      validTo: body.validTo,
      authorizationId: `example-authorization-${sessions.minted.length}`,
      displayName: body.displayName,
      scope: body.scope,
    })
  }

  return (request) => {
    const { method, path } = request
    if (method === 'GET' && path === '/get-access-token') {
      az.calls += 1
      return json(200, { accessToken: az.accessToken, expires_on: az.expires_on })
    }
    if (method === 'POST' && /\/oauth2\/v2\.0\/devicecode$/.test(path)) {
      entra.devices += 1
      return json(200, {
        device_code: 'example-device-code-1',
        user_code: entra.userCode,
        verification_uri: entra.verificationUri,
        expires_in: 900,
        interval: entra.interval,
      })
    }
    if (method === 'POST' && /\/oauth2\/v2\.0\/token$/.test(path)) {
      return tokenEndpoint(request)
    }
    if (/\/_apis\/Token\/SessionTokens$/i.test(path)) {
      if (method === 'POST') {
        return mint(request)
      }
      if (method === 'DELETE' && entra.accessTokens.includes(request.token)) {
        sessions.revoked.push(request.query.authorizationId)
        return { status: 204 }
      }
      return json(401, {})
    }
    if (method === 'GET') {
      // a feed URL
      if (authorized(request.token)) {
        return json(200, {})
      }
      if (request.token) {
        return json(401, {})
      }
      if (!feed.tenant) {
        return json(401, {})
      }
      const authorityUri = feed.authorizationUri ?? `https://login.microsoftonline.com/${feed.tenant}`
      return json(401, {}, {
        'x-vss-resourcetenant': feed.tenant,
        'www-authenticate': `Bearer authorization_uri="${authorityUri}"`,
      })
    }
    return null
  }
}

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

module.exports = { createFake }
