import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configPath, localDir } from './paths.js'
import { writeFileAtomic } from './atomic.js'

export const PROTOCOL_VERSION = 1
export const DEFAULT_PORT = 4399

function selfId() {
  const raw = (os.hostname() || 'dsh').toLowerCase()
  const slug = raw.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return slug || 'dsh'
}

export function newToken() {
  return crypto.randomBytes(24).toString('hex')
}

export function defaults() {
  return {
    version: PROTOCOL_VERSION,
    enabled: true,
    self: selfId(),
    token: newToken(),
    listen: { host: 'auto', port: DEFAULT_PORT },
    peers: [],
    autoPush: true,
    autoPull: true,
    pullIntervalMs: 15000,
    timeoutMs: 4000,
    sync: { patch: true, credentials: true, presets: true, bundles: false, projects: false, sessions: false },
    // Detection is the default: installing a bundle runs pnpm on this machine,
    // so the user opts in by setting sync.bundles=true and bundlesMode='install'.
    bundlesMode: 'detect',
    projectsRoot: path.join(os.homedir(), 'DSH', 'Projects'),
    projects: [],
    sessionsLimit: 10,
    /**
     * Entry keys (`permission`, `id:permission`, `insert:chat`) that stay local:
     * never sent as part of the patch and never taken from a peer.
     */
    syncDeny: [],
    /** Mount points to register as Workspaces; 
ealpath decides identity. */
    workspaces: [],
    /** Canonical paths whose Workspace records this machine should drop on startup. */
    workspacesRemove: [],
    /** Advertise this machine's session list and project list (paths/titles only). */
    share: { sessions: false, workspaces: false },
    /** Remote prompt admission: off | ask | allow. */
    remotePrompts: 'off',
    /** WebDAV over the peer channel: no OS account, the token is the password. */
    dav: { enabled: false, root: '', watchMount: '' },
    /**
     * The peer's project directories, made visible here through a local mount.
     *
     * `mounts` is a path translation, because the same folder has a different name
     * on each machine: `/Volumes/DATA` on the Mac is `Z:\` on Windows when that
     * share is mounted. Nothing is copied — the workspace opens the mounted path.
     */
    remoteWorkspaces: { register: false, mounts: [] },
    pairing: {
      enabled: true,
      // `auto` pairs the first peer that announces itself; after that a peer
      // must present `code` (or be configured by hand). `off` disables it.
      mode: 'auto',
      port: 4401,
      code: '',
      announceMs: 10000,
      trustFirstOnly: true,
    },
  }
}

function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function asInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

/**
 * How much this machine trusts one peer.
 *
 * Two states, not three: pairing is deliberately zero-click, so a peer this
 * machine agreed to talk to is trusted, and the only decision left is whether it
 * still is. A third "pending" state would have to be cleared in the GUI, which
 * is exactly the friction the direct-cable setup exists to avoid.
 */
export function trustOf(peer) {
  return peer && peer.trust === 'revoked' ? 'revoked' : 'explicit'
}

/**
 * Which peer a presented inbound token belongs to.
 *
 * Two credentials are accepted. The shared `token` is the old protocol and the
 * credential a WebDAV mount holds: whoever has it looks like everyone else, so
 * revocation cannot work on it. A per-peer `inbound` key names its holder, which
 * is what makes `revoked` lock one machine out while the other keeps working.
 */
export function identifyPeer(peers, selfToken, presented) {
  if (typeof presented !== 'string' || !presented) return null
  if (typeof selfToken === 'string' && selfToken && presented === selfToken) {
    return { kind: 'shared', name: null, trust: 'explicit' }
  }
  for (const peer of Array.isArray(peers) ? peers : []) {
    if (peer && typeof peer.inbound === 'string' && peer.inbound && peer.inbound === presented) {
      return { kind: 'peer', name: peer.name || null, trust: trustOf(peer) }
    }
  }
  return null
}

function normalizePeers(raw) {
  if (!Array.isArray(raw)) return []
  const peers = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const url = typeof entry.url === 'string' ? entry.url.trim().replace(/\/+$/, '') : ''
    if (!url) continue
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : url
    peers.push({
      id: typeof entry.id === 'string' && entry.id ? entry.id : undefined,
      name,
      url,
      token: typeof entry.token === 'string' && entry.token ? entry.token : undefined,
      // The key this machine issued to that peer: inbound traffic carrying it is
      // identified. Older pairings have none, and fall back to the shared token.
      inbound: typeof entry.inbound === 'string' && entry.inbound ? entry.inbound : undefined,
      // Absent in every config written before this field existed: those peers
      // were added by the user or by a pairing they made, so they stay trusted.
      trust: entry.trust === 'revoked' ? 'revoked' : 'explicit',
      // Visibility only: how the peer got here is the first thing to look at
      // when a machine shows up that nobody remembers pairing.
      pairedVia: ['code', 'first', 'manual', 'unknown'].includes(entry.pairedVia) ? entry.pairedVia : 'unknown',
    })
  }
  return peers
}

function normalizePathList(raw) {
  if (!Array.isArray(raw)) return []
  return raw.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim())
}

function normalizeShare(raw, fallback) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const base = fallback || { sessions: false, workspaces: false }
  return {
    sessions: asBool(source.sessions, base.sessions),
    workspaces: asBool(source.workspaces, base.workspaces),
  }
}

function normalizeWorkspaces(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string' || !entry.path.trim()) continue
    out.push({ path: entry.path.trim(), title: typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : undefined })
  }
  return out
}

/**
 * The mount translations that make a peer project visible here.
 *
 * Each entry says "that path on the peer is this path here", e.g.
 * `{ remote: "/Volumes/DATA", local: "Z:\\" }`. A malformed entry is dropped
 * rather than guessed at: registering the wrong directory as a workspace is worse
 * than registering none.
 */
function normalizeRemoteWorkspaces(raw, fallback) {
  const base = fallback || { register: false, mounts: [], include: [] }
  const source = raw && typeof raw === 'object' ? raw : {}
  const mounts = []
  for (const entry of Array.isArray(source.mounts) ? source.mounts : []) {
    if (!entry || typeof entry !== 'object') continue
    const remote = typeof entry.remote === 'string' ? entry.remote.trim() : ''
    const local = typeof entry.local === 'string' ? entry.local.trim() : ''
    if (!remote || !local) continue
    mounts.push({ remote: remote.replace(/\/+$/, ''), local })
  }
  // Peer-side paths named by hand. This is the reliable way to show a project that
  // has never had a session: most projects on a machine you rarely use have not.
  const include = []
  for (const entry of Array.isArray(source.include) ? source.include : []) {
    if (typeof entry === 'string' && entry.trim()) include.push(entry.trim().replace(/\/+$/, ''))
  }
  return { register: asBool(source.register, base.register), mounts, include }
}

function normalizeDav(raw, fallback) {  const source = raw && typeof raw === 'object' ? raw : {}
  const base = fallback || { enabled: false, root: '', watchMount: '' }
  return {
    enabled: asBool(source.enabled, base.enabled),
    root: typeof source.root === 'string' && source.root.trim() ? source.root.trim() : base.root,
    // The path where *this* machine mounts the peer's share, if it mounts one.
    // Probed and reported, never remounted: see SyncEngine#probeDavMount.
    watchMount: typeof source.watchMount === 'string' && source.watchMount.trim() ? source.watchMount.trim() : base.watchMount || '',
  }
}

const PAIRING_MODES = new Set(['auto', 'code', 'off'])

function normalizePairing(raw, fallback) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const base = fallback || { enabled: true, mode: 'auto', port: 4401, code: '', announceMs: 10000, trustFirstOnly: true }
  return {
    enabled: asBool(source.enabled, base.enabled),
    mode: PAIRING_MODES.has(source.mode) ? source.mode : base.mode,
    port: asInt(source.port, base.port, 1024, 65535),
    code: typeof source.code === 'string' ? source.code.trim() : base.code,
    announceMs: asInt(source.announceMs, base.announceMs, 2000, 300000),
    trustFirstOnly: asBool(source.trustFirstOnly, base.trustFirstOnly),
  }
}

function normalizeProjects(raw) {
  if (!Array.isArray(raw)) return []
  const names = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    // The name becomes part of a unit id (`proj:<name>:<relative path>`), so it
    // may not contain the separators of that grammar.
    const name = entry.trim().replace(/[:\\/]+/g, '-')
    if (!name || name === '.' || name === '..') continue
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/** Normalize whatever the user hand-edited into the shape the engine relies on. */
export function normalize(raw, base) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const fallback = base || defaults()
  const listen = source.listen && typeof source.listen === 'object' ? source.listen : {}
  const sync = source.sync && typeof source.sync === 'object' ? source.sync : {}
  return {
    version: PROTOCOL_VERSION,
    enabled: asBool(source.enabled, fallback.enabled),
    self: typeof source.self === 'string' && source.self.trim() ? source.self.trim() : fallback.self,
    token: typeof source.token === 'string' && source.token ? source.token : fallback.token,
    listen: {
      host: typeof listen.host === 'string' && listen.host.trim() ? listen.host.trim() : fallback.listen.host,
      port: asInt(listen.port, fallback.listen.port, 0, 65535),
    },
    peers: normalizePeers(source.peers),
    pairing: normalizePairing(source.pairing, fallback.pairing),
    autoPush: asBool(source.autoPush, fallback.autoPush),
    autoPull: asBool(source.autoPull, fallback.autoPull),
    pullIntervalMs: asInt(source.pullIntervalMs, fallback.pullIntervalMs, 3000, 3600000),
    timeoutMs: asInt(source.timeoutMs, fallback.timeoutMs, 500, 60000),
    sync: {
      patch: asBool(sync.patch, fallback.sync.patch),
      credentials: asBool(sync.credentials, fallback.sync.credentials),
      presets: asBool(sync.presets, fallback.sync.presets),
      bundles: asBool(sync.bundles, fallback.sync.bundles),
      projects: asBool(sync.projects, fallback.sync.projects),
      sessions: asBool(sync.sessions, fallback.sync.sessions),
    },
    bundlesMode: source.bundlesMode === 'install' ? 'install' : fallback.bundlesMode,
    sessionsLimit: asInt(source.sessionsLimit, fallback.sessionsLimit, 1, 200),
    projectsRoot:
      typeof source.projectsRoot === 'string' && source.projectsRoot.trim()
        ? source.projectsRoot.trim()
        : fallback.projectsRoot,
    projects: normalizeProjects(source.projects),
    dav: normalizeDav(source.dav, fallback.dav),
    workspaces: normalizeWorkspaces(source.workspaces),
    remoteWorkspaces: normalizeRemoteWorkspaces(source.remoteWorkspaces, fallback.remoteWorkspaces),
    workspacesRemove: normalizePathList(source.workspacesRemove),
    share: normalizeShare(source.share, fallback.share),
    remotePrompts: ['off', 'ask', 'allow'].includes(source.remotePrompts) ? source.remotePrompts : fallback.remotePrompts,
    syncDeny: Array.isArray(source.syncDeny)
      ? source.syncDeny.filter((entry) => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean)
      : fallback.syncDeny,
  }
}

/**
 * Load the machine-local config, creating it on first run. The file lives
 * outside the synced surface on purpose: identity, listen address and the
 * shared token differ per machine, and the profile patch that carries the
 * plugin row is itself synced.
 */
export function loadConfig() {
  fs.mkdirSync(localDir(), { recursive: true })
  const file = configPath()
  let text = null
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
  // Editors on Windows like to prepend a BOM; JSON.parse and hash comparison do not.
  if (text != null) text = text.replace(/^\uFEFF/, '')
  if (text == null) {
    const config = defaults()
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    return { config, created: true }
  }
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${error.message}`)
  }
  const config = normalize(parsed)
  return { config, created: false }
}

export async function saveConfig(config) {
  await writeFileAtomic(configPath(), `${JSON.stringify(normalize(config), null, 2)}\n`)
  try {
    await fs.promises.chmod(configPath(), 0o600)
  } catch {
    /* Windows ignores POSIX modes */
  }
  return normalize(config)
}

/** Render the pairing block a second machine needs to paste. */
export function pairingText(config) {
  return [
    `self  : ${config.self}`,
    `listen: ${config.listen.host}:${config.listen.port}`,
    `token : ${config.token}`,
    `config: ${path.relative(process.cwd(), configPath()) || configPath()}`,
  ].join('\n')
}
