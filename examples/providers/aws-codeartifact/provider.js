'use strict'
// A reference provider for the AWS CodeArtifact example
// (examples/aws-codeartifact.md): no standing secret of its own, only AWS
// credentials behind it (an IAM Identity Center session on a laptop, the
// ambient role in CI) and CodeArtifact authorization tokens minted from them
// per request. Reads use the everyday identity and a token for the whole
// domain; writes assume a publish role, with a session policy bound to the
// package and with the person's presence, and mint a token that ends with
// that session.
//
// From the page: the mapping of operations to identities, the answers, the
// messages, `other` over `not-found` for a login that lapsed, and the
// settings that choose an identity (profile, owner, roles) coming from this
// provider's own configuration and never from AWS_PROFILE or the like. The
// only AWS environment variables read are the ambient role's, and only in CI.
//
// AWS calls: GetAuthorizationToken (`POST /v1/authorization-token`),
// sts:GetCallerIdentity and sts:AssumeRole, as AWS documents them. Simplified
// for the run, as in fake.js: a caller is its access key id sent as the
// bearer token where the SDK would sign with SigV4, and the secret half of a
// credential is never used or sent (in CI its presence is checked). Recalled, not read: the IAM Identity Center
// device-authorization and token calls and the portal's role-credentials call.
//
// Differences from the page's provider, each because the run has no AWS CLI
// and no way to type into a prompt: it speaks the Identity Center device flow
// itself where the page runs `aws sso login --profile dev` (same sign-in, same
// outcomes, and what it keeps is the CLI's own cache, which the store here
// stands in for under `awsSsoCache`); and the person's presence for a write is
// one yes or no, since `lib/context.js` has no prompt that reads text, so the
// MFA code of the publish role's trust policy is not read: AssumeRole is
// sent with the device's serial number only. A provider with a text prompt
// would read the code there and send it as `TokenCode`.

const { serve, ok, err, log } = require('../lib/protocol.js')
const { loadContext } = require('../lib/context.js')

const CLIENT_NAME = 'npm-credential-provider-codeartifact'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
// the page: 900 seconds for a read token, the shortest the API allows
const READ_SECONDS = 900
// a write token ends with its role session, which lasts the minimum
const SESSION_SECONDS = 900
// a cached token or an SDK credential with less than this left is renewed
const MARGIN_SECONDS = 60
const CREDENTIAL_MARGIN_SECONDS = 300
// inside npm's 5-minute budget for `login` and an interactive `get`
const WAIT_MS = 4.5 * 60 * 1000
const THROTTLE_TRIES = 3
const PLAIN_NAME = /^[A-Za-z0-9._~-]+$/
const PLAIN_SCOPE = /^@[A-Za-z0-9._~-]+$/
const MAX_RETRY_AFTER_SECONDS = 10

// IAM actions per write operation. The page says `deprecate` needs an action
// AWS does not document, and maps it to the write identity with dist-tag's.
const WRITES = {
  publish: { action: 'PublishPackageVersion', verb: 'Publish', subject: 'Publishing' },
  'dist-tag': { action: 'PutPackageMetadata', verb: 'Change the dist-tags of', subject: 'Changing the dist-tags of' },
  deprecate: { action: 'PutPackageMetadata', verb: 'Deprecate', subject: 'Deprecating' },
}

// A protocol answer raised from deep inside a helper.
class Answer extends Error {
  constructor(answer) {
    super(answer.Err ? answer.Err.kind : 'answer')
    this.answer = answer
  }
}
const refuse = (message, causedBy) => new Answer(err('other', message, causedBy))

// The domain, owner, region and repository a registry URL names, or null.
// The host is matched whole and the owner is the 12 digits after the last
// hyphen, so `...amazonaws.com.evil.example` and a host of another shape
// match nothing. The VPC endpoint form carries domain and owner in the path.
const parseTarget = (registry) => {
  let url
  try {
    url = new URL(registry)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) {
    return null
  }
  const standard = /^([a-z0-9_-]+)-(\d{12})\.d\.codeartifact\.([a-z0-9-]+)\.(?:amazonaws\.com|on\.aws)$/.exec(url.hostname)
  const path = /^\/npm\/([A-Za-z0-9._-]+)\/$/.exec(url.pathname)
  if (standard && path) {
    return { domain: standard[1], owner: standard[2], region: standard[3], repository: path[1] }
  }
  const vpc = /^vpce-[a-z0-9-]+\.d\.codeartifact\.([a-z0-9-]+)\.vpce\.amazonaws\.com$/.exec(url.hostname)
  const vpcPath = /^\/npm\/d\/([a-z0-9_-]+)-(\d{12})\/([A-Za-z0-9._-]+)\/$/.exec(url.pathname)
  if (vpc && vpcPath) {
    return { domain: vpcPath[1], owner: vpcPath[2], region: vpc[1], repository: vpcPath[3] }
  }
  return null
}

const start = (args) => {
  const ctx = loadContext(args.config)
  const config = ctx.config
  // the arguments of the provider's own configuration line, never the environment
  const { profile, allowOwner, registries = [] } = config
  const lapsedMessage = `The AWS IAM Identity Center session for profile ${profile} has expired, so no new CodeArtifact token can be issued. Run aws sso login --profile ${profile}, or npm login.`
  const noTerminalMessage = `There is no terminal to show the aws sso login --profile ${profile} sign-in on, so it was not started and nothing was stored. Run npm login from a terminal.`
  const notCompletedMessage = `aws sso login --profile ${profile} was not completed, so no AWS session exists. Nothing was stored. Run npm login again and finish the sign-in in the browser.`

  // what the SDK holds in memory: the role credentials of the sign-in
  let credentials = null
  // read tokens by domain: one serves every repository of it
  const readTokens = new Map()

  const inCi = () => Boolean(process.env.CI) && process.env.CI !== 'false'
  const ambient = () =>
    inCi() && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? process.env.AWS_ACCESS_KEY_ID : null

  // the sign-in's cache: `~/.aws/sso/cache` in a real build, which the AWS CLI
  // owns and this provider never clears
  const ssoCache = () => (ctx.readStore().awsSsoCache || {})[profile] || null
  const saveSsoCache = (entry) => {
    const store = ctx.readStore()
    store.awsSsoCache = { ...store.awsSsoCache, [profile]: entry }
    ctx.writeStore(store)
  }
  // something to mint from: the ambient role in CI, a sign-in otherwise,
  // even a lapsed one; nothing at all is `not-found`
  const hasIdentity = () => (inCi() ? ambient() !== null : ssoCache() !== null)

  const nameOf = (req) => (req.scope ? `${req.scope}/${req.package}` : req.package)

  // --- sign-in: the Identity Center device flow (RFC 8628) -------------------

  const ssoLogin = async () => {
    const oidc = `https://oidc.${config.ssoRegion}.amazonaws.com`
    const started = await ctx.request('POST', `${oidc}/device_authorization`, {
      body: { clientId: CLIENT_NAME, startUrl: config.ssoStartUrl },
    })
    if (started.status !== 200 || !started.json || !started.json.deviceCode) {
      throw refuse(`IAM Identity Center answered ${started.status} to the sign-in request for profile ${profile}.`)
    }
    const { deviceCode, userCode, verificationUri } = started.json
    let interval = started.json.interval ?? 5
    const deadline = ctx.clockMs() + Math.min((started.json.expiresIn ?? 270) * 1000, WAIT_MS)
    // nothing can be finished when the step cannot be shown: stop before polling, and store nothing
    if (!ctx.showToPerson(`Open ${verificationUri} and enter the code ${userCode}`)) {
      throw refuse(noTerminalMessage)
    }
    for (;;) {
      await ctx.sleep(Math.min(interval * 1000, Math.max(0, deadline - ctx.clockMs())))
      const polled = await ctx.request('POST', `${oidc}/token`, {
        body: { grantType: DEVICE_GRANT, deviceCode, clientId: CLIENT_NAME },
      })
      if (polled.status === 200 && polled.json && polled.json.accessToken) {
        saveSsoCache({ accessToken: polled.json.accessToken, expiresAt: ctx.now() + (polled.json.expiresIn ?? 28800) })
        credentials = null
        return
      }
      const code = polled.json && polled.json.error
      if (code === 'slow_down') {
        interval += 5
      } else if (code !== 'authorization_pending') {
        break
      }
      if (ctx.clockMs() >= deadline) {
        break
      }
    }
    throw refuse(notCompletedMessage)
  }

  // --- the AWS credentials behind the provider ---------------------------------

  // The access key id of the identity to mint from, or null when the sign-in
  // has lapsed (the portal refuses it, or STS refuses what it handed out).
  const signedInKey = async (target) => {
    if (credentials && credentials.expiresAt - ctx.now() > CREDENTIAL_MARGIN_SECONDS) {
      return credentials.keyId
    }
    const cache = ssoCache()
    const portal = `https://portal.sso.${config.ssoRegion}.amazonaws.com`
    const got = await ctx.request('POST', `${portal}/federation/credentials`, {
      token: cache.accessToken,
      body: { accountId: config.ssoAccountId, roleName: config.ssoRoleName },
    })
    if (got.status === 401) {
      return null
    }
    if (got.status !== 200 || !got.json || !got.json.roleCredentials) {
      throw refuse(`The IAM Identity Center portal answered ${got.status} to the role credentials for profile ${profile}.`)
    }
    const { accessKeyId, expiration } = got.json.roleCredentials
    credentials = { keyId: accessKeyId, expiresAt: Math.floor(expiration / 1000) }
    // the provider's own check, before anything is minted or a login started
    if (!(await callerIdentityOk(target, accessKeyId))) {
      credentials = null
      return null
    }
    return accessKeyId
  }

  const callerIdentityOk = async (target, keyId) => {
    const res = await ctx.request('POST', `https://sts.${target.region}.amazonaws.com/`, {
      token: keyId,
      form: { Action: 'GetCallerIdentity', Version: '2011-06-15' },
    })
    return res.status === 200
  }

  // the identity a request mints from: the ambient role in CI, else the
  // sign-in, renewed by a login only when a person is there to complete it
  const identityKey = async (req, target) => {
    const key = ambient()
    if (key) {
      if (!(await callerIdentityOk(target, key))) {
        throw refuse('The ambient AWS credentials were not accepted by AWS, so no CodeArtifact token can be issued.')
      }
      return key
    }
    let signed = await signedInKey(target)
    if (signed === null && req.interactive) {
      await ssoLogin()
      signed = await signedInKey(target)
    }
    if (signed === null) {
      throw refuse(lapsedMessage)
    }
    return signed
  }

  // --- CodeArtifact and STS ---------------------------------------------------

  // `GetAuthorizationToken`; a 429 is waited out, inside the request's budget
  const authorizationToken = async (target, keyId, duration) => {
    const query = new URLSearchParams({ domain: target.domain, 'domain-owner': target.owner, duration: String(duration) })
    const url = `https://codeartifact.${target.region}.amazonaws.com/v1/authorization-token?${query}`
    for (let attempt = 1; ; attempt += 1) {
      const res = await ctx.request('POST', url, { token: keyId })
      if (res.status === 429 && attempt < THROTTLE_TRIES) {
        const wait = Math.min(Number(res.json && res.json.retryAfterSeconds) || 1, MAX_RETRY_AFTER_SECONDS)
        await ctx.sleep(wait * 1000)
        continue
      }
      const issued = res.json
      if (res.status !== 200 || !issued || typeof issued.authorizationToken !== 'string') {
        throw refuse(`AWS answered ${res.status} to GetAuthorizationToken for domain ${target.domain}.`)
      }
      // integer Unix seconds, as the page says: AWS's JSON timestamps are epoch
      // seconds and may carry a fraction, which is cut (the earlier second, so
      // the token is never kept past its end); a millisecond value would be a
      // token npm never expires, and is refused
      if (!Number.isFinite(issued.expiration) || issued.expiration <= 0 || issued.expiration >= 1e11) {
        throw refuse('AWS gave an expiry that is not in Unix seconds.')
      }
      return { token: issued.authorizationToken, expiresAt: Math.floor(issued.expiration) }
    }
  }

  // The publish role, assumed with a session policy that names the package:
  // the action on its ARN (scope without the `@`, an empty namespace for an
  // unscoped package, case kept), and the two calls the mint itself needs.
  const assumePublishRole = async (req, target, keyId, action, withMfa) => {
    const namespace = req.scope ? req.scope.slice(1) : ''
    const arn = `arn:aws:codeartifact:${target.region}:${target.owner}:package/${target.domain}/${target.repository}/npm/${namespace}/${req.package}`
    const policy = {
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: `codeartifact:${action}`, Resource: arn },
        {
          Effect: 'Allow',
          Action: 'codeartifact:GetAuthorizationToken',
          Resource: `arn:aws:codeartifact:${target.region}:${target.owner}:domain/${target.domain}`,
        },
        { Effect: 'Allow', Action: 'sts:GetServiceBearerToken', Resource: '*' },
      ],
    }
    const res = await ctx.request('POST', `https://sts.${target.region}.amazonaws.com/`, {
      token: keyId,
      form: {
        Action: 'AssumeRole',
        Version: '2011-06-15',
        RoleArn: config.publishRoleArn,
        RoleSessionName: CLIENT_NAME,
        DurationSeconds: String(SESSION_SECONDS),
        Policy: JSON.stringify(policy),
        ...(withMfa ? { SerialNumber: config.mfaSerial } : {}),
      },
    })
    const issued = res.json && res.json.Credentials
    if (res.status !== 200 || !issued) {
      throw refuse(`AWS refused to assume the publish role for ${nameOf(req)} (HTTP ${res.status}).`)
    }
    return issued.AccessKeyId
  }

  // --- handlers ----------------------------------------------------------------

  const confirmWithin = (question, ms) => ctx.withDeadline((signal) => ctx.confirm(question, signal), ms)

  const get = async (req) => {
    const target = registries.includes(req.registry) ? parseTarget(req.registry) : null
    if (!target || target.owner !== allowOwner) {
      return err('url-not-supported')
    }
    const write = Object.hasOwn(WRITES, req.operation) ? WRITES[req.operation] : null
    if (req.operation !== 'read' && !write) {
      return err('operation-not-supported')
    }
    const name = nameOf(req)
    const label = write && req.version ? `${name}@${req.version}` : name
    // A write names the package in an IAM Resource ARN, where `*`, `?` and
    // `${` mean something: a name with anything but plain characters is
    // refused before a person is asked, rather than widening the session policy.
    if (write && !(PLAIN_NAME.test(req.package ?? '') && (req.scope === undefined || PLAIN_SCOPE.test(req.scope)))) {
      return err('other', `${write.subject} a package whose name has characters that this provider will not put in an IAM policy was refused.`)
    }

    // The token is an identity snapshot and each request is authorized when it
    // is made: a new token from the same identity would be refused the same
    // way, so none is minted. A 403 never moves to another identity here.
    if (req.retry === true && req.httpStatus === 403) {
      return err(
        'other',
        write
          ? `The publish identity is denied ${write.action} for this package. A new token would be refused the same way.`
          : 'The identity is denied ReadFromRepository for this repository. A new token would be refused the same way.',
        ['registry answered 403'],
      )
    }
    if (!hasIdentity()) {
      return err('not-found')
    }
    if (write) {
      if (inCi() ? !config.ciPublisher : !req.interactive) {
        return err(
          'other',
          inCi()
            ? `${write.subject} ${label} needs a publisher role, and this provider is not configured to treat the ambient role as one.`
            : `${write.subject} ${label} needs the person's presence, and this request is not interactive. Run it from a terminal.`,
        )
      }
    }

    const domainKey = `${target.region}/${target.owner}/${target.domain}`
    if (!write) {
      // a 401 retry without an erase does not get the token back that failed
      if (req.retry) {
        readTokens.delete(domainKey)
      }
      const held = readTokens.get(domainKey)
      if (held && held.expiresAt - ctx.now() > MARGIN_SECONDS) {
        return held.answer
      }
    }

    const keyId = await identityKey(req, target)
    if (!write) {
      const minted = await authorizationToken(target, keyId, READ_SECONDS)
      const answer = ok('get', {
        auth: { type: 'bearer', token: minted.token },
        cache: 'expires',
        expiresAt: minted.expiresAt,
        operationIndependent: true,
        granularity: 'registry',
      })
      readTokens.set(domainKey, { expiresAt: minted.expiresAt, answer })
      return answer
    }

    if (!inCi()) {
      const question = `${write.verb} ${label} on ${target.repository} in domain ${target.domain}?`
      const answered = await confirmWithin(question, WAIT_MS)
      if (answered === null) {
        return err('other', `${write.subject} ${label} was not confirmed within 4 minutes 30 seconds.`)
      }
      if (!answered) {
        return err('other', `${write.subject} ${label} was not confirmed.`)
      }
    }
    const role = await assumePublishRole(req, target, keyId, write.action, !inCi())
    // duration 0: the token ends with the role session
    const minted = await authorizationToken(target, role, 0)
    return ok('get', {
      auth: { type: 'bearer', token: minted.token },
      cache: 'expires',
      expiresAt: minted.expiresAt,
      operationIndependent: false,
      granularity: 'package',
    })
  }

  // Drops the provider's own copy of what it handed out. Write tokens are
  // never kept, and the sign-in is `login`'s and the CLI's.
  const erase = async (req) => {
    const target = registries.includes(req.registry) ? parseTarget(req.registry) : null
    if (!target || target.owner !== allowOwner) {
      return err('url-not-supported')
    }
    readTokens.delete(`${target.region}/${target.owner}/${target.domain}`)
    return ok('erase')
  }

  const login = async (req) => {
    const target = registries.includes(req.registry) ? parseTarget(req.registry) : null
    if (!target || target.owner !== allowOwner) {
      return err('url-not-supported')
    }
    if (req.token !== undefined) {
      return err('other', 'A CodeArtifact token lasts at most 12 hours, so this provider does not store one. Run npm login without a token.')
    }
    // a profile with static, instance or environment credentials has no sign-in
    if (!config.ssoStartUrl) {
      return err('operation-not-supported')
    }
    if (!req.interactive) {
      return err('other', 'Signing in needs the person to finish it in a browser, and this request is not interactive.')
    }
    try {
      await ssoLogin()
    } catch (error) {
      if (error instanceof Answer) {
        return error.answer
      }
      throw error
    }
    return ok('login')
  }

  // The provider's own tokens go. Tokens already issued stay valid until they
  // expire, since CodeArtifact has no per-token revocation, and `aws sso logout` is
  // never run: it signs the user out of every profile.
  const logout = async (req) => {
    const target = registries.includes(req.registry) ? parseTarget(req.registry) : null
    if (!target || target.owner !== allowOwner) {
      return err('url-not-supported')
    }
    readTokens.clear()
    log('logout: issued CodeArtifact tokens stay valid until they expire; the AWS sign-in is untouched')
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
    hello: { v: [1], capabilities: ['login', 'logout', 'erase'], registries },
    handlers: { get: guarded(get), erase, login, logout },
  }
}

serve(start)
