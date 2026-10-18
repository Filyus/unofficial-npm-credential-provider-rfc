'use strict'
// A fake of the GitLab endpoints the provider uses, answering from a state
// the scenario sets and changing it as GitLab would:
//
//   oauth.refreshToken, oauth.accessToken   the pair GitLab holds as current
//   oauth.next                              pairs issued by the next refreshes
//                                           or device logins, in order
//   oauth.pending                           polls answered authorization_pending
//   oauth.slowDown                          the first poll is answered slow_down; a poll sooner
//                                           than 5 s after it slow_down again, a second one
//                                           expired_token (RFC 8628)
//   oauth.revoked                           tokens revoked so far
//   tokens                                  secrets the next deploy tokens get
//   deployTokens                            live deploy tokens, as created
//   deleted                                 ids deleted so far
//   nextId                                  id of the next deploy token

const json = (status, body) => ({ status, json: body })

const createFake = (state) => {
  state.oauth = state.oauth || {}
  const oauth = state.oauth
  oauth.next = oauth.next || []
  oauth.revoked = oauth.revoked || []
  state.tokens = state.tokens || []
  state.deployTokens = state.deployTokens || []
  state.deleted = state.deleted || []
  state.nextId = state.nextId || 1

  // GitLab's token response: both tokens, two hours, a creation time
  const issue = () => {
    const pair = oauth.next.shift()
    if (!pair) {
      return json(500, { error: 'the fake has no tokens left to issue' })
    }
    oauth.accessToken = pair.accessToken
    oauth.refreshToken = pair.refreshToken
    return json(200, {
      access_token: pair.accessToken,
      token_type: 'Bearer',
      expires_in: 7200,
      refresh_token: pair.refreshToken,
      created_at: 0,
    })
  }

  return ({ method, path, token, body, clock }) => {
    if (method === 'POST' && path === '/oauth/token') {
      if (body.grant_type === 'refresh_token') {
        // the old refresh token stops working with the first use
        return body.refresh_token === oauth.refreshToken ? issue() : json(400, { error: 'invalid_grant' })
      }
      if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        if (oauth.slowDown) {
          if (oauth.notBefore === undefined) {
            oauth.notBefore = clock + 5000
            return json(400, { error: 'slow_down' })
          }
          if (clock < oauth.notBefore) {
            oauth.tooSoon = (oauth.tooSoon || 0) + 1
            return json(400, { error: oauth.tooSoon >= 2 ? 'expired_token' : 'slow_down' })
          }
        }
        if (oauth.pending > 0) {
          oauth.pending -= 1
          return json(400, { error: 'authorization_pending' })
        }
        return body.device_code === 'device-code' ? issue() : json(400, { error: 'invalid_grant' })
      }
      return json(400, { error: 'unsupported_grant_type' })
    }
    if (method === 'POST' && path === '/oauth/authorize_device') {
      return json(200, {
        device_code: 'device-code',
        user_code: 'ABCD-1234',
        verification_uri: 'https://gitlab.example.com/oauth/device',
        expires_in: 300,
        interval: 0,
      })
    }
    if (method === 'POST' && path === '/oauth/revoke') {
      oauth.revoked.push(body.token)
      return json(200, {})
    }

    const route = /^\/api\/v4\/projects\/(\d+)\/deploy_tokens(?:\/(\d+))?$/.exec(path)
    if (route) {
      if (token !== oauth.accessToken) {
        return json(401, { message: '401 Unauthorized' })
      }
      if (method === 'POST' && !route[2]) {
        // the provider never asks for a token without an expiry or scope
        if (!body.expires_at || !Array.isArray(body.scopes) || !body.scopes.length) {
          return json(400, { message: 'expires_at and scopes are required here' })
        }
        const secret = state.tokens.shift()
        if (!secret) {
          return json(500, { message: 'the fake has no deploy token secrets left' })
        }
        const created = { id: state.nextId, token: secret, scopes: body.scopes, expires_at: body.expires_at }
        state.nextId += 1
        state.deployTokens.push(created)
        return json(201, { ...created, name: body.name, username: `gitlab+deploy-token-${created.id}`, revoked: false, expired: false })
      }
      if (method === 'DELETE' && route[2]) {
        const index = state.deployTokens.findIndex((t) => t.id === Number(route[2]))
        if (index < 0) {
          return json(404, { message: '404 Not found' })
        }
        state.deployTokens.splice(index, 1)
        state.deleted.push(Number(route[2]))
        return { status: 204 }
      }
    }
    return null
  }
}

module.exports = { createFake }
