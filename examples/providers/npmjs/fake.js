'use strict'
// A fake of the registry.npmjs.org endpoints the provider uses, answering
// from the scenario's state:
//   tokens: { <token>: { valid, username } }   accepted by /-/whoami
//   whoamiStatus                               a status (503) /-/whoami answers instead of
//                                              looking at the token, as when the registry is down
//   login:  { pending, token, retryAfter, doneUrl }  the web login; `pending` polls answer 202 first,
//                                              each with Retry-After, and a poll sooner than
//                                              that is answered 429
// It records `revoked` (tokens deleted), `logins` (web logins started) and
// `doneAuth` (the credential, if any, a done poll carried) and
// `polls` (done polls answered).

const createFake = (state) => {
  state.tokens ||= {}
  state.revoked ||= []
  state.logins ||= 0
  let polls = 0
  let notBefore = 0
  return (request) => {
    const { method, path } = request
    if (method === 'GET' && path === '/-/whoami') {
      if (state.whoamiStatus) {
        return { status: state.whoamiStatus, json: { error: 'unavailable' } }
      }
      const known = request.token && state.tokens[request.token]
      return known && known.valid
        ? { status: 200, json: { username: known.username || 'alice' } }
        : { status: 401, json: { error: 'Unauthorized' } }
    }
    if (method === 'DELETE' && path.startsWith('/-/user/token/')) {
      const token = decodeURIComponent(path.slice('/-/user/token/'.length))
      if (!state.tokens[token] || !state.tokens[token].valid) {
        return { status: 404, json: { error: 'no such token' } }
      }
      state.tokens[token].valid = false
      state.revoked.push(token)
      return { status: 200, json: {} }
    }
    if (method === 'POST' && path === '/-/v1/login' && state.login) {
      state.logins += 1
      polls = 0
      return {
        status: 200,
        json: {
          loginUrl: 'https://www.npmjs.com/login?next=/login/cli/example',
          // `login.doneUrl` sets another one, as a hostile registry could
          doneUrl: state.login.doneUrl || 'https://registry.npmjs.org/-/v1/done?sessionId=example',
        },
      }
    }
    if (method === 'GET' && path === '/-/v1/done' && state.login) {
      state.doneAuth = request.token
      state.polls = (state.polls || 0) + 1
      const retryAfter = state.login.retryAfter
      if (retryAfter && request.clock < notBefore) {
        state.tooSoon = (state.tooSoon || 0) + 1
        return { status: 429, headers: { 'retry-after': String(retryAfter) }, json: { error: 'too many requests' } }
      }
      if (polls < (state.login.pending || 0)) {
        polls += 1
        notBefore = request.clock + (retryAfter || 0) * 1000
        return { status: 202, headers: retryAfter ? { 'retry-after': String(retryAfter) } : {}, json: {} }
      }
      state.tokens[state.login.token] = { valid: true, username: 'alice' }
      return { status: 200, json: { token: state.login.token } }
    }
    return null
  }
}

module.exports = { createFake }
