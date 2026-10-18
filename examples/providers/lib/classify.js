'use strict'
// Says whether the reference providers accept each request they are given,
// for the differential fuzzing in tests/fuzz_messages.py. Reads lines of
// `role<TAB>json`; for the role `request` it answers `ok` or `err` and the
// reason by the path a provider reads a line by (strict UTF-8, JSON, an
// object, the schema's rules), and for any other role `skip`.

const { readLines, parseRequest } = require('./protocol.js')

const main = async () => {
  for await (const line of readLines(process.stdin, Infinity)) {
    const bytes = line.bytes
    const tab = bytes.indexOf(0x09)
    const role = tab === -1 ? '' : bytes.subarray(0, tab).toString('latin1')
    if (role !== 'request') {
      process.stdout.write('skip\n')
      continue
    }
    const { answer } = parseRequest({ bytes: bytes.subarray(tab + 1) })
    process.stdout.write(answer ? `err\t${answer.Err.message}\n` : 'ok\n')
  }
}

main()
