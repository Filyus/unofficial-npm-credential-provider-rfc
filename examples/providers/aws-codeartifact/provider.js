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
// credential is never used or sent (in CI its presence is checked). The portal's
// GetRoleCredentials is read in AWS's reference (`GET /federation/credentials?account_id=&role_name=`
// with the sign-in token in `x-amz-sso_bearer_token`; the portal host here is recalled).
// Recalled, not read: the IAM Identity Center device-authorization and token calls.
//
// Difference from the page's provider, because the run has no AWS CLI: it
// speaks the Identity Center device flow itself where the page runs `aws sso
// login --profile dev` (same sign-in, same outcomes, and what it keeps is the
// CLI's own cache, which the store here stands in for under `awsSsoCache`; being
// the provider's own store here, logout removes it, which a build that leaves the
// CLI's cache alone would have to record in a store of its own instead).
//
// A read never starts a sign-in and never asks the person anything, whatever
// `interactive` says: a lapsed Identity Center session on a read is `other`
// naming the renew command. Only a write on an interactive request may start
// the sign-in, and only after the person has said yes to the write.
//
// In CI the reference provider reads only exported AWS_ACCESS_KEY_ID and
// AWS_SECRET_ACCESS_KEY, a stand-in for the SDK default chain, which a real
// build would use and which also finds container credentials (CodeBuild),
// web identity (GitHub OIDC) and instance profiles. A long-lived IAM user key
// in the job is what this stand-in would encourage; a real build avoids it.
//
// A write on an `interactive` request asks the person twice on the controlling
// terminal, inside one 4 minute 30 second budget (npm's 5 minutes for an
// interactive `get`), the first question before any sign-in is started: yes or
// no to the operation, then the MFA code of the publish role's trust policy,
// sent to STS as `TokenCode` beside the device's `SerialNumber`. A code that is
// not typed in time, or that STS refuses, is `other`. A request that is not
// `interactive` asks nothing, and a write is served to it only where the
// provider's own configuration (`ciPublisher`, never an environment variable)
// says the ambient role is a publisher: where the write credential is already
// ambient in the job, the gate adds nothing and releasing it is honest, and
// where it is not, `interactive: false` alone does not release it.

const { serve, ok, err, log, Answer } = require('../lib/protocol.js')
const { loadContext, plain } = require('../lib/context.js')

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

// a protocol answer raised from deep inside a helper (lib's `Answer`, which `serve` answers itself)
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
  const restoreSsoCache = (entry) => {
    const store = ctx.readStore()
    const caches = { ...store.awsSsoCache }
    if (entry) {
      caches[profile] = entry
    } else {
      delete caches[profile]
    }
    if (Object.keys(caches).length) {
      store.awsSsoCache = caches
    } else {
      delete store.awsSsoCache
    }
    ctx.writeStore(store)
    credentials = null
  }
  // something to mint from: the ambient role in CI, a sign-in otherwise,
  // even a lapsed one; nothing at all is `not-found`
  const hasIdentity = () => (inCi() ? ambient() !== null : ssoCache() !== null)

  const nameOf = (req) => (req.scope ? `${req.scope}/${req.package}` : req.package)

  // --- sign-in: the Identity Center device flow (RFC 8628) -------------------

  // `until`: the time on the context's clock by which the sign-in must be over, the
  // end of the request's own budget and not a fresh one
  const ssoLogin = async (until) => {
    const oidc = `https://oidc.${config.ssoRegion}.amazonaws.com`
    const started = await ctx.request('POST', `${oidc}/device_authorization`, {
      body: { clientId: CLIENT_NAME, startUrl: config.ssoStartUrl },
    })
    if (started.status !== 200 || !started.json || !started.json.deviceCode) {
      throw refuse(`IAM Identity Center answered ${started.status} to the sign-in request for profile ${profile}.`)
    }
    const { deviceCode, userCode, verificationUri } = started.json
    let interval = started.json.interval ?? 5
    const deadline = Math.min(ctx.clockMs() + (started.json.expiresIn ?? 270) * 1000, until)
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
    const query = new URLSearchParams({ account_id: config.ssoAccountId, role_name: config.ssoRoleName })
    const got = await ctx.request('GET', `${portal}/federation/credentials?${query}`, {
      headers: { 'x-amz-sso_bearer_token': cache.accessToken },
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
  // sign-in, renewed by a login only for a write on an interactive request, after
  // the person has said yes to it: a read never starts a sign-in, whatever `interactive`
  const identityKey = async (req, target, until, write) => {
    const key = ambient()
    if (key) {
      if (!(await callerIdentityOk(target, key))) {
        throw refuse('The ambient AWS credentials were not accepted by AWS, so no CodeArtifact token can be issued.')
      }
      return key
    }
    let signed = await signedInKey(target)
    if (signed === null && write && req.interactive) {
      await ssoLogin(until)
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
  const assumePublishRole = async (req, target, keyId, action, mfaCode) => {
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
        ...(mfaCode ? { SerialNumber: config.mfaSerial, TokenCode: mfaCode } : {}),
      },
    })
    const issued = res.json && res.json.Credentials
    if (res.status !== 200 || !issued) {
      const code = res.json && res.json.Error && res.json.Error.Code
      throw refuse(
        mfaCode && code === 'AccessDenied'
          ? `AWS refused to assume the publish role for ${nameOf(req)} (HTTP ${res.status} ${code}): the MFA code was not accepted, or the role does not allow this identity.`
          : `AWS refused to assume the publish role for ${nameOf(req)} (HTTP ${res.status}).`,
      )
    }
    return issued.AccessKeyId
  }

  // --- handlers ----------------------------------------------------------------

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
    // is made: a new token from the same identity is not expected to be
    // treated differently, so none is minted. A 403 never moves to another
    // identity here. The answer says what the provider saw, that the registry
    // answered 403; why it did is not in the answer, so the action to check is
    // named as the likely one, not asserted.
    if (req.retry === true && req.httpStatus === 403) {
      return err(
        'other',
        write
          ? `The registry answered 403 to the ${req.operation} of ${label} made with a token minted for the publish identity, and did not say why. A new token from the same identity would be authorized the same way, so none is minted. Check that the identity is allowed ${write.action} on this package.`
          : `The registry answered 403 to a read of ${target.repository} made with a token minted for the everyday identity, and did not say why. A new token from the same identity would be authorized the same way, so none is minted. Check that the identity is allowed ReadFromRepository on this repository.`,
        ['registry answered 403'],
      )
    }
    if (!hasIdentity()) {
      return err('not-found')
    }
    // Presence is the request's `interactive`, not the `CI` variable: whoever ran npm sets
    // that variable, and a request npm says is interactive has a person to ask. Without
    // one a write is served only where the provider's own configuration says the
    // ambient role is a publisher.
    if (write && !req.interactive && !(config.ciPublisher && ambient() !== null)) {
      return err(
        'other',
        inCi() && !config.ciPublisher
          ? `${write.subject} ${label} needs a publisher role, and this provider is not configured to treat the ambient role as one.`
          : `${write.subject} ${label} needs the person's presence, and this request is not interactive. Run it from a terminal.`,
      )
    }
    // one deadline for everything the request waits on for the person: the sign-in, the
    // presence prompt and the code, inside npm's 5 minutes for an interactive `get`
    const deadline = ctx.clockMs() + WAIT_MS
    if (write && req.interactive) {
      const question = `${write.verb} ${label} on ${target.repository} in domain ${target.domain}?`
      const answered = await ctx.confirmWithin(question, WAIT_MS)
      if (answered === null) {
        return err('other', `${write.subject} ${label} was not confirmed within 4 minutes 30 seconds.`)
      }
      if (!answered) {
        return err('other', `${write.subject} ${label} was not confirmed.`)
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

    const keyId = await identityKey(req, target, deadline, write)
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

    let mfaCode = null
    if (req.interactive) {
      const left = deadline - ctx.clockMs()
      const typed = left > 0 ? await ctx.askWithin(`MFA code of ${config.mfaSerial} for the publish role:`, left, { secret: true }) : null
      if (typed === null) {
        return err('other', `The MFA code for ${write.subject.toLowerCase()} ${label} was not entered within 4 minutes 30 seconds.`)
      }
      mfaCode = typed.trim()
      if (!mfaCode) {
        return err('other', `No MFA code was entered, so ${write.subject.toLowerCase()} ${label} was not authorized.`)
      }
    }
    const role = await assumePublishRole(req, target, keyId, write.action, mfaCode)
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
    // the sign-in is kept only once AWS accepts what it hands out, as the Azure provider
    // confirms its login; a failed one gives back the sign-in it replaced
    const previous = ssoCache()
    try {
      await ssoLogin(ctx.clockMs() + WAIT_MS)
      if ((await signedInKey(target)) === null) {
        throw refuse(`AWS did not accept the role credentials of the new sign-in for profile ${profile}. Nothing was stored. Run npm login again.`)
      }
    } catch (error) {
      restoreSsoCache(previous)
      throw error
    }
    return ok('login')
  }

  // The provider's own tokens go, and the sign-in its `login` made, which in this
  // reference provider is its own store (a real build that leaves the CLI's cache
  // alone has to record the logout, or installs keep minting). Tokens already issued
  // stay valid until they expire, since CodeArtifact has no per-token revocation,
  // and `aws sso logout` is never run: it signs the user out of every profile.
  // Nothing held is `not-found`.
  const logout = async (req) => {
    const target = registries.includes(req.registry) ? parseTarget(req.registry) : null
    if (!target || target.owner !== allowOwner) {
      return err('url-not-supported')
    }
    const held = readTokens.size > 0 || ssoCache() !== null
    readTokens.clear()
    if (!held) {
      return err('not-found')
    }
    restoreSsoCache(null)
    log('logout: issued CodeArtifact tokens stay valid until they expire; the sign-in was removed here, and aws sso logout was not run')
    return ok('logout')
  }

  return {
    hello: { v: [1], capabilities: ['login', 'logout'], registries },
    handlers: { get, erase, login, logout },
  }
}

serve(start)
