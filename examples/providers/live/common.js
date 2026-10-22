'use strict'
// What the live runs against a real server (verdaccio.js, gitlab.js) have in common: the
// argument reader, the deep map over a scenario, the normal form of an exchange and the
// comparison of two runs of it, and the report of the divergences with their allowlist.

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at < 0 ? fallback : process.argv[at + 1]
}

const deepMap = (value, fn) => {
  if (typeof value === 'string') {
    return fn(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepMap(item, fn))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepMap(item, fn)]))
  }
  return value
}

// What an exchange looks like once it no longer matters whether the fake or the
// real server had it: who sent it, the request with its credential named by role,
// and the answer reduced to what a client reads.
const mediaType = (value) => (value ? value.split(';')[0].trim().toLowerCase() : null)
const keysOf = (json) => (json && typeof json === 'object' ? (Array.isArray(json) ? '[]' : Object.keys(json).sort().join(',')) : json === null || json === undefined ? '' : typeof json)

const describe = (exchange) => `${exchange.src}: ${exchange.request}${exchange.auth ? ` with ${exchange.auth}` : ''}${exchange.body ? ` {${exchange.body}}` : ''}`
const ASPECTS = ['status', 'www-authenticate', 'npm-notice', 'vary', 'cache-control', 'content-type', 'keys']

// The divergences between the two runs of one scenario: [{ id, where, request, fake, real }]
const compare = (where, fake, real, aspects = ASPECTS) => {
  const found = []
  const length = Math.max(fake.length, real.length)
  for (let at = 0; at < length; at += 1) {
    const f = fake[at]
    const r = real[at]
    if (!f || !r) {
      found.push({ id: `sequence :: ${f ? describe(f) : 'nothing'} (fake) against ${r ? describe(r) : 'nothing'} (real)`, where, request: `call ${at + 1}`, fake: f ? describe(f) : 'no call', real: r ? describe(r) : 'no call' })
      break
    }
    if (describe(f) !== describe(r)) {
      found.push({ id: `sequence :: ${describe(f)} (fake) against ${describe(r)} (real)`, where, request: `call ${at + 1}`, fake: describe(f), real: describe(r) })
      break
    }
    for (const aspect of aspects) {
      if (f.answer[aspect] !== r.answer[aspect]) {
        found.push({
          id: `${f.request}${f.auth ? ` with ${f.auth}` : ''} :: ${aspect} fake=${JSON.stringify(f.answer[aspect])} real=${JSON.stringify(r.answer[aspect])}`,
          where,
          request: describe(f),
          aspect,
          fake: JSON.stringify(f.answer[aspect]),
          real: JSON.stringify(r.answer[aspect]),
        })
      }
    }
  }
  return found
}

const matches = (entry, version) => !entry.versions || entry.versions.includes(version.split('.')[0])

// Prints the divergences once each, the known ones with their reason, the new ones as
// entries for the allowlist, the stale entries; returns what the exit code depends on.
const report = ({ product, version, divergences, allow, only, allowFile }) => {
  const unique = new Map()
  for (const divergence of divergences) {
    const entry = unique.get(divergence.id) || { ...divergence, where: [] }
    entry.where.push(divergence.where)
    unique.set(divergence.id, entry)
  }
  const known = []
  const fresh = []
  for (const entry of unique.values()) {
    const listed = allow.find((candidate) => candidate.id === entry.id && matches(candidate, version))
    ;(listed ? known : fresh).push({ ...entry, reason: listed && listed.reason })
  }
  const unused = allow.filter((candidate) => matches(candidate, version) && !unique.has(candidate.id) && !only)
  const show = (entry) => console.log(`  ${entry.request}${entry.aspect ? ` :: ${entry.aspect}` : ''}\n    in: ${[...new Set(entry.where)].join(', ')}\n    fake: ${entry.fake}\n    real: ${entry.real}${entry.reason ? `\n    allowed: ${entry.reason}` : ''}`)
  console.log(`\ndivergences between the fake and ${product} ${version}: ${known.length} known, ${fresh.length} new`)
  known.forEach(show)
  fresh.forEach(show)
  if (fresh.length) {
    console.log(`\nnew divergences, as entries for ${allowFile} if they are to be allowed:`)
    for (const entry of fresh) {
      console.log(JSON.stringify({ id: entry.id, versions: [version.split('.')[0]], reason: '' }))
    }
  }
  for (const entry of unused) {
    console.log(`\nstale allowlist entry (no such divergence any more): ${entry.id}`)
  }
  return { fresh: fresh.length, unused: unused.length }
}

module.exports = { arg, deepMap, mediaType, keysOf, describe, ASPECTS, compare, matches, report }
