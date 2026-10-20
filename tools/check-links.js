'use strict'

// Checks every relative link in the repository's tracked Markdown files: the
// target file exists, and an anchor, in the same file or another, names a
// heading there (GitHub's slug rules, headings inside code fences ignored).
//
//   node tools/check-links.js

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const files = execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(Boolean)

const withoutFences = text => text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')

const slugCache = new Map()
const slugsOf = file => {
  if (!slugCache.has(file)) {
    const slugs = new Set()
    const seen = new Map()
    for (const m of withoutFences(fs.readFileSync(path.join(root, file), 'utf8')).matchAll(/^#{1,6} (.+)$/gm)) {
      const base = m[1].trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-')
      const n = seen.get(base) || 0
      seen.set(base, n + 1)
      slugs.add(n ? `${base}-${n}` : base)
    }
    slugCache.set(file, slugs)
  }
  return slugCache.get(file)
}

// `](target)`, `](<target with spaces>)`, a plain target that holds balanced
// parentheses (two deep), and an optional "title" after it.
const LINK = /\]\((<[^<>\n]*>|(?:[^()\s<]|\((?:[^()\s]|\([^()\s]*\))*\))+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g
const decode = target => { try { return decodeURIComponent(target) } catch { return target } }

const broken = []
for (const file of files) {
  const text = withoutFences(fs.readFileSync(path.join(root, file), 'utf8'))
  for (const m of text.matchAll(LINK)) {
    const target = decode(m[1][0] === '<' ? m[1].slice(1, -1) : m[1])
    if (/^[a-z]+:/i.test(target)) {
      continue
    }
    const hash = target.indexOf('#')
    const rel = hash < 0 ? target : target.slice(0, hash)
    const anchor = hash < 0 ? undefined : target.slice(hash + 1)
    const resolved = rel ? path.posix.normalize(path.posix.join(path.posix.dirname(file), rel)) : file
    if (!fs.existsSync(path.join(root, resolved))) {
      broken.push(`${file}: ${target} (no such file)`)
      continue
    }
    if (anchor !== undefined && resolved.endsWith('.md') && !slugsOf(resolved).has(anchor)) {
      broken.push(`${file}: ${target} (no such heading in ${resolved})`)
    }
  }
}
if (broken.length) {
  console.log(broken.join('\n'))
  process.exitCode = 1
} else {
  console.log(`${files.length} files, all links resolve`)
}
