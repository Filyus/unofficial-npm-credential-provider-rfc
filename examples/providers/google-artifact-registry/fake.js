'use strict'
// A fake Google for google-artifact-registry, answering from the state a
// scenario sets: the OAuth 2.0 endpoint, the Security Token Service and the
// IAM Credentials API, on one address. The paths and fields follow Google's
// published shapes as recalled (the device authorization and token
// endpoints, `serviceAccounts:generateAccessToken` with `lifetime` and
// `expireTime`, the STS token exchange); none was read against a live
// service. The registry itself is not here: the provider never calls it.
//
// state.oauth: interval, userCode, verificationUrl, pending (polls answered
//              authorization_pending, across both device flows), denied
//              (access_denied), expired (expired_token), slowDown (a first poll
//              answered slow_down; a poll less than 10 s after it is slow_down again, a
//              second expired_token), account,
//              sessions { refreshToken: { account, lapsed, lapseAfter } }
//              (`lapseAfter: n` ends the session after n refreshes, as when
//              an administrator's session length runs out between two requests)
// state.iam:   serviceAccounts { email: { roles, tokenCreators, tokens } }, a
//              queue of tokens per account that each impersonation takes from
// state.sts:   audience, subjectToken, principal, roles, expiresIn, tokens
// The fake adds oauth.devices, oauth.polls (device-code polls), oauth.refreshes, iam.issued and sts.issued:
// the principal and IAM roles each token was minted for, which is what the
// registry would judge it by.

const json = (status, body) => ({ status, json: body })

const createFake = (state) => {
  const oauth = (state.oauth ??= {})
  const iam = (state.iam ??= {})
  const sts = (state.sts ??= {})
  oauth.sessions ??= {}
  oauth.devices = 0
  oauth.polls = 0
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

  const tokenEndpoint = ({ body, clock }) => {
    if (body.grant_type === 'refresh_token') {
      const session = oauth.sessions[body.refresh_token]
      if (!session || session.lapsed || (session.lapseAfter !== undefined && (session.refreshes ?? 0) >= session.lapseAfter)) {
        return json(400, { error: 'invalid_grant' })
      }
      oauth.refreshes += 1
      session.refreshes = (session.refreshes ?? 0) + 1
      return json(200, { access_token: issueAccess(session.account), expires_in: 3600, token_type: 'Bearer' })
    }
    if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
      oauth.polls += 1
      if (!/^device-code-\d+$/.test(body.device_code || '') || Number(body.device_code.slice(12)) > oauth.devices) {
        return json(400, { error: 'invalid_grant' })
      }
      if (oauth.slowDown) {
        // the first poll is told to slow down; a poll sooner than that by the interval
        // given (5 s more) is told again, a second one that the code has expired
        if (oauth.notBefore === undefined) {
          oauth.notBefore = clock + 10000
          oauth.tooSoon = 0
          return json(400, { error: 'slow_down' })
        }
        if (clock < oauth.notBefore) {
          oauth.tooSoon += 1
          return json(400, { error: oauth.tooSoon >= 2 ? 'expired_token' : 'slow_down' })
        }
      }
      if (oauth.denied) {
        return json(400, { error: 'access_denied' })
      }
      if (oauth.expired) {
        return json(400, { error: 'expired_token' })
      }
      if (oauth.pending > 0) {
        oauth.pending -= 1
        return json(428, { error: 'authorization_pending' })
      }
      const refresh = `refresh-device-${body.device_code.slice(12)}`
      oauth.sessions[refresh] = { account: oauth.account }
      return json(200, { access_token: issueAccess(oauth.account), refresh_token: refresh, expires_in: 3600, token_type: 'Bearer' })
    }
    return json(400, { error: 'unsupported_grant_type' })
  }

  const generateAccessToken = ({ path, token, body, clock }) => {
    const match = /^\/v1\/projects\/-\/serviceAccounts\/([^/:]+):generateAccessToken$/.exec(decodeURIComponent(path))
    const caller = accessTokens.get(token)
    if (!match || !caller) {
      return json(401, { error: { status: 'UNAUTHENTICATED' } })
    }
    const account = iam.serviceAccounts[match[1]]
    if (!account) {
      return json(404, { error: { status: 'NOT_FOUND' } })
    }
    if (!(account.tokenCreators || []).includes(caller)) {
      return json(403, { error: { status: 'PERMISSION_DENIED' } })
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

  return (request) => {
    const { method, path } = request
    if (method === 'POST' && path === '/device/code') {
      oauth.devices += 1
      return json(200, {
        device_code: `device-code-${oauth.devices}`,
        user_code: oauth.userCode,
        verification_url: oauth.verificationUrl,
        expires_in: 600,
        interval: oauth.interval,
      })
    }
    if (method === 'POST' && path === '/token') {
      return tokenEndpoint(request)
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
