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
//   oauth.interval, deviceExpiresIn         the device grant's poll interval (0) and lifetime (300 s);
//                                           with an interval, a poll sooner than it is slow_down
//   oauth.revoked                           tokens revoked so far
//   tokens                                  secrets the next deploy tokens get
//   deployTokens                            live deploy tokens, as created
//   deleted                                 ids deleted so far
//   nextId                                  id of the next deploy token
//   failDeletes                             how many of the next DELETEs of a deploy token
//                                           are answered 500 and delete nothing
//   oauth.refreshStatus                     a status (503) the refresh grant answers instead of
//                                           looking at the token, as when GitLab is down
//
// For the live run (examples/providers/live/gitlab.js), which sends the fake what npm would send with a
// released credential and what a person or an administrator would do beside the provider; every
// answer below that the scenarios do not reach is what a real GitLab 19.5.1 answered to that request
// in that run (examples/gitlab.md, "Against a real GitLab"):
//
//   packages                                packages the project registry holds, name to versions
//                                           (the default: @acme/widgets 2.4.0)
//   jobToken                                the CI job token of a running job of project 42
//   access                                  more OAuth access tokens, token to { level }, level being the
//                                           member's role (40 Maintainer, 30 Developer)
//   projectOf                               the project of a deploy token, by id (default 42)
//
// and the administrator's own token, `admin-pat`, which every API route here takes. Projects 42 and
// 43 exist; a member's OAuth token is a member of 42 only.

const json = (status, body, headers) => ({ status, json: body, ...(headers ? { headers } : {}) })

// the administrator's personal access token of a live run
const ADMIN = 'admin-pat'

// What the REST API sends with its answers (Vary is `Accept-Encoding, Origin` where the body is
// compressed, which is the compressor's, and the live run leaves it out): a body is never cached
// without revalidation, an error or an empty answer is not cached at all.
const OK = { vary: 'Origin', 'cache-control': 'max-age=0, private, must-revalidate' }
const NO = { vary: 'Origin', 'cache-control': 'no-cache' }
const api = (status, body) => json(status, body, status >= 400 ? NO : OK)
const unauthorized = () => api(401, { message: '401 Unauthorized' })
// the token endpoint, and the other OAuth endpoints of Doorkeeper
const NO_STORE = { vary: 'Origin', 'cache-control': 'no-store' }
const DESCRIPTIONS = {
  invalid_grant: 'The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client.',
  invalid_client: 'Client authentication failed due to unknown client, no client authentication included, or unsupported authentication method.',
  access_denied: 'The resource owner or authorization server denied the request.',
  invalid_token: 'Token was revoked. You have to re-authorize from the user.',
}
const oauthError = (status, error, { realm = 'Doorkeeper', vary = 'Origin' } = {}) => {
  const description = DESCRIPTIONS[error] || error
  return json(status, { error, error_description: description }, { vary, 'cache-control': 'no-store', 'www-authenticate': `Bearer realm="${realm}", error="${error}", error_description="${description}"` })
}
// what the API says to a token Doorkeeper has revoked, and, plainly, to one it does not know
const revokedToken = () => json(401, { error: 'invalid_token', error_description: DESCRIPTIONS.invalid_token }, { ...NO, 'www-authenticate': `Bearer realm="Protected by OAuth 2.0", error="invalid_token", error_description="${DESCRIPTIONS.invalid_token}"` })
// the keys of the user a member's token reads
const USER_KEYS = 'avatar_url,bio,bot,can_create_group,can_create_project,color_scheme_id,commit_email,confirmed_at,created_at,current_sign_in_at,discord,email,external,github,id,identities,job_title,last_activity_on,last_sign_in_at,linkedin,local_time,location,locked,name,organization,preferred_language,private_profile,projects_limit,pronouns,public_email,state,theme_id,twitter,two_factor_enabled,username,web_url,website_url,work_information'.split(',')
const PACKAGE_KEYS = 'created_at,creator_id,id,last_downloaded_at,name,project_id,status,status_message,updated_at,version'.split(',')
const PROJECTS = new Set(['42', '43'])

const createFake = (state) => {
  state.oauth = state.oauth || {}
  const oauth = state.oauth
  oauth.next = oauth.next || []
  oauth.revoked = oauth.revoked || []
  state.tokens = state.tokens || []
  state.deployTokens = state.deployTokens || []
  state.deleted = state.deleted || []
  state.nextId = state.nextId || 1
  state.packages = state.packages || { '@acme/widgets': ['2.4.0'] }

  // who an OAuth or personal access token is: the administrator, a member of project 42 with
  // a role, a token Doorkeeper has revoked, or one nobody knows (`unknown`, and `none` for no token)
  const identify = (token) => {
    if (!token) {
      return { kind: 'none' }
    }
    if (token === ADMIN) {
      return { kind: 'admin', level: 50 }
    }
    const known = token === oauth.accessToken || (state.access && state.access[token])
    if (oauth.revoked.includes(token)) {
      return { kind: 'revoked' }
    }
    if (token === oauth.accessToken) {
      return { kind: 'member', level: 40 }
    }
    return known ? { kind: 'member', level: state.access[token].level } : { kind: 'unknown' }
  }
  const projectOf = (id) => (state.projectOf || {})[id] || '42'

  // GitLab's token response: both tokens, two hours, a creation time
  const issue = () => {
    const pair = oauth.next.shift()
    if (!pair) {
      return json(500, { error: 'the fake has no tokens left to issue' })
    }
    oauth.accessToken = pair.accessToken
    oauth.refreshToken = pair.refreshToken
    return json(
      200,
      { access_token: pair.accessToken, token_type: 'Bearer', expires_in: 7200, refresh_token: pair.refreshToken, scope: 'api', created_at: 0 },
      NO_STORE,
    )
  }

  // who a registry credential is, for the project in the URL: a record with what it may do, or
  // an answer (no credential and a credential nobody knows are both 401; a credential of another
  // project is a 404)
  const principal = (token, project) => {
    if (!token) {
      return { answer: unauthorized() }
    }
    const who = identify(token)
    if (who.kind === 'admin') {
      return { read: true, write: true }
    }
    if (who.kind === 'revoked') {
      return { answer: revokedToken() }
    }
    if (who.kind === 'member') {
      return project === '42' ? { read: true, write: who.level >= 30 } : { answer: api(404, { error: '404 Not Found', message: '404 Not Found' }) }
    }
    if (token === state.jobToken) {
      return project === '42' ? { read: true, write: true } : { answer: api(404, { error: '404 Not Found', message: '404 Not Found' }) }
    }
    const deploy = state.deployTokens.find((candidate) => candidate.token === token)
    if (deploy) {
      // a deploy token reads with either scope and writes with the write scope
      return projectOf(deploy.id) === project ? { read: true, write: deploy.scopes.includes('write_package_registry') } : { answer: api(404, { error: '404 Not Found', message: '404 Not Found' }) }
    }
    return { answer: unauthorized() }
  }

  const packument = (name, versions) => ({ name, versions: Object.fromEntries(versions.map((version) => [version, { name, version }])), 'dist-tags': { latest: versions[versions.length - 1] } })

  return ({ method, path, token, body, clock }) => {
    if (method === 'POST' && path === '/oauth/token') {
      if (body.grant_type === 'refresh_token') {
        if (oauth.refreshStatus) {
          return json(oauth.refreshStatus, { error: 'temporarily_unavailable', error_description: 'temporarily_unavailable' }, NO_STORE)
        }
        // the old refresh token stops working with the first use
        return body.refresh_token === oauth.refreshToken && !oauth.revoked.includes(body.refresh_token) ? issue() : oauthError(400, 'invalid_grant')
      }
      if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        if (oauth.slowDown) {
          if (oauth.notBefore === undefined) {
            oauth.notBefore = clock + 5000
            return oauthError(400, 'slow_down')
          }
          if (clock < oauth.notBefore) {
            oauth.tooSoon = (oauth.tooSoon || 0) + 1
            return oauthError(400, oauth.tooSoon >= 2 ? 'expired_token' : 'slow_down')
          }
        }
        // a server that has an interval asks for polls no sooner than it (RFC 8628)
        if (oauth.interval > 0 && !oauth.slowDown) {
          const tooSoon = oauth.lastPoll !== undefined && clock - oauth.lastPoll < oauth.interval * 1000
          oauth.lastPoll = clock
          if (tooSoon) {
            return oauthError(400, 'slow_down')
          }
        }
        if (oauth.pending > 0) {
          oauth.pending -= 1
          return oauthError(400, 'authorization_pending')
        }
        return body.device_code === 'device-code' ? issue() : oauthError(400, 'invalid_grant')
      }
      return oauthError(400, 'unsupported_grant_type')
    }
    if (method === 'POST' && path === '/oauth/authorize_device') {
      return json(
        200,
        {
          device_code: 'device-code',
          user_code: 'ABCD-1234',
          verification_uri: 'https://gitlab.example.com/oauth/device',
          expires_in: oauth.deviceExpiresIn ?? 300,
          interval: oauth.interval ?? 0,
        },
        { vary: 'Accept', 'cache-control': 'no-store' },
      )
    }
    if (method === 'POST' && path === '/oauth/revoke') {
      oauth.revoked.push(body.token)
      return json(200, {}, OK)
    }

    if (method === 'GET' && path === '/api/v4/user') {
      const who = identify(token)
      if (who.kind === 'revoked') {
        return revokedToken()
      }
      return who.kind === 'member' || who.kind === 'admin' ? api(200, Object.fromEntries(USER_KEYS.map((key) => [key, key === 'username' ? 'maint' : null]))) : unauthorized()
    }

    const route = /^\/api\/v4\/projects\/(\d+)\/deploy_tokens(?:\/(\d+))?$/.exec(path)
    if (route) {
      const who = identify(token)
      if (who.kind === 'unknown') {
        return unauthorized()
      }
      if (who.kind === 'revoked') {
        return revokedToken()
      }
      // a project nobody sees is a 404, to a member of another project and to no one alike
      if (who.kind === 'none' || !PROJECTS.has(route[1]) || (who.kind === 'member' && route[1] !== '42')) {
        return api(404, { message: '404 Project Not Found' })
      }
      if (who.level < 40) {
        return api(403, { message: '403 Forbidden' })
      }
      if (method === 'POST' && !route[2]) {
        const scopes = Array.isArray(body.scopes) ? body.scopes : []
        if (!scopes.length) {
          return api(400, { error: 'scopes is missing' })
        }
        if (scopes.some((scope) => !['read_repository', 'read_registry', 'write_registry', 'read_package_registry', 'write_package_registry', 'read_virtual_registry', 'write_virtual_registry'].includes(scope))) {
          return api(400, { error: 'scopes does not have a valid value' })
        }
        const secret = state.tokens.shift()
        if (!secret) {
          return json(500, { message: 'the fake has no deploy token secrets left' })
        }
        const created = { id: state.nextId, token: secret, scopes, expires_at: body.expires_at }
        state.nextId += 1
        state.deployTokens.push(created)
        state.projectOf = { ...state.projectOf, [created.id]: route[1] }
        return api(201, { ...created, name: body.name, username: `gitlab+deploy-token-${created.id}`, revoked: false, expired: false })
      }
      if (method === 'DELETE' && route[2]) {
        if (state.failDeletes > 0) {
          state.failDeletes -= 1
          return json(500, { message: '500 Internal Server Error' })
        }
        const index = state.deployTokens.findIndex((t) => t.id === Number(route[2]))
        if (index < 0) {
          return api(404, { message: '404 Not found' })
        }
        state.deployTokens.splice(index, 1)
        state.deleted.push(Number(route[2]))
        return { status: 204, headers: NO }
      }
    }

    // the npm registry, as npm calls it with a credential in hand: of a project (the route the
    // provider's credentials are for), of a group, and of the instance
    const registry = /^\/api\/v4\/projects\/(\d+)\/packages\/npm\/(.*)$/.exec(path)
    const wide = /^\/api\/v4\/(?:groups\/\d+\/-\/)?packages\/npm\/(.+)$/.exec(path)
    if (/^\/api\/v4\/projects\/\d+\/packages\/npm$/.test(path)) {
      // without its trailing slash the URL is a 401, whatever credential comes with it
      return unauthorized()
    }
    if (registry) {
      const [, project, rest] = registry
      const dist = /^-\/package\/(.+)\/dist-tags\/([^/]+)$/.exec(rest)
      const name = decodeURIComponent(dist ? dist[1] : rest)
      const who = principal(token, project)
      if (who.answer) {
        return who.answer
      }
      if (method === 'GET' && !dist) {
        const versions = state.packages[name]
        // a package the project does not hold, or a project that does not exist, is looked up at npmjs.com
        if (!versions || !PROJECTS.has(project)) {
          return { status: 302, headers: { ...NO, location: `https://registry.npmjs.org/${rest}`, 'content-type': 'text/plain' }, json: `You are being redirected to https://registry.npmjs.org/${rest}` }
        }
        return json(200, packument(name, versions), { ...NO, 'content-type': 'application/octet-stream' })
      }
      if (method === 'PUT') {
        if (!who.write) {
          return api(403, { message: '403 Forbidden' })
        }
        if (dist) {
          return { status: 204, headers: NO }
        }
        // a version published again is accepted
        const [version] = Object.keys((body && body.versions) || {})
        if (!(state.packages[name] || []).includes(version)) {
          state.packages[name] = [...(state.packages[name] || []), version]
        }
        return api(200, Object.fromEntries(PACKAGE_KEYS.map((key) => [key, null])))
      }
    }
    if (wide && method === 'GET') {
      const name = decodeURIComponent(wide[1])
      const who = principal(token, '42')
      if (who.answer) {
        return who.answer
      }
      const versions = state.packages[name]
      return versions ? api(200, packument(name, versions)) : { status: 302, headers: { ...NO, location: `https://registry.npmjs.org/${wide[1]}`, 'content-type': 'text/plain' }, json: `You are being redirected to https://registry.npmjs.org/${wide[1]}` }
    }
    return null
  }
}

module.exports = { createFake }
