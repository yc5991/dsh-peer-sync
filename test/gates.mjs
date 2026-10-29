// The four rules that decided whether data crosses the link at all. Each case
// below is a bug that actually shipped: a session list advertised but not
// served, titles lost to a key prefix, a trusted peer that could not be
// un-trusted, a panel that hid the peer's sessions when nothing was mirrored.

import assert from 'node:assert/strict'
import { listMountProjects, mapLocalToRemote, mapRemotePath, mergeSessionList, placeOfSession, remoteSessionsAllowed, sessionsPublished, underAny } from '../lib/sync.js'
import { identifyPeer, trustOf } from '../lib/config.js'
import { titleFromSnapshot, titleOf } from '../lib/sessions.js'

// --- publishing sessions: either switch means the files may be served --------
assert.equal(sessionsPublished(null), false)
assert.equal(sessionsPublished({}), false)
assert.equal(sessionsPublished({ share: { sessions: false }, sync: { sessions: false } }), false)
assert.equal(sessionsPublished({ share: { sessions: true }, sync: { sessions: false } }), true)
assert.equal(sessionsPublished({ share: { sessions: false }, sync: { sessions: true } }), true)
assert.equal(sessionsPublished({ share: {}, sync: {} }), false)

// --- who may create a session here: the same switch as delivery --------------
assert.equal(remoteSessionsAllowed({ remotePrompts: 'allow' }), true)
assert.equal(remoteSessionsAllowed({ remotePrompts: 'off' }), false)
assert.equal(remoteSessionsAllowed({ remotePrompts: 'ask' }), false)
assert.equal(remoteSessionsAllowed(null), false)
assert.equal(remoteSessionsAllowed({}), false)

// --- trust: two states, and anything unrecognised stays trusted --------------
assert.equal(trustOf(null), 'explicit')
assert.equal(trustOf({}), 'explicit')
assert.equal(trustOf({ trust: 'explicit' }), 'explicit')
assert.equal(trustOf({ trust: 'revoked' }), 'revoked')
assert.equal(trustOf({ trust: 'something-else' }), 'explicit')

// --- who is calling: the shared token names nobody, a per-peer key does ------
const shared = 'shared-token'
const peers = [
  { name: 'mac-lan', inbound: 'key-for-mac', trust: 'explicit' },
  { name: 'old-laptop', inbound: 'key-for-old', trust: 'revoked' },
  { name: 'legacy', trust: 'explicit' },
]
assert.deepEqual(identifyPeer(peers, shared, shared), { kind: 'shared', name: null, trust: 'explicit' })
assert.deepEqual(identifyPeer(peers, shared, 'key-for-mac'), { kind: 'peer', name: 'mac-lan', trust: 'explicit' })
// the one case revocation exists for
assert.equal(identifyPeer(peers, shared, 'key-for-old').trust, 'revoked')
// a peer with no issued key can only ever look like "shared", never like itself
assert.equal(identifyPeer(peers, shared, undefined), null)
assert.equal(identifyPeer(peers, shared, 'nope'), null)
assert.equal(identifyPeer(peers, shared, ''), null)
assert.equal(identifyPeer(null, shared, shared).kind, 'shared')

// --- titles: the per-session file is the layout that exists ------------------
const modern = { version: 7, record: { identity: { cwd: '/Volumes/DATA/ds' }, rows: { title: { ver: 1, seq: 24, val: '自我介绍' } } } }
assert.equal(titleFromSnapshot(modern, 'abc'), '自我介绍')
// the older single-document layout still has to be readable
const legacy = { tables: { sessions: { abc: { rows: { title: { val: '旧结构' } } } } } }
assert.equal(titleFromSnapshot(legacy, 'abc'), '旧结构')
assert.equal(titleFromSnapshot(legacy, 'other'), '')
assert.equal(titleFromSnapshot({}, 'abc'), '')
assert.equal(titleFromSnapshot(null, 'abc'), '')
assert.equal(titleFromSnapshot({ record: { rows: { title: { val: '   ' } } } }, 'abc'), '')

// --- ids: `session-<uuid>` versus `<uuid>.json` ------------------------------
const titles = new Map([['02996e59-8bcd-49f2', '遍历并整理项目结构']])
assert.equal(titleOf(titles, 'session-02996e59-8bcd-49f2'), '遍历并整理项目结构')
assert.equal(titleOf(titles, '02996e59-8bcd-49f2'), '遍历并整理项目结构')
assert.equal(titleOf(new Map([['session-x', 'Y']]), 'x'), 'Y')
assert.equal(titleOf(titles, 'missing'), '')
assert.equal(titleOf(null, 'x'), '')

// --- panel rows: what the peer published, plus what this machine copied -----
const advertised = [{ id: 's1', title: 'A', cwd: '/a', updatedAt: 10, size: 5, archived: false }]
const mirrored = mergeSessionList(advertised, { s1: { title: 'A' } }, 'mac')
assert.equal(mirrored.length, 1)
assert.deepEqual(
  { where: mirrored[0].where, peer: mirrored[0].peer, mirrored: mirrored[0].mirrored, advertised: mirrored[0].advertised },
  { where: 'remote', peer: 'mac', mirrored: true, advertised: true },
)

// advertised but not copied: the common case, and it must still be listed
const publishedOnly = mergeSessionList(advertised, {}, 'mac')
assert.equal(publishedOnly.length, 1)
assert.equal(publishedOnly[0].mirrored, false)
assert.equal(publishedOnly[0].advertised, true)

// copied but no longer advertised: still real, still listed
const copyOnly = mergeSessionList([], { s2: { title: 'B', updatedAt: 99 } }, 'mac')
assert.equal(copyOnly.length, 1)
assert.equal(copyOnly[0].advertised, false)
assert.equal(copyOnly[0].mirrored, true)
assert.equal(copyOnly[0].title, 'B')

// newest first, and no duplicate row when both sides know the same id
const ordered = mergeSessionList([{ id: 'a', updatedAt: 1 }, { id: 'b', updatedAt: 5 }], { a: { updatedAt: 1 } }, 'p')
assert.deepEqual(ordered.map((row) => row.id), ['b', 'a'])

// junk in the advert must be skipped, not thrown on
assert.equal(mergeSessionList([{ title: 'no id' }, null], {}, 'p').length, 0)

// --- mapping a peer path onto this machine's mount ---------------------------
const mounts = [{ remote: '/Volumes/DATA', local: 'Z:\\' }]
assert.equal(mapRemotePath('/Volumes/DATA/ds', mounts), 'Z:\\ds')
assert.equal(mapRemotePath('/Volumes/DATA/Projects/demo', mounts), 'Z:\\Projects\\demo')
assert.equal(mapRemotePath('/Volumes/DATA', mounts), 'Z:\\')
// a sibling whose name merely starts the same must not match
assert.equal(mapRemotePath('/Volumes/DATA2/ds', mounts), null)
// a path outside every mount, or nothing at all
assert.equal(mapRemotePath('/Users/yicheng/ds', mounts), null)
assert.equal(mapRemotePath('', mounts), null)
assert.equal(mapRemotePath('/Volumes/DATA/ds', []), null)
// a trailing slash on the mount is normalised away by the config loader, but the
// mapper tolerates it too
assert.equal(mapRemotePath('/Volumes/DATA/ds', [{ remote: '/Volumes/DATA/', local: 'Z:\\' }]), 'Z:\\ds')

// --- where a session's files live -------------------------------------------
// A session's cwd arrives in two forms, and the decoded one loses a leading slash:
// the mapped drive and the stored UNC path must both read as "on the peer".
const placeMounts = [{ local: 'Z:\\' }]
assert.equal(placeOfSession('Z:\\ds', placeMounts), 'peer')
assert.equal(placeOfSession('z:/ds/sub', placeMounts), 'peer')
assert.equal(placeOfSession('C:\\Users\\user\\Documents', placeMounts), 'local')
assert.equal(underAny('/10.77.0.2/DATA/ds', ['\\\\10.77.0.2\\DATA\\ds']), true, 'decoded UNC matches the stored UNC')
assert.equal(underAny('\\\\10.77.0.2\\DATA\\ds\\bili-whale', ['\\\\10.77.0.2\\DATA\\ds']), true)
assert.equal(underAny('C:\\Users\\user\\ds', ['\\\\10.77.0.2\\DATA\\ds']), false)
assert.equal(underAny('/10.77.0.2/DATA/ds2', ['\\\\10.77.0.2\\DATA\\ds']), false, 'a sibling prefix is not inside')

// --- the inverse: a path here back to the peer's own path --------------------
// Needed to open the mounted project *there*, where the quota and permissions are.
const reverse = [{ remote: '/Volumes/DATA', local: 'Z:\\' }]
assert.equal(mapLocalToRemote('Z:\\ds', reverse), '/Volumes/DATA/ds')
assert.equal(mapLocalToRemote('Z:\\ds\\bili-whale', reverse), '/Volumes/DATA/ds/bili-whale')
assert.equal(mapLocalToRemote('Z:\\', reverse), '/Volumes/DATA')
assert.equal(mapLocalToRemote('C:\\Users\\user\\Documents', reverse), null)
assert.equal(mapLocalToRemote('', reverse), null)
// round trip: every mapped peer path comes back unchanged
assert.equal(mapLocalToRemote(mapRemotePath('/Volumes/DATA/ds', mounts), reverse), '/Volumes/DATA/ds')

// --- scanning a mount for projects -------------------------------------------
// "Show me all of them" means the mount's own directories, minus the ones that are
// clearly not projects.
const scanned = listMountProjects('Z:\\', [])
assert.ok(scanned.includes('ds'), 'a real project is found')
assert.ok(!scanned.includes('Library'), 'Library is skipped by default')
assert.ok(!scanned.includes('Download'), 'so is Download')
assert.deepEqual(listMountProjects('Z:\\nonexistent-mount', []), [], 'a missing mount yields nothing')

console.log('gates: ok')