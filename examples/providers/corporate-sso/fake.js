'use strict'
// A fake identity provider and gateway for corporate-sso, answering from the
// state a scenario sets. Every path and field below is illustrative: the
// device authorization, token, userinfo and revoke endpoints follow RFC 8628,
// RFC 6749 and RFC 7009 in shape, and the gateway's `-/sso/token` endpoint is
// invented for the example (see ../../corporate-sso.md).
//
// state.idp:     interval, pending (polls answered authorization_pending),
//                slowDown (the first poll is answered slow_down; after it a poll
//                sooner than interval + 5 s is answered slow_down again, and a
//                second such poll expired_token, as RFC 8628 allows),
//                userCode, verificationUri, sessions { refreshToken: { lapsed } },
//                clients { id: { secret, roles } }, groups
// state.gateway: tokens { "read:@corp": [{ token, expires_at, groups }] }, a queue
//                per key that each mint takes from
// The fake adds its counters to the state: idp.refreshes, devices,
// clientGrants, revoked; gateway.minted.

const json = (status, body) => ({ status, json: body })

const createFake = (state) => {
  const idp = (state.idp ??= {})
  const gateway = (state.gateway ??= {})
  idp.sessions ??= {}
  idp.clients ??= {}
  idp.accessTokens = []
  idp.refreshes = 0
  idp.devices = 0
  idp.clientGrants = 0
  idp.revoked = []
  gateway.tokens ??= {}
  gateway.minted = []
  let counter = 0
  let notBefore = null
  let tooSoon = 0

  const issueAccess = () => {
    counter += 1
    const token = `access-${counter}`
    idp.accessTokens.push(token)
    return token
  }

  const tokenEndpoint = ({ body }) => {
    if (body.grant_type === 'refresh_token') {
      const session = idp.sessions[body.refresh_token]
      if (!session || session.lapsed) {
        return json(400, { error: 'invalid_grant' })
      }
      idp.refreshes += 1
      return json(200, { access_token: issueAccess(), expires_in: 600 })
    }
    if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
      if (body.device_code !== 'device-code-1') {
        return json(400, { error: 'invalid_grant' })
      }
      if (idp.slowDown) {
        if (notBefore === null) {
          notBefore = Date.now() + ((idp.interval || 0) + 5) * 1000 - 100
          return json(400, { error: 'slow_down' })
        }
        if (Date.now() < notBefore) {
          tooSoon += 1
          idp.tooSoon = tooSoon
          return json(400, { error: tooSoon >= 2 ? 'expired_token' : 'slow_down' })
        }
      }
      if (idp.pending > 0) {
        idp.pending -= 1
        return json(400, { error: 'authorization_pending' })
      }
      const refresh = `refresh-device-${idp.devices}`
      idp.sessions[refresh] = {}
      return json(200, { access_token: issueAccess(), refresh_token: refresh, expires_in: 600 })
    }
    if (body.grant_type === 'client_credentials') {
      const client = idp.clients[body.client_id]
      if (!client || client.secret !== body.client_secret) {
        return json(401, { error: 'invalid_client' })
      }
      idp.clientGrants += 1
      return json(200, { access_token: issueAccess(), expires_in: 600, roles: client.roles })
    }
    return json(400, { error: 'unsupported_grant_type' })
  }

  const mint = ({ token, body }) => {
    if (!idp.accessTokens.includes(token)) {
      return json(401, { error: 'invalid_token' })
    }
    const subject =
      body.operation === 'publish' ? `${body.scope}/${body.package}@${body.version}` : body.scope || 'unscoped'
    const key = `${body.operation}:${subject}`
    const entry = (gateway.tokens[key] || []).shift()
    if (!entry) {
      return json(500, { error: `no token queued for ${key}` })
    }
    gateway.minted.push(key)
    return json(200, entry)
  }

  return (request) => {
    const { method, path } = request
    if (method === 'POST' && path === '/device_authorization') {
      idp.devices += 1
      return json(200, {
        device_code: 'device-code-1',
        user_code: idp.userCode,
        verification_uri: idp.verificationUri,
        expires_in: 600,
        interval: idp.interval,
      })
    }
    if (method === 'POST' && path === '/token') {
      return tokenEndpoint(request)
    }
    if (method === 'GET' && path === '/userinfo') {
      return idp.accessTokens.includes(request.token) ? json(200, { groups: idp.groups }) : json(401, {})
    }
    if (method === 'POST' && path === '/revoke') {
      idp.revoked.push(request.body.token)
      delete idp.sessions[request.body.token]
      return json(200, {})
    }
    if (method === 'POST' && path === '/-/sso/token') {
      return mint(request)
    }
    return null
  }
}

module.exports = { createFake }
