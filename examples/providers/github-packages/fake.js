'use strict'
// A fake of the GitHub endpoints the provider uses, answering from a state
// the scenario sets and changing it as GitHub documents:
//
//   tokens        the live classic tokens, each { user, scopes }: GET /user answers 200 with
//                 the scopes in X-OAuth-Scopes for these, 401 for any other
//   revoked       tokens revoked so far by POST /credentials/revoke
//   login         the device flow: { token, scope } is what an approved code is exchanged
//                 for (the token is entered in `tokens`), `pending` polls answered
//                 authorization_pending, `denied` for access_denied, `flowDisabled`,
//                 `slowDown` for a first poll answered slow_down (a poll sooner than the
//                 interval then given is slow_down again, a second one expired_token),
//                 `interval` (5) and `expiresIn` (900) of the code
//
// The REST delete of a package or a version, which needs delete:packages, is not
// here: the provider never calls it, npm does.

const json = (status, body, headers) => ({ status, json: body, headers })

const createFake = (state) => {
  state.tokens = state.tokens || {}
  state.revoked = state.revoked || []
  state.login = state.login || {}
  const login = state.login

  // GitHub's OAuth endpoints answer 200 with an `error` member when asked for JSON
  const deviceCode = () => {
    if (login.flowDisabled) {
      return json(200, { error: 'device_flow_disabled' })
    }
    return json(200, {
      device_code: 'device-code',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: login.expiresIn ?? 900,
      interval: login.interval ?? 5,
    })
  }

  const poll = (body, clock) => {
    if (body.device_code !== 'device-code') {
      return json(200, { error: 'bad_verification_code' })
    }
    if (login.slowDown) {
      if (login.notBefore === undefined) {
        login.notBefore = clock + 10000
        return json(200, { error: 'slow_down', interval: (login.interval ?? 5) + 5 })
      }
      if (clock < login.notBefore) {
        login.tooSoon = (login.tooSoon || 0) + 1
        return json(200, login.tooSoon >= 2 ? { error: 'expired_token' } : { error: 'slow_down', interval: (login.interval ?? 5) + 5 })
      }
    }
    if (login.denied) {
      return json(200, { error: 'access_denied' })
    }
    if (login.pending > 0) {
      login.pending -= 1
      return json(200, { error: 'authorization_pending' })
    }
    if (!login.token) {
      return json(500, { message: 'the fake has no token to issue' })
    }
    const scope = login.scope ?? body.scope ?? 'read:packages'
    state.tokens[login.token] = { user: login.user ?? 'example-user', scopes: scope.split(/[\s,]+/) }
    return json(200, { access_token: login.token, token_type: 'bearer', scope })
  }

  // GitHub's OAuth endpoints answer form-encoded unless the request accepts JSON
  const asAsked = (headers, answer) =>
    answer && !String(headers?.accept || '').includes('json') && answer.json ? { status: answer.status, form: answer.json } : answer

  return ({ method, path, token, body, clock, headers }) => {
    if (method === 'POST' && path.startsWith('/login/')) {
      return asAsked(headers, route({ method, path, token, body, clock }))
    }
    return route({ method, path, token, body, clock })
  }

  function route({ method, path, token, body, clock }) {
    if (method === 'POST' && path === '/login/device/code') {
      return body && body.client_id && body.scope ? deviceCode() : json(200, { error: 'incorrect_client_credentials' })
    }
    if (method === 'POST' && path === '/login/oauth/access_token') {
      return body && body.client_id && body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code'
        ? poll(body, clock)
        : json(200, { error: 'unsupported_grant_type' })
    }
    if (method === 'GET' && path === '/user') {
      const held = token && Object.hasOwn(state.tokens, token) ? state.tokens[token] : null
      return held
        ? json(200, { login: held.user }, { 'x-oauth-scopes': held.scopes.join(', ') })
        : json(401, { message: 'Bad credentials' })
    }
    if (method === 'POST' && path === '/credentials/revoke') {
      // unauthenticated by design: an authenticated call is refused
      if (token) {
        return json(403, { message: 'Forbidden' })
      }
      for (const revoked of (body && body.credentials) || []) {
        if (Object.hasOwn(state.tokens, revoked)) {
          delete state.tokens[revoked]
          state.revoked.push(revoked)
        }
      }
      return json(202, { message: 'Credentials revoked' })
    }
    return null
  }
}

module.exports = { createFake }
