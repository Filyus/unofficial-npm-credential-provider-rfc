'use strict'
// A fake Google for google-artifact-registry, answering from the state a
// scenario sets: the OAuth 2.0 endpoints (authorization and token), the
// Security Token Service and the IAM Credentials API, on one address. The
// paths and fields follow Google's published shapes as recalled
// (`serviceAccounts:generateAccessToken` with `lifetime` and `expireTime`, the
// STS token exchange); the authorization endpoint, the loopback redirect, the
// authorization-code exchange with PKCE and the revoke endpoint were read in
// Google's documents ("OAuth 2.0 for Desktop Apps"), none against a live
// service. Not read: which `error` Google gives for a spent or expired code,
// and whether `state` comes back in the query of the redirect (the page says
// fragment); the fake answers `invalid_grant` and puts it in the query. The
// registry itself is not here: the provider never calls it.
//
// state.oauth: account, sessions { refreshToken: { account, lapsed, lapseAfter } }
//              (`lapseAfter: n` ends the session after n refreshes, as when
//              an administrator's session length runs out between two requests),
//              clientSecret (the secret the client's requests must carry, as a
//              refresh and the code exchange both then do),
//              denied (the person refuses consent: the redirect carries
//              `error=access_denied`), noConsent (the consent page is shown and
//              nobody completes it: no redirect comes), codeRejected (the
//              exchange refuses every code with invalid_grant, as for a code
//              that has expired or been used), noRefreshToken (an approved
//              sign-in answered with no refresh token),
//              refreshStatus (a status every refresh grant is answered with, 503:
//              Google is down), revokeStatus (a status POST /revoke answers with
//              instead of revoking), revoked (the refresh tokens revoked so far)
// state.iam.empty: the token endpoint answers 200 with no body; iam.unauthenticated: 401 whoever asks
// state.iam:   serviceAccounts { email: { roles, tokenCreators, tokens } }, a
//              queue of tokens per account that each impersonation takes from
// state.sts:   audience, subjectToken, principal, roles, expiresIn, tokens
// The fake adds oauth.authRequests (what each authorization request carried:
// client id, scope, response type, challenge method, the redirect's host),
// oauth.codes (codes issued, each with its challenge and redirect address),
// oauth.exchanges (code exchanges that succeeded), oauth.refreshes, iam.issued and
// sts.issued: the principal and IAM roles each token was minted for, which is
// what the registry would judge it by.

const crypto = require('node:crypto')

const json = (status, body) => ({ status, json: body })

const createFake = (state) => {
  const oauth = (state.oauth ??= {})
  const iam = (state.iam ??= {})
  const sts = (state.sts ??= {})
  oauth.sessions ??= {}
  oauth.revoked = []
  oauth.authRequests = []
  oauth.codes = {}
  oauth.exchanges = 0
  oauth.refreshes = 0
  iam.serviceAccounts ??= {}
  iam.issued = []
  sts.issued = []
  const accessTokens = new Map()
  let counter = 0

  const issueAccess = (account) => {
    counter += 1
    const token = `access-${counter}`
    accessTokens.set(token, account)
    return token
  }

  const tokenEndpoint = ({ body }) => {
    if (oauth.clientSecret !== undefined && body.client_secret !== oauth.clientSecret) {
      return json(401, { error: 'invalid_client' })
    }
    if (body.grant_type === 'refresh_token') {
      if (oauth.refreshStatus) {
        return json(oauth.refreshStatus, { error: 'the fake is told to fail' })
      }
      const session = oauth.sessions[body.refresh_token]
      if (!session || session.lapsed || (session.lapseAfter !== undefined && (session.refreshes ?? 0) >= session.lapseAfter)) {
        return json(400, { error: 'invalid_grant' })
      }
      oauth.refreshes += 1
      session.refreshes = (session.refreshes ?? 0) + 1
      return json(200, { access_token: issueAccess(session.account), expires_in: 3600, token_type: 'Bearer' })
    }
    if (body.grant_type === 'authorization_code') {
      // every field the page lists for the exchange must be there
      for (const field of ['client_id', 'code', 'code_verifier', 'redirect_uri']) {
        if (!body[field]) {
          return json(400, { error: 'invalid_request', error_description: `Missing required parameter: ${field}` })
        }
      }
      const issued = Object.hasOwn(oauth.codes, body.code) ? oauth.codes[body.code] : null
      if (!issued || issued.used || oauth.codeRejected) {
        return json(400, { error: 'invalid_grant', error_description: 'Bad Request' })
      }
      if (body.redirect_uri !== issued.redirectUri) {
        return json(400, { error: 'invalid_grant', error_description: 'Bad Request' })
      }
      // PKCE: S256 of the verifier is the challenge the authorization request carried
      if (crypto.createHash('sha256').update(body.code_verifier).digest('base64url') !== issued.challenge) {
        return json(400, { error: 'invalid_grant', error_description: 'Invalid code verifier.' })
      }
      issued.used = true
      oauth.exchanges += 1
      const scope = issued.scope
      if (oauth.noRefreshToken) {
        return json(200, { access_token: issueAccess(oauth.account), expires_in: 3600, token_type: 'Bearer', scope })
      }
      const refresh = `refresh-code-${oauth.exchanges}`
      oauth.sessions[refresh] = { account: oauth.account }
      return json(200, { access_token: issueAccess(oauth.account), refresh_token: refresh, expires_in: 3600, token_type: 'Bearer', scope })
    }
    return json(400, { error: 'unsupported_grant_type' })
  }

  const generateAccessToken = ({ path, token, body, clock }) => {
    const match = /^\/v1\/projects\/-\/serviceAccounts\/([^/:]+):generateAccessToken$/.exec(decodeURIComponent(path))
    const caller = accessTokens.get(token)
    if (iam.unauthenticated || !match || !caller) {
      return json(401, { error: { status: 'UNAUTHENTICATED' } })
    }
    const account = iam.serviceAccounts[match[1]]
    if (!account) {
      return json(404, { error: { status: 'NOT_FOUND' } })
    }
    if (!(account.tokenCreators || []).includes(caller)) {
      return json(403, { error: { status: 'PERMISSION_DENIED' } })
    }
    if (iam.empty) {
      return { status: 200 }
    }
    const lifetime = Number.parseInt(body.lifetime, 10)
    if (!(lifetime > 0 && lifetime <= 3600)) {
      return json(400, { error: { status: 'INVALID_ARGUMENT' } })
    }
    const issued = (account.tokens || []).shift()
    if (!issued) {
      return json(500, { error: { message: `no token queued for ${match[1]}` } })
    }
    iam.issued.push({ principal: match[1], roles: account.roles || [], lifetime })
    return json(200, { accessToken: issued, expireTime: new Date((Math.floor(clock / 1000) + lifetime) * 1000).toISOString() })
  }

  const exchange = ({ body }) => {
    if (
      body.grant_type !== 'urn:ietf:params:oauth:grant-type:token-exchange' ||
      body.audience !== sts.audience ||
      body.subject_token !== sts.subjectToken
    ) {
      return json(400, { error: 'invalid_grant' })
    }
    const issued = (sts.tokens || []).shift()
    if (!issued) {
      return json(500, { error: "no token queued" })
    }
    sts.issued.push({ principal: sts.principal, roles: sts.roles || [] })
    return json(200, { access_token: issued, expires_in: sts.expiresIn, token_type: 'Bearer' })
  }

  // https://accounts.google.com/o/oauth2/v2/auth: what the person's browser asks for. A request
  // Google would refuse is a 400 page; a consenting person is sent back to the redirect address
  // with a code and the `state` they were given, a refusing one with `error=access_denied`.
  const authorize = ({ query }) => {
    const redirect = /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(query.redirect_uri || '')
    oauth.authRequests.push({
      client_id: query.client_id,
      scope: query.scope,
      response_type: query.response_type,
      code_challenge_method: query.code_challenge_method,
      redirect_host: redirect ? '127.0.0.1' : null,
    })
    if (!query.client_id || query.response_type !== 'code' || !query.scope || !redirect) {
      return json(400, { error: 'invalid_request' })
    }
    // the provider always sends a challenge, and S256: `plain` is the default Google applies without one
    if (!query.code_challenge || query.code_challenge_method !== 'S256' || !query.state) {
      return json(400, { error: 'invalid_request' })
    }
    if (oauth.noConsent) {
      return { status: 200, json: {} }
    }
    const back = new URL(`${query.redirect_uri}/`)
    if (oauth.denied) {
      back.searchParams.set('error', 'access_denied')
    } else {
      const code = `code-${Object.keys(oauth.codes).length + 1}`
      oauth.codes[code] = { challenge: query.code_challenge, redirectUri: query.redirect_uri, scope: query.scope, used: false }
      back.searchParams.set('code', code)
      back.searchParams.set('scope', query.scope)
    }
    back.searchParams.set('state', query.state)
    return { status: 302, headers: { location: back.href } }
  }

  return (request) => {
    const { method, path } = request
    if (method === 'GET' && path === '/o/oauth2/v2/auth') {
      return authorize(request)
    }
    if (method === 'POST' && path === '/token') {
      return tokenEndpoint(request)
    }
    if (method === 'POST' && path === '/revoke') {
      if (oauth.revokeStatus) {
        return json(oauth.revokeStatus, { error: 'the fake is told to fail' })
      }
      const token = request.body && request.body.token
      if (!Object.hasOwn(oauth.sessions, token)) {
        return json(400, { error: 'invalid_token' })
      }
      delete oauth.sessions[token]
      oauth.revoked.push(token)
      return json(200, {})
    }
    if (method === 'POST' && path.endsWith(':generateAccessToken')) {
      return generateAccessToken(request)
    }
    if (method === 'POST' && path === '/v1/token') {
      return exchange(request)
    }
    return null
  }
}

module.exports = { createFake }
