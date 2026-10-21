'use strict'
// A fake of the AWS endpoints the provider uses, answering from a state the
// scenario sets and changing it as AWS documents it. The operations and
// their fields follow the AWS API references, with two simplifications for
// the conformance run: a caller is named by its access key id sent as the
// bearer token (the real SDK signs each request with SigV4 and sends no
// secret), and every answer is JSON (STS answers XML by default). The portal's
// GetRoleCredentials is read in AWS's reference; recalled, not read: the IAM
// Identity Center device-authorization and token paths.
//
//   domains                       { name: owner }, the CodeArtifact domains
//   principals                    { accessKeyId: { account, tokens } }: callers
//                                 that exist; `tokens` is the queue of
//                                 authorization tokens their calls get;
//                                 `denied` makes GetAuthorizationToken a 403
//   roles                         { roleArn: { tokens, mfaSerial, mfaCode, denied } }: roles that can
//                                 be assumed; the credentials AssumeRole
//                                 issues are principals of that role, and
//                                 their tokens come from the role's queue
//   sso.sessions                  { ssoAccessToken: { expiresAt, credentials } }: the
//                                 sign-in sessions, `credentials` being the access key id
//                                 the portal hands out for it
//   sso.next                      sessions the next device sign-ins create, in order
//   sso.interval, pending, slowDown, userCode, verificationUri   the device flow
//   sso.slowDown                  as in RFC 8628: a poll sooner than 5 s after slow_down
//                                 is slow_down again, a second one expired_token
//   sso.userCode, verificationUri what the device authorization shows
//   throttle                      GetAuthorizationToken answers 429 this many times
//   expirationFraction            added to the expiration a token answer gives
//   secrets                       values that must never reach the fake (the secret half of
//                                 a credential): `leaked` lists each request that carried one
//   minted, assumed, checked      what the fake saw: authorization tokens issued
//                                 (with caller, duration and domain), roles
//                                 assumed (with duration, session policy and
//                                 MFA device), GetCallerIdentity calls

const json = (status, body) => ({ status, json: body })

const createFake = (state) => {
  state.domains ??= {}
  state.principals ??= {}
  state.roles ??= {}
  const sso = (state.sso ??= {})
  sso.sessions ??= {}
  sso.next ??= []
  state.minted = []
  state.assumed = []
  state.checked = 0
  state.leaked = []
  let counter = 0
  let notBefore = null
  let tooSoon = 0

  // the caller behind a bearer token, or null once its credentials have lapsed
  const caller = (token, seconds) => {
    const principal = state.principals[token]
    if (!principal || (principal.expiresAt !== undefined && principal.expiresAt <= seconds)) {
      return null
    }
    return principal
  }

  const deviceToken = ({ body, clock }) => {
    if (body.deviceCode !== 'device-code-1') {
      return json(400, { error: 'invalid_grant' })
    }
    if (sso.slowDown) {
      if (notBefore === null) {
        notBefore = clock + 5000
        return json(400, { error: 'slow_down' })
      }
      if (clock < notBefore) {
        tooSoon += 1
        return json(400, { error: tooSoon >= 2 ? 'expired_token' : 'slow_down' })
      }
    }
    if (sso.pending > 0) {
      sso.pending -= 1
      return json(400, { error: 'authorization_pending' })
    }
    const next = sso.next.shift()
    if (!next) {
      return json(500, { error: 'the fake has no sign-in sessions left to issue' })
    }
    sso.sessions[next.accessToken] = { expiresAt: clock / 1000 + 28800, credentials: next.credentials }
    return json(200, { accessToken: next.accessToken, tokenType: 'Bearer', expiresIn: 28800 })
  }

  const authorizationToken = ({ token, query, clock }) => {
    const seconds = clock / 1000
    const who = caller(token, seconds)
    if (!who) {
      return json(403, { message: 'The security token included in the request is invalid or expired' })
    }
    if (who.denied) {
      return json(403, { message: 'not authorized to perform codeartifact:GetAuthorizationToken' })
    }
    if (state.domains[query.domain] !== query['domain-owner']) {
      return json(404, { message: 'no such domain' })
    }
    const duration = Number(query.duration ?? 43200)
    if (duration !== 0 && !(duration >= 900 && duration <= 43200)) {
      return json(400, { message: 'duration must be 0 or between 900 and 43200 seconds' })
    }
    if (state.throttle > 0) {
      state.throttle -= 1
      return { status: 429, json: { message: 'Rate exceeded', retryAfterSeconds: 2 }, headers: { 'retry-after': '2' } }
    }
    // with 0 the token ends with the caller's role session
    const ends = duration === 0 ? who.expiresAt : seconds + duration
    // AWS's JSON timestamps are epoch seconds and may carry a fraction
    const expiration = ends === undefined ? undefined : ends + (state.expirationFraction ?? 0)
    if (expiration === undefined) {
      return json(400, { message: 'duration 0 needs credentials of a role session' })
    }
    const queue = who.role ? state.roles[who.role].tokens : who.tokens
    const issued = queue && queue.shift()
    if (!issued) {
      return json(500, { message: 'the fake has no authorization tokens left for this caller' })
    }
    state.minted.push({ caller: token, duration, domain: query.domain, owner: query['domain-owner'] })
    return json(200, { authorizationToken: issued, expiration })
  }

  const sts = ({ token, body, clock }) => {
    const seconds = clock / 1000
    const who = caller(token, seconds)
    if (!who) {
      return json(403, { Error: { Code: 'ExpiredToken' } })
    }
    if (body.Action === 'GetCallerIdentity') {
      state.checked += 1
      return json(200, { Account: who.account, Arn: `arn:aws:sts::${who.account}:assumed-role/${who.role || 'everyday'}/session` })
    }
    if (body.Action === 'AssumeRole') {
      const role = state.roles[body.RoleArn]
      const duration = Number(body.DurationSeconds)
      if (!role || role.denied) {
        return json(403, { Error: { Code: 'AccessDenied' } })
      }
      // the trust policy of a publish role requires an MFA device
      // and its current code: a wrong or missing one is AccessDenied (the message is recalled,
      // the saved AWS pages do not show an AssumeRole answer)
      if (role.mfaSerial && (body.SerialNumber !== role.mfaSerial || body.TokenCode !== role.mfaCode)) {
        return json(403, { Error: { Code: 'AccessDenied', Message: 'MultiFactorAuthentication failed with invalid MFA one time pass code(s).' } })
      }
      if (!(duration >= 900 && duration <= 43200) || !body.Policy) {
        return json(400, { Error: { Code: 'ValidationError' } })
      }
      counter += 1
      const accessKeyId = `assumed-key-${counter}`
      state.principals[accessKeyId] = { account: who.account, role: body.RoleArn, expiresAt: seconds + duration }
      state.assumed.push({ role: body.RoleArn, duration, policy: JSON.parse(body.Policy), serial: body.SerialNumber ?? null })
      return json(200, {
        Credentials: { AccessKeyId: accessKeyId, SecretAccessKey: 'unused', SessionToken: 'unused', Expiration: seconds + duration },
      })
    }
    return json(400, { Error: { Code: 'InvalidAction' } })
  }

  const handle = (request) => {
    const { method, path, token, body, query, clock } = request
    if (method === 'POST' && path === '/device_authorization') {
      return json(200, {
        deviceCode: 'device-code-1',
        userCode: sso.userCode ?? 'ABCD-1234',
        verificationUri: sso.verificationUri ?? 'https://device.sso.example.test/',
        expiresIn: sso.deviceExpiresIn ?? 600,
        interval: sso.interval ?? 5,
      })
    }
    if (method === 'POST' && path === '/token') {
      return deviceToken(request)
    }
    if (method === 'GET' && path === '/federation/credentials') {
      const session = sso.sessions[request.headers['x-amz-sso_bearer_token']]
      if (!session || session.expiresAt <= clock / 1000) {
        return json(401, { message: 'The SSO session has expired or is invalid' })
      }
      const expiresAt = clock / 1000 + 3600
      const principal = state.principals[session.credentials]
      if (!principal) {
        return json(403, { message: 'no such role credentials' })
      }
      principal.expiresAt = expiresAt
      return json(200, {
        roleCredentials: { accessKeyId: session.credentials, secretAccessKey: 'unused', sessionToken: 'unused', expiration: expiresAt * 1000 },
      })
    }
    if (method === 'POST' && path === '/') {
      return sts(request)
    }
    if (method === 'POST' && path === '/v1/authorization-token') {
      return authorizationToken(request)
    }
    return null
  }

  return (request) => {
    const seen = JSON.stringify([request.token, request.body, request.query, request.headers])
    if ((state.secrets || []).some((secret) => seen.includes(secret))) {
      state.leaked.push({ method: request.method, path: request.path })
    }
    return handle(request)
  }
}

module.exports = { createFake }
