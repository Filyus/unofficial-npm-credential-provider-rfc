'use strict'
// Runs real helpers whose names are as awkward as the file system lets them
// be, through the Phase 1a runner, on the platform this runs on.
//
//   node poc/helper-fuzz/names.js <npm-cli checkout>
//
// On Windows a .cmd or .bat helper goes through cmd.exe, which reads the
// command line itself: a name with & ^ ( ) ! , ; = ' or spaces must still be
// the one file that is run, and a name that smuggles in a second command
// (`a & mkdir CANARY & b`) must run nothing else. No name with `%` is tried:
// cmd.exe expands it even inside quotes, and the path of a helper is the
// user's own (poc/retired/cmd-path-characters.patch). Elsewhere the helper
// is executed directly with no shell, so a name with $ ` ; & | ' " * ? [ a
// newline or a leading dash is only a name. Each helper prints its own token;
// the result must be `Bearer <token>` or, for a name the file system would not
// take, nothing at all.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const runner = require(path.resolve(process.argv[2], 'lib', 'utils', 'token-helper.js'))

// the factory npm uses, with a stub config, for one helper: a fresh one for
// each call, so that nothing is cached
const getTokenHelperHeader = (helper, regKey, timeout) => runner(
  { flat: { tokenHelpers: { [regKey]: helper } }, get: () => undefined, credentialKeysFromCliOrEnv: () => [], tokenHelperProjectTransport: [] },
  {}, process.platform, { timeout, grace: 2000, drain: 250 })({ regKey })

const windows = process.platform === 'win32'
const NAMES = windows
  ? ['plain', 'with space', "single'quote", 'amp&ersand', 'caret^', 'paren(thesis)', 'bang!', 'comma,', 'semi;colon',
    'eq=eq', 'at@', 'plus+', 'brackets[x]{y}', 'tilde~', '#hash', 'ünï©ødé', '😀', 'two  spaces', ' leading',
    'a & mkdir CANARY & b', 'a && mkdir CANARY && b', "x' & mkdir CANARY & 'y", '(a) & (mkdir CANARY)', '^&', '&',
    'a ^& mkdir CANARY', 'a ) & mkdir CANARY & (b', '!x! & mkdir CANARY', 'a , mkdir CANARY']
  : ['plain', 'with space', "quote'single", 'quote"double', 'dollar$HOME', 'back`tick`', 'semi;colon', 'amp&ersand',
    'pipe|name', 'paren(thesis)', 'glob*?[x]', 'tab\there', 'new\nline', '-leading-dash', '~tilde', '#hash', '!bang',
    'ünï©ødé', '😀', 'back\\slash', '%percent', '=eq', 'two  spaces', ' leading', 'trailing ', '.hidden',
    'a; mkdir CANARY; b', 'a && mkdir CANARY && b', '$(mkdir CANARY)', '`mkdir CANARY`', "a' ; mkdir CANARY ; '", 'a\nmkdir CANARY\nb']
const EXTENSIONS = windows ? ['.cmd', '.bat'] : ['']

// the directory the helper is in has an awkward name too: its path is part of
// the command line
const DIRECTORIES = windows
  ? ['plain', 'dir with space', 'dir & mkdir CANARY & x', 'dir(paren)', "dir'quote"]
  : ['plain', 'dir with space', "dir ; mkdir CANARY ; '", 'dir\nnewline', 'dir$(mkdir CANARY)']

const content = (token) => (windows ? `@echo off\r\necho ${token}\r\n` : `#!/bin/sh\nprintf '%s' '${token}'\n`)

const canaries = (root) => fs.readdirSync(root, { recursive: true }).filter((entry) => path.basename(entry) === 'CANARY')

const main = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-names-'))
  const results = { ran: 0, skipped: 0 }
  const problems = []
  try {
    let count = 0
    for (const directory of DIRECTORIES) {
      for (const name of NAMES) {
        for (const extension of EXTENSIONS) {
          count += 1
          const token = `TOKEN-${count}-abcdefghijklmnop`
          const dir = path.join(root, directory)
          const helper = path.join(dir, name + extension)
          const label = JSON.stringify(path.relative(root, helper))
          try {
            fs.mkdirSync(dir, { recursive: true })
            fs.writeFileSync(helper, content(token), { mode: 0o755 })
            // a name the file system changed (trailing space, case) is not the name tried
            if (!fs.readdirSync(dir).includes(path.basename(helper))) {
              throw new Error('name not kept')
            }
          } catch {
            results.skipped += 1
            continue
          }
          try {
            const header = await getTokenHelperHeader(helper, `//names/${count}/`, 20000)
            if (header !== `Bearer ${token}`) {
              problems.push(`${label}: printed ${JSON.stringify(header)}`)
            } else {
              results.ran += 1
            }
          } catch (error) {
            problems.push(`${label}: ${error.message.replace(token, '<token>')}`)
          }
          const found = canaries(root)
          if (found.length) {
            problems.push(`${label}: INJECTION, a second command ran and made ${found.join(', ')}`)
            fs.rmSync(path.join(root, found[0]), { recursive: true, force: true })
          }
        }
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
  console.log(`${results.ran} helpers ran, ${results.skipped} names the file system would not take`)
  assert.equal(problems.length, 0, `\n${problems.join('\n')}`)
  assert.ok(results.ran > 20, 'too few names were tried to say anything')
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
