// Every route the code registers must appear in docs/architecture.md.
//
// The endpoint table has already drifted twice: routes shipped and were never
// documented, and the doc listed future work that had been done for days. A table
// nobody checks is worse than no table, because it is believed.

import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const docs = read('docs/architecture.md')
const http = read('lib/http.js')
const index = read('index.js')

const found = new Set()

// Peer listener: literal path names in the request router.
for (const match of http.matchAll(/url\.pathname\s*===\s*['"]([^'"]+)['"]/g)) found.add(match[1].replace(/\/$/, ''))
// Same file uses startsWith for the /dav prefix.
for (const match of http.matchAll(/url\.pathname\.startsWith\(\s*['"]([^'"]+)['"]/g)) {
  found.add(match[1].replace(/\/$/, ''))
}

// Panel API: `route === '/name'` comparisons inside index.js. Only literals that
// look like paths count, so an unrelated `route === 'function'` cannot sneak in.
for (const match of index.matchAll(/route\s*===\s*['"](\/[^'"]*)['"]/g)) {
  found.add(`/api/peer-sync${match[1]}`.replace(/\/$/, ''))
}

const missing = [...found].filter((route) => !docs.includes(route)).sort()
assert.deepEqual(missing, [], `routes missing from docs/architecture.md: ${missing.join(', ')}`)

// The other direction: a doc table that promises routes the code does not have is
// just as misleading, so the documented /v1 and /api names must exist in code.
const documented = new Set()
// Table cells look like `POST /v1/apply`, so the method prefix is optional here.
for (const match of docs.matchAll(/`(?:[A-Z]+ )?(\/v1\/[a-z0-9/-]+|\/api\/peer-sync\/[a-z0-9/-]+|\/dav)`/g)) documented.add(match[1])
const phantom = [...documented]
  .filter((route) => {
    if (route === '/dav') return !http.includes('/dav')
    if (route.startsWith('/api/peer-sync/')) {
      const bare = route.slice('/api/peer-sync'.length)
      return !index.includes(`'${bare}'`)
    }
    return !http.includes(`"${route}"`) && !http.includes(`'${route}'`)
  })
  .sort()
assert.deepEqual(phantom, [], `documented routes the code does not serve: ${phantom.join(', ')}`)

// The README lists every test file; it drifted the moment a test was added and
// nobody updated the list, so the listing is checked instead of trusted.
const readme = read('README.md')
const testFiles = fs
  .readdirSync(new URL('../test/', import.meta.url))
  .filter((name) => name.endsWith('.mjs'))
  .sort()
const unlisted = testFiles.filter((name) => !readme.includes(`test/${name}`))
assert.deepEqual(unlisted, [], `tests missing from the README directory listing: ${unlisted.join(', ')}`)

console.log(`docs: ${found.size} routes documented, ${documented.size} documented routes exist, ${testFiles.length} tests listed`)
