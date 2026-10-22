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
//   oauth.interval, deviceExpiresIn         the device grant's poll interval (0) and lifetime (300 s)
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
// released credential and what a person or an administrator would do beside the provider:
//
//   packages                                packages the project registry holds, name to versions
//                                           (the default: @acme/widgets 2.4.0)
//   jobToken                                the CI job token of a running job of project 42
//   access                                  more OAuth access tokens, token to { level }, level being the
//                                           member's role (40 Maintainer, 30 Developer)
//
// and the administrator's own token, `admin-pat`, which every API route here takes.

const json = (status, body, headers) => ({ status, json: body, ...(headers ? { headers } : {}) })

// the administrator's personal access token of a live run
const ADMIN = 'admin-pat'

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

  // the role of the member whose OAuth access token or personal access token this is; 0 for
  // a token GitLab does not know or has revoked
  const levelOf = (token) => {
    if (token === ADMIN) {
      return 50
    }
    if (!token || oauth.revoked.includes(token)) {
      return 0
    }
    if (token === oauth.accessToken) {
      return 40
    }
    return (state.access && state.access[token] && state.access[token].level) || 0
  }

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
        if (oauth.refreshStatus) {
          return json(oauth.refreshStatus, { error: 'temporarily_unavailable' })
        }
        // the old refresh token stops working with the first use
        return body.refresh_token === oauth.refreshToken && !oauth.revoked.includes(body.refresh_token) ? issue() : json(400, { error: 'invalid_grant' })
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
        // a server that has an interval asks for polls no sooner than it (RFC 8628)
        if (oauth.interval > 0 && !oauth.slowDown) {
          const tooSoon = oauth.lastPoll !== undefined && clock - oauth.lastPoll < oauth.interval * 1000
          oauth.lastPoll = clock
          if (tooSoon) {
            return json(400, { error: 'slow_down' })
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
        expires_in: oauth.deviceExpiresIn ?? 300,
        interval: oauth.interval ?? 0,
      })
    }
    if (method === 'POST' && path === '/oauth/revoke') {
      oauth.revoked.push(body.token)
      return json(200, {})
    }

    if (method === 'GET' && path === '/api/v4/user') {
      return levelOf(token) ? json(200, { id: 1, username: 'maint' }) : json(401, { message: '401 Unauthorized' })
    }

    const route = /^\/api\/v4\/projects\/(\d+)\/deploy_tokens(?:\/(\d+))?$/.exec(path)
    if (route) {
      const level = levelOf(token)
      if (!level) {
        return json(401, { message: '401 Unauthorized' })
      }
      if (level < 40) {
        return json(403, { message: '403 Forbidden' })
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
        state.projectOf = { ...state.projectOf, [created.id]: route[1] }
        return json(201, { ...created, name: body.name, username: `gitlab+deploy-token-${created.id}`, revoked: false, expired: false })
      }
      if (method === 'DELETE' && route[2]) {
        if (state.failDeletes > 0) {
          state.failDeletes -= 1
          return json(500, { message: '500 Internal Server Error' })
        }
        const index = state.deployTokens.findIndex((t) => t.id === Number(route[2]))
        if (index < 0) {
          return json(404, { message: '404 Not found' })
        }
        state.deployTokens.splice(index, 1)
        state.deleted.push(Number(route[2]))
        return { status: 204 }
      }
    }

    // the project's npm registry, as npm calls it with a credential in hand
    const registry = /^\/api\/v4\/projects\/(\d+)\/packages\/npm\/(.*)$/.exec(path)
    if (registry) {
      const [, project, rest] = registry
      const who = principal(token, project)
      const dist = /^-\/package\/(.+)\/dist-tags\/([^/]+)$/.exec(rest)
      const name = decodeURIComponent(dist ? dist[1] : rest)
      if (who === 'invalid') {
        return json(401, { message: '401 Unauthorized' })
      }
      if (who === 'none' || who === 'elsewhere') {
        return json(404, { message: '404 Project Not Found' })
      }
      if (method === 'GET' && !dist) {
        if (!who.read) {
          return json(403, { message: '403 Forbidden' })
        }
        const versions = state.packages[name]
        if (!versions) {
          return { status: 302, headers: { location: `https://registry.npmjs.org/${rest}` } }
        }
        return json(200, { name, versions: Object.fromEntries(versions.map((version) => [version, { name, version }])), 'dist-tags': { latest: versions[versions.length - 1] } })
      }
      if (method === 'PUT') {
        if (!who.write) {
          return json(403, { message: '403 Forbidden' })
        }
        if (dist) {
          return { status: 204 }
        }
        const [version] = Object.keys((body && body.versions) || {})
        if ((state.packages[name] || []).includes(version)) {
          return json(403, { message: '403 Forbidden - Package already exists' })
        }
        state.packages[name] = [...(state.packages[name] || []), version]
        return json(200, { status: 'success' })
      }
    }
    return null
  }

  // who a registry credential is, for the project in the URL: a record with what it may do,
  // or `none` (no credential), `invalid` (one GitLab does not know), `elsewhere` (a credential of another project)
  function principal(token, project) {
    if (!token) {
      return 'none'
    }
    if (token === ADMIN) {
      return { read: true, write: true }
    }
    if (token === state.jobToken) {
      return project === '42' ? { read: true, write: true } : 'elsewhere'
    }
    const deploy = state.deployTokens.find((candidate) => candidate.token === token)
    if (deploy) {
      return (state.projectOf || {})[deploy.id] === project || !(state.projectOf || {})[deploy.id] ? { read: deploy.scopes.includes('read_package_registry'), write: deploy.scopes.includes('write_package_registry') } : 'elsewhere'
    }
    return 'invalid'
  }
}

module.exports = { createFake }
