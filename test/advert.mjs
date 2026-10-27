// The panel must not go blank because a cache file is missing or half-written.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hydrateAdverts } from '../lib/sync.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-sync-advert-'))
const write = (name, value) => {
  const dir = path.join(root, 'peers', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'advert.json'), typeof value === 'string' ? value : JSON.stringify(value))
}

write('good', { at: 1793000000000, items: [{ id: 'session-a', title: 'cached' }] })
write('empty', { at: 1793000000000, items: [] })
write('broken', '{ not json')
write('wrong-shape', { at: 1, items: 'nope' })

const peers = [{ name: 'good' }, { name: 'empty' }, { name: 'broken' }, { name: 'wrong-shape' }, { name: 'missing' }, null, {}]
const map = hydrateAdverts(root, peers)

assert.deepEqual([...map.keys()], ['good'], 'only a usable cache is hydrated')
assert.equal(map.get('good').items[0].id, 'session-a')
assert.equal(map.get('good').at, 1793000000000)
assert.equal(map.has('empty'), false, 'an empty advert is indistinguishable from none')
assert.equal(map.has('broken'), false, 'a corrupt file must not throw')
assert.equal(map.has('missing'), false)
assert.equal(hydrateAdverts(root, null).size, 0)
assert.equal(hydrateAdverts(path.join(root, 'nowhere'), peers).size, 0)

fs.rmSync(root, { recursive: true, force: true })
console.log('hydrateAdverts: ok')
