'use strict'
// A fake of the Artifactory and CI endpoints the provider uses, answering
// from a state the scenario sets and changing it as the platform would:
//
//   identityTokens, refreshTokens    long-lived logins the platform accepts
//   accessTokens                     web-login access tokens it accepts as a bearer
//   admins                           tokens of admin users: only those may revoke by value
//   tokens                           secrets the next tokens it creates get
//   rotate                           refresh tokens a refresh hands out in turn: each
//                                    refresh then invalidates the one presented and
//                                    answers with the next (rotation, which the page
//                                    marks unverified); empty, a refresh keeps its token
//   canCreateTokens                  false: creating a token is refused with 403
//   minted                           tokens created so far, with what was asked
//   user                             the name /users/me gives
//   revocable, revoked               whether revocation works (above the
//                                    revocable threshold), and what was revoked, by
//                                    either call; a revoked token is no longer accepted
//   login.pending                    web-login polls answered 400 first
//   login.confirmed                  false: the person never confirms
//   login.result                     the token response once they do
//   login.sessions                   session ids started
//   login.polls                      web-login polls answered (the fake sets it)
//   oidc.requestToken, oidc.idToken  the CI's own endpoint and what it gives
//   oidc.mappings                    provider name to the token the exchange returns
//   oidc.exchanged                   exchanges done, by provider name

const json = (status, body) => ({ status, json: body })

const createFake = (state) => {
  state.identityTokens = state.identityTokens || []
  state.refreshTokens = state.refreshTokens || []
  state.accessTokens = state.accessTokens || []
  state.admins = state.admins || []
  state.tokens = state.tokens || []
  state.minted = state.minted || []
  state.revoked = state.revoked || []
  state.login = state.login || {}
  state.login.sessions = state.login.sessions || []
  state.login.polls = 0
  state.oidc = state.oidc || {}
  state.oidc.exchanged = state.oidc.exchanged || []

  return ({ method, path, token, body }) => {
    if (method === 'POST' && path === '/access/api/v1/tokens') {
      // the provider never asks for a token without an expiry, or one that can be refreshed
      if (!body || body.expires_in === undefined || body.refreshable !== 'false') {
        return json(400, { error: 'expires_in and refreshable are required here' })
      }
      if (body.grant_type === 'refresh_token') {
        if (!state.refreshTokens.includes(body.refresh_token)) {
          return json(401, { error: 'invalid refresh token' })
        }
      } else if (body.grant_type === 'client_credentials') {
        if (!state.identityTokens.includes(token)) {
          return json(401, { error: 'invalid token' })
        }
        if (state.canCreateTokens === false) {
          return json(403, { error: 'creating tokens is not allowed' })
        }
        if (body.scope !== 'applied-permissions/user') {
          return json(403, { error: 'a user may create user-scope tokens only' })
        }
      } else {
        return json(400, { error: 'unsupported grant_type' })
      }
      const secret = state.tokens.shift()
      if (!secret) {
        return json(500, { error: 'the fake has no token secrets left' })
      }
      state.minted.push({ token: secret, expires_in: Number(body.expires_in), via: body.grant_type })
      const answer = { access_token: secret, token_type: 'Bearer', expires_in: Number(body.expires_in), scope: body.scope || 'applied-permissions/user' }
      if (body.grant_type === 'refresh_token' && state.rotate && state.rotate.length) {
        const next = state.rotate.shift()
        state.refreshTokens = state.refreshTokens.filter((used) => used !== body.refresh_token)
        state.refreshTokens.push(next)
        answer.refresh_token = next
      }
      return json(200, answer)
    }
    // Revoke Token by ID: `me` is the token making the call, which its user may revoke;
    // another id would need the token's own user or an admin, and the provider sends none
    if (method === 'DELETE' && path === '/access/api/v1/tokens/me') {
      const own = [...state.identityTokens, ...state.accessTokens]
      if (!own.includes(token)) {
        return json(401, { error: 'bad credentials' })
      }
      if (!state.revocable) {
        return json(400, { error: 'the token is below the revocable threshold' })
      }
      state.revoked.push(token)
      state.identityTokens = state.identityTokens.filter((held) => held !== token)
      state.accessTokens = state.accessTokens.filter((held) => held !== token)
      return json(200, {})
    }
    // Revoke Token by Value: admin privileges required, which a plain user's token lacks
    if (method === 'DELETE' && path === '/access/api/v1/tokens/revoke') {
      const own = [...state.identityTokens, ...state.accessTokens]
      if (!own.includes(token)) {
        return json(401, { error: 'bad credentials' })
      }
      if (!state.admins.includes(token)) {
        return json(403, { error: 'admin privileges are required' })
      }
      if (!state.revocable) {
        return json(400, { error: 'the token is below the revocable threshold' })
      }
      state.revoked.push(body.token)
      state.identityTokens = state.identityTokens.filter((held) => held !== body.token)
      state.accessTokens = state.accessTokens.filter((held) => held !== body.token)
      return json(200, {})
    }
    if (method === 'GET' && path === '/access/api/v1/users/me') {
      const known = [...state.identityTokens, ...state.accessTokens, ...state.minted.map((m) => m.token)]
      return known.includes(token) && state.user ? json(200, { username: state.user }) : json(401, { error: 'unauthorized' })
    }

    if (method === 'POST' && path === '/access/api/v2/authentication/jfrog_client_login/request') {
      if (state.login.unsupported) {
        return json(404, { error: 'no such route' })
      }
      state.login.sessions.push(body.session)
      return json(200, {})
    }
    const poll = /^\/access\/api\/v2\/authentication\/jfrog_client_login\/token\/([^/]+)$/.exec(path)
    if (method === 'GET' && poll) {
      state.login.polls += 1
      if (!state.login.sessions.includes(poll[1])) {
        return json(404, { error: 'no such session' })
      }
      if (state.login.confirmed === false) {
        return json(400, {})
      }
      if (state.login.pending > 0) {
        state.login.pending -= 1
        return json(400, {})
      }
      return json(200, state.login.result)
    }

    // the CI's endpoint for its ID token, then JFrog's exchange of it
    if (method === 'GET' && path.endsWith('/idtoken')) {
      return token === state.oidc.requestToken ? json(200, { value: state.oidc.idToken }) : json(401, { error: 'unauthorized' })
    }
    if (method === 'POST' && path === '/access/api/v1/oidc/token') {
      const mapping = (state.oidc.mappings || {})[body.provider_name]
      if (!mapping || body.subject_token !== state.oidc.idToken) {
        return json(401, { error: 'no identity mapping matches this token' })
      }
      state.oidc.exchanged.push(body.provider_name)
      return json(200, { access_token: mapping.token, token_type: 'Bearer', expires_in: mapping.expiresIn, scope: 'applied-permissions/groups:readers' })
    }
    return null
  }
}

module.exports = { createFake }
