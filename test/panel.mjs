// The settings panel is the one part of this plugin nothing else exercises: it
// only ever runs inside the GUI bundle, and this machine has no React to render
// it with (the GUI ships prebuilt inside the app archive). So the panel gets a
// stand-in React — the components use nothing but createElement, useState and
// useCallback — and the tree is walked by hand.
//
// What this catches: undefined variables, wrong prop names, style objects that
// cannot be built, a section that throws on a missing field. What it cannot
// catch: hooks ordering, event handlers, layout. Both are stated in the commit
// message rather than implied.

import assert from 'node:assert/strict'
import fs from 'node:fs'

const snapshot = {
  self: 'win',
  updatedAt: '2026-10-27T06:27:50.285Z',
  listen: '10.77.0.1:4400',
  units: { count: 11, ids: ['cred:CLINE_API_KEY', 'patch'] },
  pending: [],
  peers: [
    {
      name: 'mac-lan',
      url: 'http://10.77.0.2:4399',
      reachable: true,
      lastSyncAt: '2026-10-27T06:27:50.483Z',
      lastError: null,
      trust: 'explicit',
      pairedVia: 'first',
      sessions: { count: 10, at: '2026-10-27T06:27:50.498Z' },
    },
  ],
  bundles: { toInstall: ['dsh-pet'], needsManualInstall: [], stateDiff: [] },
  sessions: {
    peer: 'mac-lan',
    self: 'win',
    total: 2,
    truncated: false,
    peers: [{ name: 'mac-lan', advertised: 10, at: '2026-10-27T06:27:50.498Z' }],
    items: [
      { id: 'session-a', title: '问候', cwd: '/Volumes/DATA/ds', updatedAt: 1793078753859, size: 375539, archived: false, where: 'remote', peer: 'mac-lan', mirrored: true, advertised: true },
      { id: 'session-b', title: '', cwd: '/Volumes/DATA/ds', updatedAt: 1793074445038, size: 1690024, archived: true, where: 'remote', peer: 'mac-lan', mirrored: false, advertised: true },
    ],
  },
  dav: { watch: '/Volumes/dav', mounted: true, entries: 2, error: null, enabled: true },
  pairing: { mode: 'auto', port: 4401 },
  paths: { log: '~/.dsh/peer-sync/sync.log', config: '~/.dsh/peer-sync/config.json' },
}

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const { name: compiled } = { name: 'client.js' }

/** Render the panel with a stand-in React and return its visible text. */
function renderPanel(data, options = {}) {
  // Flipping every `false` state renders the expanded branches (composer, busy
  // labels) without the test knowing the hook order — that order changed twice
  // while this test was written, and pinning it made the test brittle without
  // making it stronger.
  const openState = Boolean(options.open)
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity) }
    },
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial
      return [openState && value === false ? true : value, () => {}]
    },
    useCallback(fn) {
      return fn
    },
    // Effects are skipped: the panel's effect fetches the snapshot, and this test
    // is about what renders, not about network timing.
    useEffect() {},
  }

  let definition = null
  const window = { __ModuleLoader__: { load: (value) => { definition = value } }, __DSH_PEER_SYNC__: data }
  const navigator = { language: 'zh-CN' }
  const factory = new Function('window', 'navigator', 'require', source)
  factory(window, navigator, (request) => {
    if (request === 'react') return React
    throw new Error(`unexpected require: ${request}`)
  })
  assert.ok(definition, `${compiled} registered itself with the module loader`)

  const entry = definition.factory((request) => {
    if (request === 'react') return React
    throw new Error(`unexpected require: ${request}`)
  })
  let component = null
  entry.apply({
    slots: {
      inject(_name, run) {
        run()
      },
      register(_meta, registered) {
        component = registered
      },
    },
  })
  assert.equal(typeof component, 'function', 'the panel registered a component')

  const texts = []
  const walk = (node) => {
    if (node === null || node === undefined || node === false || node === true) return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (typeof node === 'string' || typeof node === 'number') {
      texts.push(String(node))
      return
    }
    if (typeof node.type === 'function') {
      walk(node.type({ ...node.props, children: node.children }))
      return
    }
    // Placeholders and labels live in props, not children, and they are what a
    // user actually reads in an input.
    for (const key of ['placeholder', 'title', 'label']) {
      const value = node.props && node.props[key]
      if (typeof value === 'string' && value) texts.push(value)
    }
    walk(node.children)
  }
  walk(component())
  return { text: texts.join(' ') }
}

const collapsed = renderPanel(snapshot).text
assert.match(collapsed, /远程 · mac-lan/, 'each session row says which machine runs it')
assert.match(collapsed, /问候/, 'titles survive to the panel')
assert.match(collapsed, /已镜像/, 'a mirrored copy is labelled')
assert.match(collapsed, /已归档/, 'an archived session is labelled')
assert.match(collapsed, /在这里发一句/, 'the collapsed row offers the composer')
assert.match(collapsed, /撤销/, 'a trusted peer can be revoked')
assert.match(collapsed, /在对端新建会话/, 'the peer card offers to create a session there')
assert.match(collapsed, /共享挂载/, 'the mount section renders when a mount is watched')
assert.match(collapsed, /可读/, 'the mount verdict reaches the page')
assert.match(collapsed, /cross-machine|对端/, 'peers section renders')
assert.doesNotMatch(collapsed, /undefined|NaN|\[object Object\]/, 'no placeholder leaks into the page')

// Every false state flipped: the composer is open and the send button is busy.
const open = renderPanel(snapshot, { open: true }).text
assert.match(open, /要发给这个会话的话/, 'the composer opens')
assert.match(open, /对端消耗额度/, 'the composer explains who pays for the turn')
assert.match(open, /等待对端…/, 'a busy send says so instead of looking idle')

// A revoked peer offers the opposite action, and a stale mount is called stale.
const revoked = renderPanel({
  ...snapshot,
  peers: [{ ...snapshot.peers[0], trust: 'revoked', reachable: false, lastError: 'peer-revoked' }],
  dav: { watch: '/Volumes/dav', mounted: false, entries: 0, error: 'ENOENT', enabled: true },
}).text
assert.match(revoked, /已撤销/, 'a revoked peer is labelled')
assert.match(revoked, /恢复信任/, 'and offers the way back')
assert.match(revoked, /不可读/, 'an unreadable mount is reported')
assert.match(revoked, /ENOENT/, 'with the reason')

// No injected snapshot: the Desktop shell does not always render its HTML through
// the host's index tap, so this is the path a real user hit — it must explain
// itself and offer to read instead of telling people to reload.
const empty = renderPanel(null).text
assert.match(empty, /正在从本机读取状态|没拿到状态/, 'the empty state says it is reading, not that it gave up')
assert.match(empty, /读取中…|重新读取/, 'and offers the read action')
assert.doesNotMatch(empty, /没有注入状态/, 'no longer blames the host for a fixable case')

console.log('panel: 4 renders ok')
