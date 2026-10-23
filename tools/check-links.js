'use strict'

// Checks every relative link in the repository's tracked Markdown files: the
// target file exists, and an anchor, in the same file or another, names a
// heading there (GitHub's slug rules, headings inside code fences ignored).
// Absolute links to this repository's main branch, as the pull request texts
// have them, are checked the same way against the working tree.
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

// A pull request text, which sits in a fenced block and is pasted somewhere
// else, links this repository by absolute address, to the main branch. Those
// links must resolve here too, anywhere in a document, fenced or not.
const OWN = /\]\(https:\/\/github\.com\/Filyus\/unofficial-npm-credential-provider-rfc\/blob\/main\/([^)\s#]+)(?:#([^)\s]*))?\)/g

const broken = []
const check = (file, target, resolved, anchor) => {
  if (!fs.existsSync(path.join(root, resolved))) {
    broken.push(`${file}: ${target} (no such file)`)
    return
  }
  if (anchor !== undefined && resolved.endsWith('.md') && !slugsOf(resolved).has(anchor)) {
    broken.push(`${file}: ${target} (no such heading in ${resolved})`)
  }
}
for (const file of files) {
  const whole = fs.readFileSync(path.join(root, file), 'utf8')
  for (const m of withoutFences(whole).matchAll(LINK)) {
    const target = decode(m[1][0] === '<' ? m[1].slice(1, -1) : m[1])
    if (/^[a-z]+:/i.test(target)) {
      continue
    }
    const hash = target.indexOf('#')
    const rel = hash < 0 ? target : target.slice(0, hash)
    const anchor = hash < 0 ? undefined : target.slice(hash + 1)
    check(file, target, rel ? path.posix.normalize(path.posix.join(path.posix.dirname(file), rel)) : file, anchor)
  }
  for (const m of whole.matchAll(OWN)) {
    check(file, m[0].slice(2, -1), decode(m[1]), m[2] === undefined ? undefined : decode(m[2]))
  }
}
if (broken.length) {
  console.log(broken.join('\n'))
  process.exitCode = 1
} else {
  console.log(`${files.length} files, all links resolve`)
}
