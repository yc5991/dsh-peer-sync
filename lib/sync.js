import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import YAML from 'yaml'
import { createLog } from './log.js'
import { readJson } from './json.js'
import { identifyPeer, loadConfig, pairingText, PROTOCOL_VERSION, saveConfig, trustOf } from './config.js'
import { applyBundleSet, applyUnit, keepConflictCopy, readLocalUnitText } from './apply.js'
import { collectUnits, hashText, manifestOf, readBundleSet, unitFromId, MAX_UNIT_BYTES } from './units.js'
import { startServer, stopServer } from './http.js'
import { writeBytesAtomic, writeFileAtomic } from './atomic.js'
import { archivedSessionIds, listLocalSessions, readableCwd, readSessionFiles, sessionTitles, titleOf } from './sessions.js'
import { serviceOf } from './services.js'
import { startDiscovery } from './discovery.js'
import { denyKeys, mergePatch, patchContentHash, slotHashes, stripDenied } from './patch.js'
import { createWebdav } from './webdav.js'
import { dshHome, configPath, display, expandHome, localDir, logPath, patchPath, pickListenAddress, presetsDir, profileDir, projectDir, projectsRoot, statePath, statusPath } from './paths.js'

function emptyState() {
  return { units: {}, bases: {}, pending: {}, patchBase: {}, patchKeep: {}, lastSyncAt: 0 }
}

function readState() {
  try {
    const text = fs.readFileSync(statePath(), 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text)
    return {
      units: parsed && typeof parsed.units === 'object' && parsed.units ? parsed.units : {},
      bases: parsed && typeof parsed.bases === 'object' && parsed.bases ? parsed.bases : {},
      pending: parsed && typeof parsed.pending === 'object' && parsed.pending ? parsed.pending : {},
      patchBase: parsed && typeof parsed.patchBase === 'object' && parsed.patchBase ? parsed.patchBase : {},
      patchKeep: parsed && typeof parsed.patchKeep === 'object' && parsed.patchKeep ? parsed.patchKeep : {},
      lastSyncAt: Number(parsed && parsed.lastSyncAt) || 0,
    }
  } catch {
    return emptyState()
  }
}

/**
 * Package version of the running build, reported over HTTP.
 *
 * Two machines drift: one gets an update, the other keeps serving the old code,
 * and every protocol mismatch then looks like a bug in the new side. A version
 * in `/v1/hello` answers "which build is she on" without opening a shell.
 */
const BUILD = (() => {
  try {
    const text = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const version = JSON.parse(text).version
    return typeof version === 'string' && version ? version : 'unknown'
  } catch {
    return 'unknown'
  }
})()

/**
 * Whether another machine may create sessions here.
 *
 * Same switch as delivery on purpose: both mean "that machine may act on my
 * sessions", and a session created by a peer is the more invasive half of it.
 */
export function remoteSessionsAllowed(config) {
  return Boolean(config && config.remotePrompts === 'allow')
}
/**
 * Whether this machine publishes its sessions — the list in the handshake and
 * the raw files behind it.
 *
 * Two switches answer one question: `share.sessions` is the current spelling,
 * `sync.sessions` the older one that also turned on mirroring, and configs in
 * the wild have either. They used to be read in two different places, so a
 * machine could advertise ten sessions and then refuse to serve a single file.
 */
export function sessionsPublished(config) {
  if (!config) return false
  return Boolean((config.share && config.share.sessions) || (config.sync && config.sync.sessions))
}

/**
 * Load the per-peer session adverts cached on disk.
 *
 * Everything in this file is best effort: a missing or half-written cache means
 * "no advert yet", never a failed start. Kept pure and exported because the only
 * other way to test it is to restart the app and starve the panel first.
 */
export function hydrateAdverts(localRoot, peers) {
  const found = new Map()
  for (const peer of Array.isArray(peers) ? peers : []) {
    const name = peer && peer.name
    if (!name) continue
    const cached = readJson(path.join(localRoot, 'peers', name, 'advert.json'))
    if (cached && Array.isArray(cached.items) && cached.items.length > 0) {
      found.set(name, { at: Number(cached.at) || Date.now(), items: cached.items })
    }
  }
  return found
}

/**
 * The text a turn has produced so far, or null.
 *
 * An `assistant/message` is not an answer: a step that only calls tools carries
 * one with no text part, and treating its presence as "done" ended the wait after
 * one poll — while the turn went on to ask for an approval and kept running. The
 * newest message **with text** is the answer; a window of pure tool calls means
 * "not finished yet".
 */
export function replyFromWindow(records) {
  const items = Array.isArray(records) ? records : []
  const types = items.map((item) => (item && item.event ? String(item.event.type) : ''))
  const start = types.lastIndexOf('turn/start')
  const scope = start >= 0 ? items.slice(start) : items
  const answers = scope.filter((item) => item && item.event && item.event.type === 'assistant/message')
  for (let index = answers.length - 1; index >= 0; index -= 1) {
    const text = lastAssistantText({ session: { eventsSnapshot: [answers[index].event] } })
    if (text) return text
  }
  return null
}

/**
 * Everything one poll of a wait loop needs to decide, in one pure step.
 *
 * The loop's decisions used to be inline, and one of them was wrong for months:
 * seeing any `assistant/message` ended the wait, while the first step of every
 * tool-using turn has one with no text. Keeping the judgement in one function is
 * what makes that class of mistake testable without a live peer.
 */
export function promptWindow(records) {
  const items = Array.isArray(records) ? records : []
  const types = items.map((item) => (item && item.event ? String(item.event.type) : ''))
  return {
    reply: replyFromWindow(items),
    approval: openApproval(items),
    sawStart: types.includes('turn/start'),
    sawEnd: types.includes('turn/end'),
    replies: types.filter((type) => type === 'assistant/message').length,
  }
}

/**
 * Whether the observed window ends inside an unfinished turn.
 *
 * `turn/start` without a later `turn/end` is the only evidence that a delivered
 * prompt will queue instead of start, and it is also the shape of the window
 * while an approval is pending.
 */
export function turnOpen(records) {
  const types = []
  for (const item of records) {
    const event = item && item.event ? item.event : item
    if (event && typeof event.type === 'string') types.push(event.type)
  }
  return types.lastIndexOf('turn/start') > types.lastIndexOf('turn/end')
}

/**
 * Merge what a peer publishes with what this machine actually copied.
 *
 * Pure on purpose: the panel has to answer two separate questions per row —
 * which machine runs the session, and whether the copy here is good enough to
 * read offline — and neither should depend on a filesystem to test.
 */
export function mergeSessionList(advertised, mirrored, peerName) {
  const rows = []
  const seen = new Set()
  for (const entry of Array.isArray(advertised) ? advertised : []) {
    if (!entry || typeof entry.id !== 'string') continue
    seen.add(entry.id)
    rows.push({
      id: entry.id,
      title: typeof entry.title === 'string' ? entry.title : '',
      cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
      updatedAt: Number(entry.updatedAt) || 0,
      size: Number(entry.size) || 0,
      archived: Boolean(entry.archived),
      where: 'remote',
      peer: peerName || null,
      mirrored: Boolean(mirrored && mirrored[entry.id]),
      advertised: true,
    })
  }
  // Copies without an advert are still real: the peer stopped publishing, a
  // session was archived away, or this machine pulled before the advert existed.
  const index = mirrored && typeof mirrored === 'object' ? mirrored : {}
  for (const [id, value] of Object.entries(index)) {
    if (seen.has(id)) continue
    rows.push({
      id,
      title: value && typeof value.title === 'string' ? value.title : '',
      cwd: value && typeof value.cwd === 'string' ? value.cwd : '',
      updatedAt: Number(value && value.updatedAt) || 0,
      size: Number(value && value.size) || 0,
      archived: false,
      where: 'remote',
      peer: peerName || null,
      mirrored: true,
      advertised: false,
    })
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt)
  return rows
}

/** A fresh inbound key for one peer. */
function newPeerKey() {
  return crypto.randomBytes(24).toString('hex')
}

/** How many advertised peer sessions the status file and the panel keep. */
const SESSION_ADVERT_MAX = 40

/**
 * The approval that was asked for and never decided, inside one observed window.
 *
 * A turn blocked on an approval is indistinguishable from a turn that is still
 * thinking — no `assistant/message` in either case — but it never clears on its
 * own: the click has to happen on the machine that owns the session, and a
 * remote caller cannot produce it. Distinguishing the two turns "wait longer"
 * into "waiting is pointless", which is the only useful thing to say.
 */
export function openApproval(records) {
  const open = new Map()
  for (const item of records) {
    const event = item && item.event ? item.event : item
    if (!event || typeof event.type !== 'string') continue
    const data = event.data && typeof event.data === 'object' ? event.data : {}
    if (event.type === 'approval/asked') {
      const id = String(data.id ?? data.approvalId ?? event.seq ?? open.size)
      open.set(id, {
        id: typeof data.id === 'string' ? data.id : typeof data.approvalId === 'string' ? data.approvalId : null,
        tool: typeof data.toolName === 'string' ? data.toolName : typeof data.tool === 'string' ? data.tool : null,
        reason: typeof data.reason === 'string' ? data.reason : null,
        seq: Number(event.seq),
      })
      continue
    }
    // A decision closes the approval it names; a policy change or a cancel
    // settles whatever was still open, because nothing can stay pending under
    // a policy that no longer asks.
    if (event.type === 'approval/decided') {
      const id = String(data.id ?? data.approvalId ?? '')
      if (id && open.has(id)) open.delete(id)
      else if (!id && open.size > 0) open.delete(open.keys().next().value)
      continue
    }
    if (event.type === 'approval/policy' || event.type === 'approval/cancelled') open.clear()
  }
  const values = [...open.values()]
  return values.length > 0 ? values[values.length - 1] : null
}

/** Last assistant text in a live session memory snapshot, best effort. */
function lastAssistantText(agent) {
  try {
    const events = agent && agent.session && Array.isArray(agent.session.eventsSnapshot) ? agent.session.eventsSnapshot : []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (!event || event.type !== "assistant/message") continue
      const content =
        (event.message && event.message.content) ||
        (event.data && event.data.message && event.data.message.content) ||
        (event.data && event.data.content) ||
        event.content ||
        []
      const text = (Array.isArray(content) ? content : [])
        .filter((part) => part && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("")
      if (text.trim()) return text
    }
    return null
  } catch {
    return null
  }
}

function messageOf(error) {
  return error && error.message ? error.message : String(error)
}

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/**
 * Both sides of a conflict must reach the same verdict without talking again, so
 * the rule is a pure function of the two (hash, updatedAt) pairs: newest edit
 * wins, and an exact tie falls to the lexicographically smaller hash.
 */
function pickWinner(local, remote) {
  const localAt = Number(local.updatedAt) || 0
  const remoteAt = Number(remote.updatedAt) || 0
  if (localAt !== remoteAt) return localAt > remoteAt ? 'local' : 'remote'
  return String(local.hash) <= String(remote.hash) ? 'local' : 'remote'
}

function formatBytes(size) {
  const value = Number(size) || 0
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`
  return `${value} B`
}

/** The human-readable half of the session mirror. */
function renderSessionIndex(peerName, index) {
  const rows = Object.entries(index).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
  const lines = [
    `# ${peerName} 上的会话（只读镜像）`,
    '',
    `同步时间：${new Date().toISOString()}`,
    '',
  ]
  if (rows.length === 0) {
    lines.push('（对端还没有会话）')
    return `${lines.join('\n')}\n`
  }
  lines.push('| 更新时间 | 标题 | 目录 | 大小 | 原始日志 |')
  lines.push('|---|---|---|---|---|')
  for (const [id, record] of rows) {
    const when = record.updatedAt ? new Date(record.updatedAt).toISOString().replace('T', ' ').slice(0, 19) : '-'
    const title = (record.title || '(无标题)').replace(/\|/g, '\\|')
    const cwd = (record.cwd || '').replace(/\|/g, '\\|')
    const files = (record.files || []).map((name) => `[\`${name}\`](./${id}/${name})`).join('<br>') || '-'
    lines.push(`| ${when} | ${title} | ${cwd} | ${formatBytes(record.size)} | ${files} |`)
  }
  lines.push('')
  lines.push('> 原始日志是 harness 自己的压缩容器格式，这里只搬运不解析；要阅读内容请在对应机器上打开该会话。')
  return `${lines.join('\n')}\n`
}

export class SyncEngine {
  constructor(ctx) {
    this.ctx = ctx
    this.log = createLog('peer-sync')
    this.config = null
    this.state = emptyState()
    this.server = null
    this.timer = null
    this.watchers = []
    this.debounceTimer = null
    this.running = false
    this.again = false
    this.applying = false
    this.stopped = false
    this.peerHealth = new Map()
    this.discovery = null
    this.pairingInFlight = new Set()
    /** Local-only entry keys, unioned with every peer's list. */
    this.effectiveDeny = new Set()
    this.workspacesReady = new Set()
    this.workspacesFailed = new Set()
    /** Removals already attempted, so a refused one is reported once, not per tick. */
    this.workspacesRemoveTried = new Set()
    /**
     * What each peer last published about its sessions, kept even when this
     * machine mirrors nothing: which machine a session runs on is the one thing
     * the user cannot see from a list of ids.
     */
    this.peerSessions = new Map()
    /** Last mount probe result, so the panel can show a stale mount. */
    this.davHealth = null
    /** When this engine instance started, for the diagnose line. */
    this.startedAt = 0
    /** Stable identity for discovery: hostname + home cannot collide in practice. */
    this.nodeId = hashText(`${os.hostname()}|${dshHome()}`).slice(0, 12)
  }

  /** What is actually answering: build, file, process and how long it has run. */
  diagnose() {
    return {
      build: BUILD,
      loadedFrom: import.meta.url,
      pid: process.pid,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : null,
      node: process.version,
    }
  }

  async start() {
    this.startedAt = Date.now()
    fs.mkdirSync(localDir(), { recursive: true })
    const { config, created } = loadConfig()
    this.config = config
    this.state = readState()
    this.effectiveDeny = denyKeys(config.syncDeny)

    this.log.info(`self=${config.self} profile=${display(profileDir())} patch=${display(patchPath())}`)
    // Which file this code was loaded from, and which build it thinks it is.
    // Twice now the running module was newer than its reported version, and both
    // times the answer was a copy on a path nobody had looked at.
    this.log.info(`loaded from ${import.meta.url} build=${BUILD} pid=${process.pid}`)
    if (created) {
      this.log.info(`created ${display(localDir())}/config.json`)
      this.log.info(`pairing:\n${pairingText(config)}`)
    }

    if (config.remotePrompts === "ask") this.log.warn("remotePrompts=ask is not implemented yet; treating it as off")
    if (!config.enabled) {
      this.log.info('disabled by config.enabled=false')
      return
    }
    if (config.peers.length === 0) {
      this.log.warn('no peers configured; add the other machine to config.json -> peers')
    }

    // Hydrate the cached adverts before anything reads the panel: after a reload
    // the peer has not been asked yet, and an empty list looks like a broken
    // panel rather than a cache that has not been filled.
    for (const [name, entry] of hydrateAdverts(localDir(), config.peers)) this.peerSessions.set(name, entry)

    await this.ensureProjects()
    await this.ensureWorkspaces()
    await this.noteLocal()
    await this.listen()
    this.startDiscoveryNow()
    this.startWatches()
    this.timer = setInterval(() => {
      void this.tick('interval')
    }, config.pullIntervalMs)

    await this.tick('startup')
    this.log.info(
      this.server
        ? `ready: listening ${config.listen.host}:${config.listen.port}, peers=${config.peers.length}`
        : `ready: outbound only (port not bound), peers=${config.peers.length}`,
    )
    this.reportClientModule()
  }

  /** One diagnostic line: is the browser half in this process's client graph? */
  reportClientModule() {
    const modules = serviceOf(this.ctx, 'clientModules')
    if (!modules) {
      this.log.info('client modules: service unavailable')
      return
    }
    try {
      const path = typeof modules.clientPath === 'function' ? modules.clientPath('dsh-peer-sync') : undefined
      const graph = typeof modules.graph === 'function' ? modules.graph() : null
      const entries = graph && Array.isArray(graph.entries) ? graph.entries : []
      const mine = entries.find((entry) => entry && (entry.id === 'dsh-peer-sync' || String(entry.url || '').includes('peer-sync')))
      this.log.info(`client modules: path=${path || '-'} count=${entries.length} mine=${mine ? JSON.stringify(mine) : 'MISSING'}`)
    } catch (error) {
      this.log.warn(`client modules: ${messageOf(error)}`)
    }
  }

  /**
   * The WebDAV export shares the projects directory over the same authenticated
   * channel, so the other machine mounts it with an OS client and no account.
   */
  createDav() {
    const settings = this.config.dav || {}
    if (!settings.enabled) return null
    const root = settings.root ? expandHome(settings.root) : projectsRoot(this.config)
    try {
      fs.mkdirSync(root, { recursive: true })
    } catch (error) {
      this.log.warn(`dav: cannot create ${display(root)}: ${messageOf(error)}`)
      return null
    }
    this.log.info(`dav: serving ${display(root)} at /dav`)
    return createWebdav({ root, log: this.log })
  }

  async listen() {
    let { host, port } = this.config.listen
    if (host === 'auto' || host === 'localhost') {
      host = pickListenAddress(this.config.peers)
      this.config.listen.host = host
      this.log.info(`listen host auto-selected: ${host}`)
    }
    // On a profile reload the previous instance may still be closing its socket
    // for a few milliseconds; give the port a short window instead of failing.
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      try {
        this.server = await startServer({
          host,
          port,
          token: this.config.token,
          self: this.config.self,
          version: PROTOCOL_VERSION,
          build: BUILD,
          diagnose: () => this.diagnose(),
          log: this.log,
          snapshot: () => this.snapshot(),
          advertise: () => this.advertise(),
          readSession: (id) => this.readSession(id),
          find: (id) => this.find(id),
          status: () => this.status(),
          apply: (payload) => this.receive(payload),
          pair: (body, address) => this.pairRequest(body, address),
          webdav: this.createDav(),
          remotePrompt: (sessionId, text, wait, waitSeconds) => this.remotePrompt(sessionId, text, wait, waitSeconds),
          remoteSession: (body) => this.remoteSessionRequest(body),
          remoteCancel: (body) => this.remoteCancelRequest(body),
          remoteArchive: (body) => this.remoteArchiveRequest(body),
          remoteUnarchive: (body) => this.remoteUnarchiveRequest(body),
          remoteResult: (id) => this.remoteResultRequest(id),
          readSessionPage: (id, beforeSeq, max, through) => this.readSessionPage(id, beforeSeq, max, through),
          authorize: (presented) =>
            Boolean(identifyPeer(this.config.peers, this.config.token, presented)),
          peerTrust: (token) => this.trustOfToken(token),
        })
        this.log.info(`listening ${host}:${port}`)
        return
      } catch (error) {
        if (error && error.code === 'EADDRINUSE' && attempt < 12 && !this.stopped) {
          await new Promise((resolve) => setTimeout(resolve, 250))
          continue
        }
        this.log.error(`listen ${host}:${port} failed: ${messageOf(error)}`)
        this.server = null
        return
      }
    }
  }

  /** Announce on the LAN so the other machine can find us without an address. */
  startDiscoveryNow() {
    const pairing = this.config.pairing
    if (!pairing.enabled || pairing.mode === 'off') return
    const targets = []
    for (const peer of this.config.peers) {
      try {
        targets.push(new URL(peer.url).hostname)
      } catch {
        /* a malformed peer url is reported by the sync pass */
      }
    }
    try {
      this.discovery = startDiscovery({
        port: pairing.port,
        selfId: this.nodeId,
        selfName: this.config.self,
        platform: process.platform,
        httpPort: this.config.listen.port,
        tokenFingerprint: hashText(this.config.token).slice(0, 8),
        announceMs: pairing.announceMs,
        extraTargets: targets,
        onBeacon: (beacon) => this.handleBeacon(beacon),
        log: this.log,
      })
    } catch (error) {
      this.log.warn(`cannot start discovery: ${messageOf(error)}`)
    }
  }

  handleBeacon(beacon) {
    if (!this.config || this.stopped || !this.config.pairing.enabled) return
    const pairing = this.config.pairing
    if (pairing.mode === 'off') return
    const known = this.config.peers.find((peer) => (peer.id && peer.id === beacon.id) || peer.url.includes(beacon.address))
    if (known) return
    // Auto pairing is a first-contact convenience, not an open door: once this
    // machine has a peer, a new one must present the code.
    if (pairing.mode === 'auto' && pairing.trustFirstOnly && this.config.peers.length > 0 && !pairing.code) return
    if (this.pairingInFlight.has(beacon.id)) return
    this.pairingInFlight.add(beacon.id)
    void this.pairWith(beacon).finally(() => this.pairingInFlight.delete(beacon.id))
  }

  async pairWith(beacon) {
    const url = `http://${beacon.address}:${beacon.httpPort}`
    // The key this machine will accept from that peer. Issuing one per peer is
    // what makes a later revocation possible at all: with one shared token,
    // inbound traffic cannot be attributed to a machine.
    const grant = newPeerKey()
    const body = {
      id: this.nodeId,
      name: this.config.self,
      platform: process.platform,
      httpPort: this.config.listen.port,
      // Kept for a peer that still expects the old shared credential.
      token: this.config.token,
      grant,
      code: this.config.pairing.code || undefined,
    }
    let answer
    try {
      answer = await this.request(
        { url },
        '/v1/pair',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
        6000,
      )
    } catch (error) {
      this.log.warn(`pairing with ${beacon.name || beacon.id} failed: ${messageOf(error)}`)
      return
    }
    if (!answer || answer.ok !== true || !answer.peer || (!answer.peer.grant && !answer.peer.token)) {
      this.log.warn(`pairing with ${beacon.name || beacon.id} refused: ${answer ? answer.reason || 'unknown' : 'no-response'}`)
      return
    }
    await this.upsertPeer({
      id: answer.peer.id,
      name: answer.peer.name || beacon.name,
      url,
      // Prefer the key issued to this machine; `token` is the pre-v2 answer.
      token: answer.peer.grant || answer.peer.token,
      inbound: grant,
      pairedVia: this.config.pairing.code ? 'code' : 'first',
    })
    this.log.info(`paired (discovered): ${beacon.name || beacon.id} at ${url}${answer.peer.grant ? ' with a per-peer key' : ' (legacy shared token)'}`)
    void this.tick('pairing')
  }

  /** Inbound pairing request: decide whether to trust the caller and hand back our token. */
  async pairRequest(body, address) {
    const pairing = this.config.pairing
    if (!pairing.enabled || pairing.mode === 'off') return { ok: false, reason: 'pairing-disabled' }
    const id = typeof body.id === 'string' ? body.id : ''
    const token = typeof body.token === 'string' ? body.token : ''
    const httpPort = Number(body.httpPort)
    if (!id || !token || !Number.isFinite(httpPort) || httpPort <= 0) return { ok: false, reason: 'invalid' }

    const existing = this.config.peers.find((peer) => peer.id === id)
    const codeMatches = Boolean(pairing.code) && String(body.code || '') === pairing.code
    const callerHost = String(address || '').replace(/^::ffff:/, '')
    // A peer whose address this machine already lists is not an unknown device:
    // the user (or an earlier pairing) already decided to trust that address.
    const configuredAddress = this.config.peers.some((peer) => {
      try {
        return new URL(peer.url).hostname === callerHost
      } catch {
        return false
      }
    })

    let allowed
    if (existing) {
      // Same peer repeating the handshake (for example after a token rotation).
      allowed = existing.token === token || codeMatches
    } else if (configuredAddress) {
      allowed = true
    } else if (pairing.mode === 'code') {
      allowed = codeMatches
    } else {
      allowed = !pairing.trustFirstOnly || this.config.peers.length === 0 || codeMatches
    }
    if (!allowed) {
      this.log.warn(`refused pairing from ${body.name || id}${pairing.mode === 'code' ? ' (code mismatch)' : ''}`)
      return { ok: false, reason: pairing.mode === 'code' ? 'code-mismatch' : 'not-allowed' }
    }

    const url = `http://${callerHost}:${httpPort}`
    // The caller's own key, if it offered one: this is the credential this
    // machine will present when it calls back. A pre-v2 caller sends only its
    // shared token, which is also what the old protocol used in this direction.
    const answerGrant = newPeerKey()
    await this.upsertPeer({
      id,
      name: typeof body.name === 'string' && body.name ? body.name : id,
      url,
      token: typeof body.grant === 'string' && body.grant ? body.grant : token,
      inbound: answerGrant,
      pairedVia: codeMatches ? 'code' : 'first',
    })
    this.log.info(`paired (inbound): ${body.name || id} at ${url}${body.grant ? ' with a per-peer key' : ' (legacy shared token)'}`)
    return {
      ok: true,
      peer: {
        id: this.nodeId,
        name: this.config.self,
        // `grant` is the key this machine just issued for that peer.
        grant: answerGrant,
        // A caller that issued its own key does not need the shared token, and
        // the shared token is exactly what makes revocation unenforceable later.
        // A pre-v2 caller has nothing else to authenticate with, so it still gets
        // the old answer.
        ...(body.grant ? {} : { token: this.config.token }),
        httpPort: this.config.listen.port,
      },
    }
  }

  /** Add or refresh one peer, persisting the machine-local config. */
  async upsertPeer({ id, name, url, token, inbound, pairedVia }) {
    const host = hostOf(url)
    // The same machine must stay one entry even when its port changed (a fresh
    // install picks the default port, an older config may name another).
    const peer = this.config.peers.find(
      (entry) => (id && entry.id === id) || entry.url === url || (host && hostOf(entry.url) === host),
    )
    if (peer) {
      peer.id = id || peer.id
      peer.name = name || peer.name
      peer.url = url
      peer.token = token
      if (inbound) peer.inbound = inbound
      if (pairedVia) peer.pairedVia = pairedVia
    } else {
      this.config.peers.push({ id, name, url, token, inbound, trust: 'explicit', pairedVia: pairedVia || 'unknown' })
    }
    try {
      this.config = await saveConfig(this.config)
      this.log.info(`peer saved: ${name || id} -> ${url} (${this.config.peers.length} total)`)
    } catch (error) {
      this.log.warn(`cannot persist peer: ${messageOf(error)}`)
    }
  }

  /** Create every shared project folder and make sure the sidebar lists it. */
  async ensureProjects() {
    if (!this.config.sync.projects) return
    const names = Array.isArray(this.config.projects) ? this.config.projects : []
    if (names.length === 0) return
    const root = projectsRoot(this.config)
    try {
      fs.mkdirSync(root, { recursive: true })
    } catch (error) {
      this.log.warn(`cannot create ${display(root)}: ${messageOf(error)}`)
      return
    }
    for (const name of names) {
      const dir = projectDir(this.config, name)
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch (error) {
        this.log.warn(`cannot create project ${name}: ${messageOf(error)}`)
        continue
      }
      await this.registerWorkspace(dir, name)
    }
  }

  /**
   * The same project must be one Workspace entry on both machines. The two
   * machines keep it at their own absolute path, so identity is the folder this
   * machine resolved, never the peer's path.
   */
  async registerWorkspace(dir, name) {
    const registry = serviceOf(this.ctx, 'workspaceRegistry')
    if (!registry || typeof registry.create !== 'function') return
    try {
      const existing = typeof registry.list === 'function' ? registry.list() : []
      const resolved = path.resolve(dir)
      if (Array.isArray(existing) && existing.some((entry) => entry && typeof entry.path === 'string' && path.resolve(entry.path) === resolved)) {
        return
      }
      await registry.create(dir, name)
      this.log.info(`workspace ${name} registered at ${display(dir)}`)
    } catch (error) {
      this.log.warn(`cannot register workspace ${name}: ${messageOf(error)}`)
    }
  }

  startWatches() {
    const schedule = () => this.scheduleLocal()
    const watch = (target, accept, options) => {
      try {
        const watcher = fs.watch(target, { persistent: false, ...(options || {}) }, (_event, filename) => {
          if (!filename) {
            schedule()
            return
          }
          const name = String(filename)
          const base = name.split(/[\\/]/).pop() || name
          if (accept(base, name)) schedule()
        })
        watcher.on('error', (error) => this.log.warn(`watch ${display(target)}: ${messageOf(error)}`))
        this.watchers.push(watcher)
      } catch (error) {
        this.log.warn(`cannot watch ${display(target)}: ${messageOf(error)}`)
      }
    }

    if (this.config.sync.patch) {
      // The profile directory also receives package.json writes from installs.
      watch(profileDir(), (base) => base === 'cordis.patch.yml')
    }
    if (this.config.sync.credentials) {
      watch(dshHome(), (base) => base === '.credentials.yaml')
    }
    if (this.config.sync.presets) {
      // A machine that never created a preset has no directory to watch.
      try {
        fs.mkdirSync(presetsDir(), { recursive: true })
      } catch {
        /* reported by the watch call below */
      }
      watch(presetsDir(), () => true, { recursive: true })
    }
    if (this.config.sync.projects) {
      for (const name of this.config.projects) {
        watch(projectDir(this.config, name), () => true, { recursive: true })
      }
    }
  }

  scheduleLocal() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.onLocalChange()
    }, 700)
  }

  async onLocalChange() {
    if (this.stopped) return
    const { dirty } = await this.noteLocal()
    if (dirty.length === 0) return
    this.log.info(`local change: ${dirty.join(', ')}`)
    if (this.config.autoPush) await this.tick('local-change')
  }

  /** Refresh `state.units` from disk and report which units changed locally. */
  async noteLocal() {
    const units = await collectUnits(this.config, this.ctx, this.effectiveDeny)
    const current = new Map(units.map((unit) => [unit.id, unit]))
    const dirty = []
    for (const unit of units) {
      const previous = this.state.units[unit.id]
      if (!previous || previous.hash !== unit.hash) {
        this.state.units[unit.id] = { hash: unit.hash, updatedAt: unit.updatedAt }
        dirty.push(unit.id)
      }
    }
    for (const id of Object.keys(this.state.units)) {
      if (!current.has(id)) {
        delete this.state.units[id]
        delete this.state.pending[id]
        dirty.push(id)
      }
    }
    if (dirty.length > 0) this.saveState()
    return { units, dirty }
  }

  async snapshot() {
    const units = await collectUnits(this.config, this.ctx, this.effectiveDeny)
    return manifestOf(units)
  }

  /** Everything the handshake carries beyond the unit manifest. */
  async advertise() {
    if (!this.config) return {}
    // The deny list travels so both sides hash the same view of the patch.
    const payload = { bundles: null, sessions: null, deny: [...this.effectiveDeny] }
    if (this.config.sync.bundles) payload.bundles = await readBundleSet(this.ctx)
    // Two spellings exist in the wild (share.sessions was introduced later);
    // honour either so a peer config does not silently advertise nothing.
    if (sessionsPublished(this.config)) {
      const list = await listLocalSessions(this.config.sessionsLimit)
      const titles = await this.titlesFor(list.map((session) => session.id))
      const archived = archivedSessionIds()
      payload.sessions = list.map((session) => ({
        id: session.id,
        cwd: readableCwd(session.cwdKey),
        title: titleOf(titles, session.id),
        updatedAt: session.updatedAt,
        size: session.size,
        // Without these two the peer can only guess, and would happily prompt an
        // archived session or a non-session directory.
        archived: archived.has(session.id),
        kind: 'session',
      }))
    }
    return payload
  }

  /**
   * Titles for the sessions this machine publishes.
   *
   * `sessionQuery.readTitleSnapshots` is the authoritative source: it returns the
   * same folded title the GUI shows, whatever storage layout the installed
   * version uses. The file projection stays as a fallback for a harness that
   * does not expose the service, and for sessions the service has not observed.
   */
  async titlesFor(ids) {
    const titles = new Map()
    if (!Array.isArray(ids) || ids.length === 0) return titles
    const query = serviceOf(this.ctx, 'sessionQuery')
    if (query && typeof query.readTitleSnapshots === 'function') {
      const attempt = async (wanted) => {
        const found = new Map()
        const results = await query.readTitleSnapshots(wanted, new AbortController().signal)
        for (const item of Array.isArray(results) ? results : []) {
          if (!item || item.status === 'rejected' || !item.value) continue
          const id = typeof item.sessionId === 'string' ? item.sessionId : item.value.session && item.value.session.id
          const title = typeof item.value.title === 'string' ? item.value.title.trim() : ''
          if (id && title) found.set(id, title)
        }
        return found
      }
      try {
        let found = await attempt(ids)
        // The service may key sessions without the `session-` prefix; one retry
        // with the bare ids costs a call and saves every title.
        if (found.size === 0) {
          const bare = ids.map((id) => (id.startsWith('session-') ? id.slice('session-'.length) : id))
          const retried = await attempt(bare)
          for (const [id, title] of retried) found.set(id, title)
        }
        for (const [id, title] of found) titles.set(id, title)
      } catch (error) {
        if (!this.titlesWarned) {
          this.titlesWarned = true
          this.log.warn(`readTitleSnapshots failed, falling back to the projection file: ${messageOf(error)}`)
        }
      }
    }
    const fallback = sessionTitles()
    for (const id of ids) {
      if (titles.has(id)) continue
      const title = titleOf(fallback, id)
      if (title) titles.set(id, title)
    }
    return titles
  }

  async readSession(id) {
    // Same rule as the advert: what this machine published, it also serves.
    if (!sessionsPublished(this.config)) return null
    return readSessionFiles(id)
  }

  async find(id) {
    const units = await collectUnits(this.config, this.ctx, this.effectiveDeny)
    return units.find((unit) => unit.id === id) || null
  }

  baseFor(peerName, unitId) {
    const peer = this.state.bases[peerName]
    return peer ? peer[unitId] : undefined
  }

  setBase(peerName, unitId, hash) {
    const peer = this.state.bases[peerName] || (this.state.bases[peerName] = {})
    peer[unitId] = hash
  }

  setLocalHash(unitId, hash, updatedAt) {
    this.state.units[unitId] = { hash, updatedAt: Number(updatedAt) || Date.now() }
  }

  saveState() {
    try {
      const file = statePath()
      // Torn writes are worse than a stale write: replace the file in one step.
      const temp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`)
      fs.renameSync(temp, file)
    } catch (error) {
      this.log.warn(`cannot write state.json: ${messageOf(error)}`)
    }
  }

  /**
   * Register the configured mount points as Workspaces.
   *
   * `create` is idempotent by canonical path, so calling it on every start is
   * safe. A mount that is not there yet fails `realpath`, and is retried on the
   * next tick instead of breaking startup.
   */
  async ensureWorkspaces() {
    const registry = serviceOf(this.ctx, "workspaceRegistry")
    const remove = Array.isArray(this.config.workspacesRemove) ? this.config.workspacesRemove : []
    if (registry && Array.isArray(remove) && remove.length > 0 && typeof registry.list === "function") {
      const records = registry.list() || []
      for (const target of remove) {
        const wanted = path.resolve(expandHome(target))
        if (this.workspacesRemoveTried.has(wanted)) continue
        const match = records.find((record) => record && typeof record.path === "string" && path.resolve(record.path) === wanted)
        if (!match) continue
        // The record id is not guaranteed to be called `id` by every provider.
        const workspaceId = match.id ?? match.workspaceId ?? match.key
        this.workspacesRemoveTried.add(wanted)
        if (!workspaceId) {
          this.log.warn(`workspace ${match.path} has no usable id (keys: ${Object.keys(match).join(",")})`)
          continue
        }
        try {
          // delete() reports success, but the shell re-persists the workspace
          // state from memory a moment later and the entry returns. A second
          // listing is the only trustworthy evidence, so a removal this process
          // cannot confirm is never logged as one.
          const removed = typeof registry.delete === "function" ? await registry.delete(workspaceId) : false
          let stillListed = false
          try {
            const after = typeof registry.list === "function" ? registry.list() || [] : []
            stillListed = after.some(
              (record) => record && (record.id ?? record.workspaceId ?? record.key) === workspaceId,
            )
          } catch {
            stillListed = false
          }
          if (removed && !stillListed) this.log.info(`workspace removed: ${match.path}`)
          else if (removed && stillListed) {
            this.log.warn(
              `workspace delete not confirmed: ${display(wanted)} is still listed — remove it from the workspace list by hand`,
            )
          } else this.log.warn(`workspace delete refused: ${display(wanted)} (id ${workspaceId})`)
        } catch (error) {
          this.log.warn(`cannot remove workspace ${match.path}: ${messageOf(error)}`)
        }
      }
    }
    const entries = Array.isArray(this.config.workspaces) ? this.config.workspaces : []
    if (!registry || typeof registry.create !== "function" || entries.length === 0) return
    for (const entry of entries) {
      const target = expandHome(entry.path)
      try {
        await registry.create(target, entry.title)
        if (!this.workspacesReady.has(target)) {
          this.workspacesReady.add(target)
          this.log.info(`workspace registered: ${display(target)}`)
        }
      } catch (error) {
        if (!this.workspacesFailed.has(target)) {
          this.workspacesFailed.add(target)
          this.log.warn(`workspace ${display(target)} not registered yet: ${messageOf(error)}`)
        }
      }
    }
  }

  /**
   * Deliver one prompt into a session on this machine.
   *
   * The session runs here, with this machine model, directory and tool
   * permissions; the caller only receives the acceptance. `requestId` is the
   * idempotency key, so a retry of the same request cannot insert twice.
   */
  async remotePrompt(sessionId, text, wait, waitSeconds) {
    if (this.config.remotePrompts !== "allow") return { ok: false, reason: "remote-prompts-disabled" }
    if (typeof sessionId !== "string" || !sessionId) return { ok: false, reason: "missing-session" }
    if (typeof text !== "string" || !text.trim()) return { ok: false, reason: "empty-text" }
    const controller = serviceOf(this.ctx, "sessionController")
    if (!controller || typeof controller.prompt !== "function") return { ok: false, reason: "no-controller" }
    const requestId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10)
    const controllerSignal = new AbortController()
    const address = { kind: "session", sessionId }
    // An archived session still accepts prompts, but its owner has hidden it from
    // the sidebar — so the turn runs where nobody is looking. Saying so is the
    // difference between "she is ignoring me" and "she cannot see this".
    const archivedTarget = archivedSessionIds().has(sessionId)
    try {
      // A stream opened against a prepared source drains its backlog and closes,
      // so waiting on one stream misses the answer. Poll fresh tail snapshots
      // instead: every follow() opening carries records for the recent window.
      let baseCursor = -1
      let busyBefore = false
      if (wait && typeof controller.follow === "function") {
        try {
          const probe = controller.follow({ address, maxMessages: 20 }, controllerSignal.signal)[Symbol.asyncIterator]()
          const first = await probe.next()
          const frame = first && !first.done ? first.value : null
          if (frame && typeof frame.cursor === "number") baseCursor = frame.cursor
          // An unfinished turn already in the tail is what makes a delivered
          // prompt queue instead of start: worth reporting separately from the
          // agent simply being slow to answer the new one.
          const before = (frame && Array.isArray(frame.records) ? frame.records : [])
            .filter((record) => record && record.event)
          busyBefore = turnOpen(before)
          try { await probe.return() } catch { /* closed */ }
        } catch (error) {
          this.log.warn(`follow open failed: ${messageOf(error)}`)
        }
      }
      const request = { sessionId, requestId, content: [{ type: "text", text }] }
      const value = await controller.prompt(request, controllerSignal.signal)
      this.log.info(`remote prompt: session=${sessionId.slice(0, 8)} requestId=${requestId} bytes=${Buffer.byteLength(text, "utf8")}`)
      const accepted = Boolean(value && value.accepted)
      if (!wait) return { ok: true, requestId, accepted, replied: false, queued: false }
      if (typeof controller.follow !== "function") {
        return { ok: true, requestId, accepted, replied: false, queued: false, pending: true, reason: "follow-unavailable" }
      }
      const budget = Number(waitSeconds) > 0 ? Number(waitSeconds) : 300
      const deadline = Date.now() + budget * 1000
      const startedAt = Date.now()
      let reply = null
      let events = 0
      let kinds = []
      let approval = null
      let approvalPolls = 0
      let sawStart = false
      let endedPolls = 0
      let endedWithoutReply = false
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1200))
        let records = []
        try {
          const iterator = controller.follow({ address, maxMessages: 20 }, controllerSignal.signal)[Symbol.asyncIterator]()
          const first = await iterator.next()
          const frame = first && !first.done ? first.value : null
          // seq may sit on the record envelope rather than the event body.
          records = (frame && Array.isArray(frame.records) ? frame.records : [])
            .filter((record) => record && record.event)
            .map((record) => ({ event: record.event, seq: Number(record.event.seq ?? record.seq) }))
          try { await iterator.return() } catch { /* closed */ }
        } catch {
          continue
        }
        events = records.length
        for (const item of records) if (kinds.length < 12) kinds.push(String(item.event.type))
        // One pure judgement per poll: an answer, an approval, or neither.
        const window = promptWindow(records)
        sawStart = sawStart || window.sawStart
        if (window.reply) {
          reply = window.reply
          break
        }
        if (window.approval) {
          approval = window.approval
          approvalPolls += 1
          // One poll can race a decision that is already on its way; two
          // consecutive polls cannot. Nothing in this process can click the
          // dialog, so the rest of the budget would be spent for nothing.
          if (approvalPolls >= 2) break
        } else {
          approval = null
          approvalPolls = 0
        }
        // A turn that has ended will not produce text later. Two polls of margin,
        // then say so instead of sitting on the budget: a cancelled or empty turn
        // used to look like "still running" for the full waitSeconds.
        if (window.sawEnd) {
          endedPolls += 1
          if (endedPolls >= 2) {
            endedWithoutReply = true
            break
          }
        } else {
          endedPolls = 0
        }
      }
      controllerSignal.abort()

      // A reply is proof a turn ran. The window can start mid-turn, so absence
      // of `turn/start` only means "not observed", never "never started".
      const started = reply !== null || sawStart
      let reason = "replied"
      let hint = null
      if (reply === null) {
        if (approval) {
          reason = "awaiting-owner-approval"
          hint = "the owner has to approve on the machine that runs the session; a remote caller cannot clear it, so waiting longer does not help"
        } else if (endedWithoutReply) {
          reason = "turn-ended-without-reply"
          hint = "the turn finished without any text; it may have been cancelled, or it may have only called tools"
        } else if (!started && busyBefore) {
          reason = "agent-busy"
        } else if (!started) {
          reason = "not-started"
        } else {
          reason = "turn-in-progress"
        }
      }
      return {
        ok: true,
        requestId,
        accepted,
        replied: reply !== null,
        reply,
        // `queued` separates "the agent has not touched this message" from
        // "running, answer not finished yet" — an automation loop needs that.
        queued: !started,
        started,
        busyBefore,
        pending: reply === null,
        blocked: approval ? "awaiting-owner-approval" : null,
        approval,
        // Delivered into a hidden session: the turn happened, but nobody saw it.
        archivedTarget,
        ...(archivedTarget && reply === null ? { hint: `${hint || ""}${hint ? " · " : ""}that session is archived, so its owner may not notice this turn` } : {}),
        reason,
        hint,
        waited: budget,
        waitedMs: Date.now() - startedAt,
        baseCursor,
        events,
        kinds,
      }
    } catch (error) {
      const code = error && error.code ? error.code : "prompt-failed"
      this.log.warn(`remote prompt rejected: ${code}`)
      return { ok: false, reason: code, message: messageOf(error) }
    }
  }

  /**
   * Read the outcome of a session's current/last turn without sending anything.
   *
   * A wait budget is not a cancellation: when `remotePrompt` gives up because the
   * turn is still running, the answer still arrives later on that machine. This
   * lets the caller come back for it instead of losing it — the panel shows it as
   * "再取一次结果".
   */
  async remoteResultRequest(sessionId) {
    if (!remoteSessionsAllowed(this.config)) return { ok: false, reason: 'remote-prompts-disabled' }
    const controller = serviceOf(this.ctx, 'sessionController')
    if (!controller || typeof controller.follow !== 'function') return { ok: false, reason: 'no-follow' }
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, reason: 'missing-session' }
    const signal = new AbortController()
    try {
      const iterator = controller
        .follow({ address: { kind: 'session', sessionId }, maxMessages: 20 }, signal.signal)
        [Symbol.asyncIterator]()
      const first = await iterator.next()
      const frame = first && !first.done ? first.value : null
      try {
        await iterator.return()
      } catch {
        /* already closed */
      }
      const records = (frame && Array.isArray(frame.records) ? frame.records : [])
        .filter((record) => record && record.event)
        .map((record) => ({ event: record.event, seq: Number(record.event.seq ?? record.seq) }))
      const reply = replyFromWindow(records)
      const approval = openApproval(records)
      // The window's own answer is turn-scoped; the last thing the session said at
      // all is often what a person wants when peeking ("why is this done?").
      let lastText = null
      for (let index = records.length - 1; index >= 0 && lastText === null; index -= 1) {
        if (records[index].event.type !== 'assistant/message') continue
        lastText = lastAssistantText({ session: { eventsSnapshot: [records[index].event] } })
      }
      return {
        ok: true,
        sessionId,
        replied: reply !== null,
        reply,
        lastText,
        // Still producing: the caller should ask again rather than assume failure.
        running: turnOpen(records),
        blocked: approval ? 'awaiting-owner-approval' : null,
        approval,
        records: records.length,
        lastSeq: records.length > 0 ? records[records.length - 1].seq : null,
      }
    } catch (error) {
      return { ok: false, reason: 'read-failed', message: messageOf(error) }
    } finally {
      signal.abort()
    }
  }

  /** Outbound: ask the peer what its session's turn produced by now. */
  async remoteFetchResult(peerName, sessionId) {
    if (!this.config) return { ok: false, reason: 'not-started' }
    const peer = this.pickPeer(peerName)
    if (!peer) return { ok: false, reason: 'unknown-peer' }
    if (trustOf(peer) === 'revoked') return { ok: false, reason: 'peer-revoked' }
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, reason: 'missing-session' }
    try {
      const answer = await this.request(peer, `/v1/remote/result?sessionId=${encodeURIComponent(sessionId)}`)
      if (answer && answer.ok === false && answer.reason === 'not-found') {
        return { ...answer, hint: `${peer.name} 的版本没有 /v1/remote/result（需要 0.8.0 以上）` }
      }
      return answer || { ok: false, reason: 'no-response' }
    } catch (error) {
      return { ok: false, reason: 'request-failed', message: messageOf(error) }
    }
  }

  /**
   * Trust verdict for the caller behind a presented credential, or null for a
   * caller this machine cannot identify.
   *
   * The shared token identifies nobody — every holder looks the same — which is
   * why revocation needs the per-peer keys issued at pairing time.
   */
  trustOfToken(token) {
    if (!this.config) return null
    const who = identifyPeer(this.config.peers, this.config.token, token)
    return who ? who.trust : null
  }

  /**
   * Read a window of one session's events without activating anything.
   *
   * The shape was established by probing, not by guessing: `page` wants the
   * session address and a closed `throughSeq` (a negative value yields an empty
   * window rather than "everything"), and it answers with records whose `seq`
   * lives on the record envelope. The endpoint stays diagnostic — nothing in the
   * plugin calls it — so it returns raw records and lets the caller decide.
   */
  async readSessionPage(sessionId, beforeSeq, maxMessages, throughSeq) {
    const controller = serviceOf(this.ctx, "sessionController")
    if (!controller || typeof controller.page !== "function") return { ok: false, reason: "no-controller" }
    if (typeof sessionId !== "string" || !sessionId) return { ok: false, reason: "missing-session" }
    const through = Number(throughSeq) >= 0 ? Number(throughSeq) : -1
    const max = Number(maxMessages) > 0 ? Number(maxMessages) : 20
    const before = Number(beforeSeq) > 0 ? Number(beforeSeq) : undefined
    try {
      const page = await controller.page(
        { address: { kind: "session", sessionId }, throughSeq: through, maxMessages: max, beforeSeq: before },
        new AbortController().signal,
      )
      const records = (Array.isArray(page && page.records) ? page.records : []).map((record) => ({
        seq: Number(record && record.event ? record.event.seq : record && record.seq),
        type: record && record.event ? String(record.event.type) : null,
      }))
      return { ok: true, cursor: Number(page && page.cursor) || null, hasMore: Boolean(page && page.hasMore), records }
    } catch (error) {
      // The harness reports the real cursor in this message, which is the one
      // piece of information a caller with a stale seq needs.
      return { ok: false, reason: "page-failed", message: messageOf(error) }
    }
  }

  /**
   * Create a session on this machine.
   *
   * Delivering a message needs a session to deliver into, and until now creating
   * one required a human at the GUI. The request shape belongs to
   * `sessionController.create`, so the caller's payload is passed through and any
   * validation error is returned verbatim: the harness names the field it wanted,
   * which is more useful than a generic failure.
   */
  async createSession(request) {
    const controller = serviceOf(this.ctx, 'sessionController')
    if (!controller || typeof controller.create !== 'function') return { ok: false, reason: 'no-controller' }
    const wanted = request && typeof request === 'object' ? { ...request } : {}
    // `title` is not part of the create contract; it is applied afterwards through
    // rename, so a session made for a peer arrives labelled instead of as an
    // untitled blank in that machine's sidebar.
    const title = typeof wanted.title === 'string' && wanted.title.trim() ? wanted.title.trim() : null
    delete wanted.title
    try {
      const value = await controller.create(wanted)
      const id =
        (value && (value.sessionId || value.id)) ||
        (value && value.session && (value.session.id || value.session.sessionId)) ||
        (value && value.header && value.header.id) ||
        null
      const sessionId = typeof id === 'string' ? id : null
      let renamed = false
      let renameError = null
      if (title && sessionId && typeof controller.rename === 'function') {
        try {
          await controller.rename({ sessionId, title })
          renamed = true
        } catch (error) {
          renameError = messageOf(error)
        }
      }
      this.log.info(`session created: ${sessionId || 'unknown id'} ${JSON.stringify(wanted)}${title ? ` title=${JSON.stringify(title)}${renamed ? '' : ' (rename failed)'}` : ''}`)
      return {
        ok: true,
        sessionId,
        title: renamed ? title : null,
        renameError,
        keys: value && typeof value === 'object' ? Object.keys(value).slice(0, 12) : null,
        value: sessionId ? null : value,
      }
    } catch (error) {
      // Shape errors from the harness read like "cwd: Required"; keep them whole.
      return { ok: false, reason: 'create-failed', message: messageOf(error) }
    }
  }

  /**
   * Inbound: a peer asks this machine to create a session.
   *
   * Gated by the same `remotePrompts` switch as delivery, because both mean "another
   * machine may act on my sessions". The session is created here, in this machine's
   * default directory unless the caller names one, and its id is the whole answer —
   * the porcelain belongs to this machine's GUI.
   */
  async remoteSessionRequest(body) {
    if (!remoteSessionsAllowed(this.config)) return { ok: false, reason: 'remote-prompts-disabled' }
    const request = body && typeof body === 'object' ? body.request || body : {}
    const wanted = {}
    if (typeof request.cwd === 'string' && request.cwd.trim()) wanted.cwd = request.cwd.trim()
    if (typeof request.agentPreset === 'string' && request.agentPreset.trim()) wanted.agentPreset = request.agentPreset.trim()
    // Label it by whoever asked, so a session that appears out of nowhere in that
    // machine's sidebar says where it came from.
    const caller = body && typeof body.peer === 'string' && body.peer ? body.peer : null
    wanted.title = typeof request.title === 'string' && request.title.trim()
      ? request.title.trim()
      : caller
        ? `来自 ${caller} 的会话`
        : null
    if (!wanted.title) delete wanted.title
    const result = await this.createSession(wanted)
    if (!result.ok) return result
    return {
      ok: true,
      sessionId: result.sessionId,
      title: result.title,
      created: wanted,
      byPeer: caller,
    }
  }

  /**
   * Outbound: ask a peer to create a session, so a message can be delivered into it.
   *
   * Delivery needs a session to deliver into; without this the panel could only
   * work with sessions a human had already opened on the other machine.
   */
  async remoteCreateSession(peerName, request) {
    if (!this.config) return { ok: false, reason: 'not-started' }
    const peer = this.pickPeer(peerName)
    if (!peer) return { ok: false, reason: 'unknown-peer' }
    if (trustOf(peer) === 'revoked') return { ok: false, reason: 'peer-revoked' }
    try {
      const answer = await this.request(peer, '/v1/remote/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `peer` names the caller: the receiving side labels the new session
        // after whoever asked for it, which it cannot do without this.
        body: JSON.stringify({ request: request || {}, peer: this.config.self }),
      })
      if (answer && answer.ok) this.log.info(`session created on ${peer.name}: ${answer.sessionId || '?'}`)
      // A peer on an older build simply has no such route; say which one instead
      // of leaving a bare `not-found` in the panel.
      if (answer && answer.ok === false && answer.reason === 'not-found') {
        return { ...answer, hint: `${peer.name} 的版本没有 /v1/remote/session（需要 0.6.0 以上）` }
      }
      return answer || { ok: false, reason: 'no-response' }
    } catch (error) {
      return { ok: false, reason: 'request-failed', message: messageOf(error) }
    }
  }

  /**
   * Archive a session on this machine.
   *
   * Archiving (not deleting) is the only removal the host offers reliably — see
   * the workspacesRemove note — and it is what the GUI does when a session is
   * dismissed. Probe sessions created by drills and tests otherwise stay in the
   * sidebar forever.
   */
  async archiveSession(sessionId) {
    const registry = serviceOf(this.ctx, 'workspaceRegistry')
    if (!registry || typeof registry.archiveSession !== 'function') return { ok: false, reason: 'no-registry' }
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, reason: 'missing-session' }
    try {
      await registry.archiveSession(sessionId)
      const archived = archivedSessionIds()
      return { ok: true, sessionId, archived: archived.has(sessionId) }
    } catch (error) {
      return { ok: false, reason: 'archive-failed', message: messageOf(error) }
    }
  }

  /**
   * Undo an archive. Archiving is offered precisely because it is reversible; a
   * one-way action would need a confirmation dialog, and the panel has none.
   */
  async unarchiveSession(sessionId) {
    const registry = serviceOf(this.ctx, 'workspaceRegistry')
    if (!registry || typeof registry.unarchiveSession !== 'function') return { ok: false, reason: 'no-registry' }
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, reason: 'missing-session' }
    // The host silently ignores an unarchive for a session it does not know, so
    // asking first is the only way to tell "restored" from "there was nothing
    // there" — otherwise this reports success for a made-up id.
    if (!archivedSessionIds().has(sessionId)) {
      return { ok: false, reason: 'not-archived', message: 'that session is not archived, or does not exist' }
    }
    try {
      await registry.unarchiveSession(sessionId)
      return { ok: true, sessionId, archived: archivedSessionIds().has(sessionId) }
    } catch (error) {
      return { ok: false, reason: 'unarchive-failed', message: messageOf(error) }
    }
  }

  /**
   * Cancel the turn running in a session on this machine.
   *
   * This is the only way out of a turn that is stuck on an approval nobody will
   * click, or on a tool that will never finish: the wait budget can expire, but
   * the peer's turn keeps its session busy forever. Cancelling is what the GUI
   * does when the user hits stop, and it must be reachable from the other machine
   * because that is where the person who noticed the problem is.
   */
  async cancelSession(sessionId, reason) {
    const controller = serviceOf(this.ctx, 'sessionController')
    if (!controller || typeof controller.cancel !== 'function') return { ok: false, reason: 'no-controller' }
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, reason: 'missing-session' }
    const note = typeof reason === 'string' && reason ? reason : 'cancelled from the peer'
    try {
      // One shape only: the object form is the one the host accepts (a bare id is
      // read as `payload.sessionId`, i.e. undefined, and the resulting error says
      // "session undefined", which is worse than useless in a log).
      const value = await controller.cancel({ sessionId, reason: note })
      this.log.info(`session cancelled: ${sessionId.slice(0, 8)}`)
      return { ok: true, sessionId, value: value === undefined ? null : value }
    } catch (error) {
      const message = messageOf(error)
      // A session with no turn in flight is not attached to the live set; there is
      // nothing to stop, which is a normal outcome rather than a failure.
      if (/not attached/i.test(message)) {
        return { ok: false, reason: 'not-live', message, hint: 'that session has no running turn; nothing to cancel' }
      }
      this.log.warn(`cancel failed: ${sessionId.slice(0, 8)} ${message}`.slice(0, 300))
      return { ok: false, reason: 'cancel-failed', message }
    }
  }

  /** Inbound: a peer asks this machine to cancel a turn. Same admission as delivery. */
  async remoteCancelRequest(body) {
    if (!remoteSessionsAllowed(this.config)) return { ok: false, reason: 'remote-prompts-disabled' }
    const request = body && typeof body === 'object' ? body : {}
    return this.cancelSession(request.sessionId, typeof request.reason === 'string' ? request.reason : null)
  }

  /** Outbound: cancel a turn on the peer, from this machine's panel. */
  async remoteCancelSession(peerName, sessionId) {
    if (!this.config) return { ok: false, reason: 'not-started' }
    const peer = this.pickPeer(peerName)
    if (!peer) return { ok: false, reason: 'unknown-peer' }
    if (trustOf(peer) === 'revoked') return { ok: false, reason: 'peer-revoked' }
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, reason: 'missing-session' }
    try {
      const answer = await this.request(peer, '/v1/remote/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, reason: `cancelled from ${this.config.self}` }),
      })
      if (answer && answer.ok === false && answer.reason === 'not-found') {
        return { ...answer, hint: `${peer.name} 的版本没有 /v1/remote/cancel（需要 0.7.0 以上）` }
      }
      return answer || { ok: false, reason: 'no-response' }
    } catch (error) {
      return { ok: false, reason: 'request-failed', message: messageOf(error) }
    }
  }

  /** Inbound: archive one session here, on a peer's request. */
  async remoteArchiveRequest(body) {
    if (!remoteSessionsAllowed(this.config)) return { ok: false, reason: 'remote-prompts-disabled' }
    const request = body && typeof body === 'object' ? body : {}
    return this.archiveSession(request.sessionId)
  }

  /** Inbound: undo an archive here, on a peer's request. */
  async remoteUnarchiveRequest(body) {
    if (!remoteSessionsAllowed(this.config)) return { ok: false, reason: 'remote-prompts-disabled' }
    const request = body && typeof body === 'object' ? body : {}
    return this.unarchiveSession(request.sessionId)
  }

  /** Outbound: archive a session on the peer. Archiving is reversible; deleting is not offered. */
  async remoteArchiveSession(peerName, sessionId) {
    if (!this.config) return { ok: false, reason: 'not-started' }
    const peer = this.pickPeer(peerName)
    if (!peer) return { ok: false, reason: 'unknown-peer' }
    if (trustOf(peer) === 'revoked') return { ok: false, reason: 'peer-revoked' }
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, reason: 'missing-session' }
    try {
      const answer = await this.request(peer, '/v1/remote/session/archive', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      if (answer && answer.ok === false && answer.reason === 'not-found') {
        return { ...answer, hint: `${peer.name} 的版本没有 /v1/remote/session/archive（需要 0.7.0 以上）` }
      }
      return answer || { ok: false, reason: 'no-response' }
    } catch (error) {
      return { ok: false, reason: 'request-failed', message: messageOf(error) }
    }
  }

  /** Outbound: unarchive a session on the peer. */
  async remoteUnarchiveSession(peerName, sessionId) {
    if (!this.config) return { ok: false, reason: 'not-started' }
    const peer = this.pickPeer(peerName)
    if (!peer) return { ok: false, reason: 'unknown-peer' }
    if (trustOf(peer) === 'revoked') return { ok: false, reason: 'peer-revoked' }
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, reason: 'missing-session' }
    try {
      const answer = await this.request(peer, '/v1/remote/session/unarchive', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      if (answer && answer.ok === false && answer.reason === 'not-found') {
        return { ...answer, hint: `${peer.name} 的版本没有 /v1/remote/session/unarchive（需要 0.8.4 以上）` }
      }
      return answer || { ok: false, reason: 'no-response' }
    } catch (error) {
      return { ok: false, reason: 'request-failed', message: messageOf(error) }
    }
  }

  /** The peer a panel action refers to, by name, or the only peer there is. */
  pickPeer(name) {
    const peers = this.config ? this.config.peers : []
    if (!Array.isArray(peers) || peers.length === 0) return null
    if (typeof name === 'string' && name) return peers.find((peer) => peer.name === name) || null
    return peers.length === 1 ? peers[0] : null
  }

  /**
   * Deliver a prompt to a session on the peer, on behalf of the panel.
   *
   * The mirror image of `remotePrompt`: the session keeps running over there,
   * with that machine's model, directory and permissions; this side only carries
   * the request and the answer back. Nothing is mirrored, so a failure here
   * leaves the peer's session exactly as it was.
   */
  async promptPeer(peerName, sessionId, text, wait, waitSeconds) {
    if (!this.config) return { ok: false, reason: 'not-started' }
    const peer = this.pickPeer(peerName)
    if (!peer) return { ok: false, reason: 'unknown-peer' }
    if (trustOf(peer) === 'revoked') return { ok: false, reason: 'peer-revoked' }
    if (typeof sessionId !== 'string' || !sessionId) return { ok: false, reason: 'missing-session' }
    if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'empty-text' }
    const budget = Number(waitSeconds) > 0 ? Number(waitSeconds) : 120
    try {
      const answer = await this.request(
        peer,
        '/v1/remote/prompt',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, text, wait: Boolean(wait), waitSeconds: budget }),
        },
        // The peer waits inside its own budget, so the socket must outlast it.
        (budget + 20) * 1000,
      )
      this.log.info(
        `panel prompt -> ${peer.name}: session=${sessionId.slice(0, 8)} replied=${Boolean(answer && answer.replied)}` +
          (answer && answer.reason ? ` reason=${answer.reason}` : ''),
      )
      return answer || { ok: false, reason: 'no-response' }
    } catch (error) {
      const code = error && error.name === 'AbortError' ? 'timeout' : messageOf(error)
      this.log.warn(`panel prompt to ${peer.name} failed: ${code}`)
      return { ok: false, reason: 'request-failed', message: code }
    }
  }

  /**
   * Persist a trust change for one peer.
   *
   * Revoking has to survive a restart, so it goes through the same save path as
   * pairing; a config write failure is reported rather than swallowed, because
   * the caller just told the user "revoked".
   */
  async setPeerTrust(peerName, trust) {
    if (!this.config) return { ok: false, reason: 'not-started' }
    const peer = this.pickPeer(peerName)
    if (!peer) return { ok: false, reason: 'unknown-peer' }
    const next = trust === 'revoked' ? 'revoked' : 'explicit'
    if (trustOf(peer) === next) return { ok: true, peer: { name: peer.name, trust: next }, changed: false }
    const previous = trustOf(peer)
    peer.trust = next
    try {
      this.config = await saveConfig(this.config)
      this.log.info(`trust: ${peer.name} ${previous} -> ${next}`)
      await this.writeStatus().catch(() => null)
      return { ok: true, peer: { name: peer.name, trust: next }, changed: true }
    } catch (error) {
      peer.trust = previous
      return { ok: false, reason: 'save-failed', message: messageOf(error) }
    }
  }

  /**
   * The status object, built from live state rather than from the file.
   *
   * `writeStatus` persists it and the panel used to read only the file — which is
   * written on the 15-second tick, so a freshly restarted plugin showed an empty
   * panel for up to a tick, and a corrupt file kept it empty. Both readers now
   * share this builder, and the panel falls back to it when the file is missing.
   */
  statusObject() {
    if (!this.config) return null
    const peers = this.config.peers.map((peer) => {
      const health = this.peerHealth.get(peer.name) || {}
      const advertised = this.peerSessions.get(peer.name)
      return {
        name: peer.name,
        url: peer.url,
        reachable: Boolean(health.reachable),
        build: health.build || null,
        diag: health.diag || null,
        lastSyncAt: health.lastSyncAt ? new Date(health.lastSyncAt).toISOString() : null,
        lastError: health.lastError || null,
        // Survives a reload: the panel reads this file, and an advert that only
        // lives in memory disappears with the next profile recomposition.
        sessions: advertised
          ? {
              at: new Date(advertised.at).toISOString(),
              count: advertised.items.length,
              truncated: advertised.items.length >= SESSION_ADVERT_MAX,
              items: advertised.items,
            }
          : null,
      }
    })
    return {
      self: this.config.self,
      updatedAt: new Date().toISOString(),
      listen: `${this.config.listen.host}:${this.config.listen.port}`,
      units: Object.keys(this.state.units),
      pending: Object.keys(this.state.pending),
      peers,
      dav: this.davHealth
        ? { ...this.davHealth, at: new Date(this.davHealth.at).toISOString(), enabled: Boolean(this.config.dav.enabled) }
        : null,
      diag: this.diagnose(),
      log: display(`${localDir()}${path.sep}sync.log`),
    }
  }

  async writeStatus() {
    // A probe that blocks the loop is worse than a stale answer, so it runs on a
    // timer of its own instead of on every status write.
    if (!this.davHealth || Date.now() - this.davHealth.at > 30000) {
      await this.probeDavMount().catch(() => null)
    }
    const status = this.statusObject()
    if (!status) return null
    try {
      await writeFileAtomic(statusPath(), `${JSON.stringify(status, null, 2)}\n`)
    } catch (error) {
      this.log.warn(`cannot write status.json: ${messageOf(error)}`)
    }
    return status
  }

  /**
   * One cheap question about a mounted peer share: can this machine still list it?
   *
   * A wedged WebDAV mount raises nothing until something touches it, so the
   * failure mode is a project that quietly stops syncing while the sidebar still
   * shows it. The probe never writes into the share and never tries to remount:
   * remounting needs the OS credential dialog, and driving that from a plugin is
   * how the mount queue gets wedged in the first place.
   */
  async probeDavMount() {
    const dav = this.config && this.config.dav
    if (!dav || typeof dav.watchMount !== 'string' || !dav.watchMount) {
      // No watch configured: drop the previous verdict instead of leaving a
      // stale "unreadable" in the status file after the config changed.
      this.davHealth = null
      return null
    }
    const dir = expandHome(dav.watchMount)
    let timer = null
    try {
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('probe-timeout')), 1500)
      })
      let names
      try {
        names = await Promise.race([fs.promises.readdir(dir), timeout])
      } finally {
        if (timer) clearTimeout(timer)
      }
      const entries = Array.isArray(names) ? names.length : 0
      const previous = this.davHealth || {}
      this.davHealth = { at: Date.now(), watch: dir, mounted: true, entries, error: null }
      // Recovering is worth one line; so is a share that went from alive to gone.
      if (previous.mounted === false) this.log.info(`mount is readable again: ${dir} (${entries} entries)`)
      return this.davHealth
    } catch (error) {
      const code = error && error.code ? error.code : messageOf(error)
      const previous = this.davHealth || {}
      this.davHealth = { at: Date.now(), watch: dir, mounted: false, entries: 0, error: code }
      if (previous.mounted !== false) {
        this.log.warn(`mount ${dir} is not readable (${code}) — remount it from the app; the plugin will not remount`)
      }
      return this.davHealth
    }
  }

  async status() {
    return {
      self: this.config ? this.config.self : null,
      units: Object.keys(this.state.units),
      pending: Object.keys(this.state.pending),
      peers: this.config ? this.config.peers.map((peer) => ({ name: peer.name, url: peer.url })) : [],
    }
  }

  /**
   * The settings panel reads one injected snapshot. It is rebuilt on every index
   * request, so a page reload shows current state without the Client needing a
   * transport of its own.
   */
  pageSnapshot() {
    try {
      // The file is a cache of live state, not the source of it: on a fresh start
      // it is up to one tick old (or absent), so fall back to what the engine
      // already knows instead of showing an empty panel.
      const status = readJson(statusPath()) || this.statusObject()
      if (!status) return null
      const wanted = readJson(path.join(localDir(), 'bundles.wanted.json')) || {}
      const peersStatus = Array.isArray(status.peers) ? status.peers : []
      const peerName = peersStatus[0] ? peersStatus[0].name : null
      // One row list across all peers: the question a row answers is "which
      // machine runs this session", which only works if every peer is present.
      const rows = []
      for (const peerStatus of peersStatus) {
        const name = peerStatus && peerStatus.name
        if (!name) continue
        const index = readJson(path.join(localDir(), 'peers', name, 'sessions', 'index.json')) || {}
        const advertised = peerStatus.sessions && Array.isArray(peerStatus.sessions.items) ? peerStatus.sessions.items : []
        rows.push(...mergeSessionList(advertised, index, name))
      }
      const items = rows.slice(0, SESSION_ADVERT_MAX)
      return {
        ...status,
        units: { count: Array.isArray(status.units) ? status.units.length : 0, ids: status.units || [] },
        bundles: {
          toInstall: wanted.toInstall || [],
          needsManualInstall: wanted.needsManualInstall || [],
          stateDiff: wanted.stateDiff || [],
        },
        sessions: {
          peer: peerName,
          self: this.config ? this.config.self : null,
          items,
          total: rows.length,
          truncated: rows.length > items.length,
          peers: peersStatus.map((peerStatus) => ({
            name: peerStatus && peerStatus.name ? peerStatus.name : null,
            advertised: peerStatus && peerStatus.sessions ? peerStatus.sessions.count : 0,
            at: peerStatus && peerStatus.sessions ? peerStatus.sessions.at : null,
          })),
        },
        pairing: {
          mode: this.config && this.config.pairing ? this.config.pairing.mode : null,
          port: this.config && this.config.pairing ? this.config.pairing.port : null,
        },
        paths: { log: display(logPath()), config: display(configPath()) },
      }
    } catch {
      return null
    }
  }

  /** Append the snapshot to the served page so the settings tab can render it. */
  injectSnapshot(html) {
    if (typeof html !== 'string' || !html.includes('</body>')) return html
    const payload = this.pageSnapshot()
    if (!payload) return html
    const json = JSON.stringify(payload).replace(/</g, '\\u003c')
    return html.replace('</body>', `<script>window.__DSH_PEER_SYNC__=${json};</script></body>`)
  }

  async request(peer, pathname, init, timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || this.config.timeoutMs)
    try {
      const response = await fetch(`${peer.url}${pathname}`, {
        ...(init || {}),
        signal: controller.signal,
        headers: {
          'x-peer-token': peer.token || this.config.token,
          'x-peer-name': this.config.self,
          ...((init && init.headers) || {}),
        },
      })
      const text = await response.text()
      let payload
      try {
        payload = text ? JSON.parse(text) : null
      } catch {
        payload = { ok: false, reason: 'bad-json' }
      }
      if (!payload || typeof payload !== 'object') payload = { ok: false, reason: `http-${response.status}` }
      if (!response.ok && payload.ok !== false) payload = { ...payload, ok: false, reason: `http-${response.status}` }
      return payload
    } finally {
      clearTimeout(timer)
    }
  }

  async tick(reason) {
    if (this.stopped || !this.config) return
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    try {
      for (const peer of this.config.peers) {
        // A revoked peer is not contacted at all: revoking is the one act that
        // has to work even while the other machine is unreachable.
        if (trustOf(peer) === 'revoked') continue
        let hello
        try {
          hello = await this.request(peer, '/v1/hello')
          if (!hello || hello.ok !== true) throw new Error(hello ? hello.reason || 'bad-hello' : 'no-response')
          // The peer's build travels with every handshake; keeping it is what
          // turns "which version is she on" from a round of questions into a
          // badge in the panel.
          this.peerHealth.set(peer.name, {
            reachable: true,
            lastError: null,
            lastSyncAt: Date.now(),
            build: typeof hello.build === 'string' ? hello.build : null,
            // The peer's own load fingerprint: pid and uptime say whether it
            // really restarted, which `build` alone cannot.
            diag: hello.diag && typeof hello.diag === 'object' ? hello.diag : null,
          })
          this.applyPeerDeny(hello)
        } catch (error) {
          const previous = this.peerHealth.get(peer.name) || {}
          const repeated = previous.reachable === false && previous.lastError === messageOf(error)
          this.peerHealth.set(peer.name, {
            reachable: false,
            lastError: messageOf(error),
            lastSyncAt: previous.lastSyncAt || 0,
            // Keep the last build we saw: an unreachable peer still has a version,
            // and hiding it makes a version mismatch look like a crash.
            build: previous.build || null,
          })
          if (!repeated) this.log.warn(`peer ${peer.name} unreachable (${reason}): ${messageOf(error)}`)
          continue
        }

        if (this.config.autoPull) {
          try {
            await this.pullPeer(peer, hello)
          } catch (error) {
            this.log.warn(`pull from ${peer.name} failed: ${messageOf(error)}`)
          }
        }
        if (this.config.autoPush) {
          try {
            await this.pushPeer(peer, hello)
          } catch (error) {
            this.log.warn(`push to ${peer.name} failed: ${messageOf(error)}`)
          }
        }
      }
      await this.ensureWorkspaces()
      this.state.lastSyncAt = Date.now()
      this.saveState()
      await this.writeStatus()
    } finally {
      this.running = false
      if (this.again) {
        this.again = false
        void this.tick('queued')
      }
    }
  }

  /**
   * Both machines must hash the same view of the patch, so a deny list is a
   * union: whatever either side wants local-only is excluded on both sides.
   */
  applyPeerDeny(hello) {
    const union = denyKeys([...(this.config.syncDeny || []), ...(Array.isArray(hello.deny) ? hello.deny : [])])
    const same =
      union.size === this.effectiveDeny.size && [...union].every((key) => this.effectiveDeny.has(key))
    if (same) return
    this.effectiveDeny = union
    this.log.info(`sync deny: ${[...union].sort().join(', ') || '(none)'}`)
  }

  async pullPeer(peer, hello) {
    const remoteUnits = Array.isArray(hello.units) ? hello.units : []
    const remote = new Map(remoteUnits.map((unit) => [unit.id, unit]))
    const { units } = await this.noteLocal()
    let changed = false

    for (const here of units) {
      const there = remote.get(here.id)
      const base = this.baseFor(peer.name, here.id)
      if (!there) continue
      if (here.hash === there.hash) {
        if (base !== here.hash) this.setBase(peer.name, here.id, here.hash)
        // Seed the per-entry baseline even when nothing had to be merged, so the
        // first real divergence is judged slot by slot instead of as a conflict.
        if (here.id === 'patch' && !this.state.patchBase[peer.name]) {
          this.state.patchBase[peer.name] = slotHashes(here.text)
          this.saveState()
        }
        continue
      }
      // The patch is merged entry by entry, never replaced wholesale.
      if (here.id === 'patch') {
        await this.pullUnit(peer, there, 'merge')
        changed = true
        continue
      }
      if (base === here.hash) {
        await this.pullUnit(peer, there, 'fast-forward')
        changed = true
        continue
      }
      if (base === there.hash) continue

      const winner = pickWinner(here, there)
      if (winner === 'remote') {
        await this.pullUnit(peer, there, base == null ? 'first contact' : 'conflict: newer side wins', true)
        changed = true
        continue
      }
      // Local wins: keep our bytes, remember that this unit still needs to go out.
      const copy = await this.saveRemoteCopy(peer, there).catch(() => null)
      this.state.pending[here.id] = true
      this.log.info(
        `${here.id}: keeping local version${copy ? `, ${peer.name} version saved as ${display(copy)}` : ''}`,
      )
    }

    // Units only the peer has: create them here.
    const localIds = new Set(units.map((unit) => unit.id))
    for (const there of remoteUnits) {
      if (localIds.has(there.id)) continue
      await this.pullUnit(peer, there, 'new')
      changed = true
    }

    if (changed || Object.keys(this.state.pending).length > 0) this.saveState()

    if (this.config.sync.bundles && Array.isArray(hello.bundles)) {
      await applyBundleSet(this.ctx, hello.bundles, this.log, this.config)
    }
    if (Array.isArray(hello.sessions)) {
      // Remember the advert even when this machine mirrors nothing: mirroring is
      // an opt-in extra copy, while knowing which machine a session runs on is
      // what the settings list is for.
      const items = hello.sessions
        .filter((entry) => entry && typeof entry.id === 'string')
        .slice(0, SESSION_ADVERT_MAX)
      this.peerSessions.set(peer.name, { at: Date.now(), items })
      // Persist it: this cache is what the panel shows after a restart, and a
      // memory-only copy meant an empty list until the first tick after a reload.
      const file = path.join(localDir(), 'peers', peer.name, 'advert.json')
      writeFileAtomic(file, `${JSON.stringify({ at: Date.now(), items })}\n`).catch((error) => {
        this.log.warn(`cannot cache ${peer.name}'s session advert: ${messageOf(error)}`)
      })
      if (this.config.sync.sessions) {
        await this.mirrorSessions(peer, hello.sessions).catch((error) => {
          this.log.warn(`session mirror from ${peer.name} failed: ${messageOf(error)}`)
        })
      }
    }
  }

  /**
   * A session log cannot be merged or edited across machines, and its container
   * is the harness's own, so the peer copy is a read-only mirror: metadata in an
   * index plus the raw files, byte for byte.
   */
  async mirrorSessions(peer, list) {
    const root = path.join(localDir(), 'peers', peer.name, 'sessions')
    fs.mkdirSync(root, { recursive: true })
    const indexFile = path.join(root, 'index.json')
    let previous = {}
    try {
      previous = JSON.parse(fs.readFileSync(indexFile, 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      previous = {}
    }

    const index = {}
    let fetched = 0
    let changed = false

    for (const entry of list) {
      if (!entry || typeof entry.id !== 'string') continue
      const known = previous[entry.id] || {}
      const record = {
        title: typeof entry.title === 'string' ? entry.title : '',
        cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
        updatedAt: Number(entry.updatedAt) || 0,
        size: Number(entry.size) || 0,
        files: Array.isArray(known.files) ? known.files : [],
      }
      index[entry.id] = record

      const fresh = known.updatedAt === record.updatedAt && known.size === record.size
      if (fresh || fetched >= 8) continue

      const answer = await this.request(
        peer,
        `/v1/session?id=${encodeURIComponent(entry.id)}`,
        undefined,
        Math.max(this.config.timeoutMs, 30000),
      )
      if (!answer || answer.ok !== true || !Array.isArray(answer.files)) continue

      const dir = path.join(root, entry.id)
      fs.mkdirSync(dir, { recursive: true })
      const written = []
      for (const file of answer.files) {
        if (!file || typeof file.name !== 'string' || typeof file.data !== 'string') continue
        if (!/^session\.[^\\/]+\.jsonl\.zstd$/i.test(file.name)) continue
        await writeBytesAtomic(path.join(dir, file.name), Buffer.from(file.data, 'base64'))
        written.push(file.name)
      }
      record.files = written
      fetched += 1
      changed = true
      this.log.info(`session mirrored: ${peer.name}/${entry.id.slice(0, 8)} (${written.length} file(s))`)
    }

    if (Object.keys(index).length === 0 && Object.keys(previous).length === 0) return
    await writeFileAtomic(indexFile, `${JSON.stringify(index, null, 2)}\n`)
    await writeFileAtomic(path.join(root, 'index.md'), renderSessionIndex(peer.name, index))
    if (changed) this.log.info(`session mirror from ${peer.name}: ${Object.keys(index).length} session(s)`)
  }

  async pullUnit(peer, remote, label, backup) {
    const answer = await this.request(peer, `/v1/unit?id=${encodeURIComponent(remote.id)}`)
    if (!answer || answer.ok !== true || typeof answer.text !== 'string') {
      throw new Error(`${remote.id}: ${answer ? answer.reason || 'unavailable' : 'no-response'}`)
    }
    const descriptor = unitFromId(remote.id)
    if (!descriptor) throw new Error(`${remote.id}: unknown unit`)

    let text = answer.text
    let merged = null
    if (descriptor.kind === 'patch') {
      const current = (await readLocalUnitText(descriptor, this.config)) ?? ''
      merged = mergePatch({
        localText: current,
        remoteText: answer.text,
        base: this.state.patchBase[peer.name],
        keepKeys: this.state.patchKeep[peer.name],
        deny: this.effectiveDeny,
        localMtime: this.patchMtime(),
        remoteMtime: remote.updatedAt,
      })
      if (merged.rejected) throw new Error(`${remote.id}: ${merged.rejected.reason}`)
      text = merged.text
    } else if (hashText(answer.text) !== remote.hash) {
      throw new Error(`${remote.id}: hash does not match the manifest`)
    }

    // A version this machine is about to lose is never dropped silently.
    if (backup) {
      const previous = await readLocalUnitText(descriptor, this.config)
      if (previous != null && hashText(previous) !== hashText(text)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        await keepConflictCopy(descriptor, previous, `${this.config.self}-${stamp}`, this.config).catch(() => null)
      }
    }

    if (descriptor.kind === 'patch') {
      if (merged.changed) {
        await applyUnit(this.ctx, { ...descriptor, text, encoding: remote.encoding }, this.log, this.config)
      }
      const hash = this.notePatchMerged(peer.name, text, merged)
      if (merged.lost && merged.lost.length > 0) {
        await this.savePatchConflict(peer.name, merged.lost)
      }
      this.log.info(
        `merge: patch <- ${peer.name}${merged.changed ? '' : ' (no change)'}${merged.conflicts.length ? ` (conflicts: ${merged.conflicts.join(', ')})` : ''}`,
      )
      return hash
    }

    await applyUnit(this.ctx, { ...descriptor, text, encoding: remote.encoding }, this.log, this.config)
    this.setLocalHash(remote.id, remote.hash, Date.now())
    this.setBase(peer.name, remote.id, remote.hash)
    delete this.state.pending[remote.id]
    this.log.info(`${label}: ${remote.id} <- ${peer.name}`)
    return remote.hash
  }

  patchMtime() {
    try {
      return fs.statSync(patchPath()).mtimeMs
    } catch {
      return 0
    }
  }

  /** Entries that lost a same-slot conflict, kept beside the patch for review. */
  async savePatchConflict(peerName, lost) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = `${patchPath()}.conflict-${peerName}-${stamp}`
    const body = lost.map((item) => `# ${item.key} (from ${peerName}, not applied)\n${YAML.stringify(item.value)}\n`).join('')
    try {
      await writeFileAtomic(file, body)
      this.log.warn(`patch conflict: ${lost.map((item) => item.key).join(', ')} — saved to ${display(file)}`)
    } catch (error) {
      this.log.warn(`cannot save the losing patch entries: ${messageOf(error)}`)
    }
  }

  /**
   * Record the merged patch as this machine's current content and remember the
   * per-entry snapshot, plus any slot this side won and still has to publish.
   */
  notePatchMerged(peerName, text, merged) {
    const wire = stripDenied(text, this.effectiveDeny)
    const hash = patchContentHash(wire)
    this.setLocalHash('patch', hash, Date.now())
    this.setBase(peerName, 'patch', hash)
    this.state.patchBase[peerName] = slotHashes(wire)
    const keep = new Set(this.state.patchKeep[peerName] || [])
    for (const key of (merged && merged.won) || []) keep.add(key)
    this.state.patchKeep[peerName] = [...keep]
    delete this.state.pending.patch
    this.saveState()
    return hash
  }

  async saveRemoteCopy(peer, remote) {
    if (remote.kind === 'cred') return null
    const answer = await this.request(peer, `/v1/unit?id=${encodeURIComponent(remote.id)}`)
    if (!answer || answer.ok !== true || typeof answer.text !== 'string') return null
    const descriptor = unitFromId(remote.id)
    if (!descriptor) return null
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    return keepConflictCopy(descriptor, answer.text, `${peer.name}-${stamp}`, this.config)
  }

  async pushPeer(peer, hello) {
    const remoteUnits = Array.isArray(hello.units) ? hello.units : []
    const remote = new Map(remoteUnits.map((unit) => [unit.id, unit]))
    const { units } = await this.noteLocal()

    for (const unit of units) {
      const there = remote.get(unit.id)
      const base = this.baseFor(peer.name, unit.id)
      const pending = this.state.pending[unit.id] === true

      if (there && there.hash === unit.hash) {
        this.setBase(peer.name, unit.id, unit.hash)
        delete this.state.pending[unit.id]
        continue
      }

      let shouldSend
      if (unit.id === 'patch') {
        // Content identity is the only question for the patch: if the peer's
        // entry set differs from ours, send ours and let it merge.
        shouldSend = !there || there.hash !== unit.hash
      } else if (!there) shouldSend = true
      else if (pending) shouldSend = true
      else if (base === unit.hash) shouldSend = false
      else if (base === there.hash) shouldSend = true
      else shouldSend = false // diverged: the pull pass settles it by edit time

      if (!shouldSend) continue

      const payload = {
        from: this.config.self,
        base: base == null ? null : base,
        unit: {
          id: unit.id,
          kind: unit.kind,
          name: unit.name,
          rel: unit.rel,
          project: unit.project,
          encoding: unit.encoding,
          hash: unit.hash,
          updatedAt: unit.updatedAt,
          text: unit.text,
        },
      }

      const result = await this.request(peer, '/v1/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (result && result.ok === true) {
        this.setBase(peer.name, unit.id, unit.hash)
        delete this.state.pending[unit.id]
        // The peer has taken our copy, so locally won entries are no longer at risk.
        if (unit.id === 'patch') {
          this.state.patchKeep[peer.name] = []
          if (!this.state.patchBase[peer.name]) this.state.patchBase[peer.name] = slotHashes(unit.text)
        }
        this.log.info(`push: ${unit.id} -> ${peer.name}`)
        continue
      }

      if (result && result.reason === 'conflict') {
        // The peer keeps its bytes; edit time settles it on the next pull.
        this.log.warn(`${unit.id}: ${peer.name} refused the overwrite (both sides changed)`)
        continue
      }

      this.log.warn(`push ${unit.id} -> ${peer.name} failed: ${result ? result.reason || 'unknown' : 'no-response'}`)
    }
  }

  /** Inbound apply: another machine pushes one of its units into this one. */
  async receive(payload) {
    if (this.applying) return { ok: false, reason: 'busy' }
    this.applying = true
    try {
      const unit = payload && payload.unit
      const from = payload && payload.from ? String(payload.from) : 'peer'
      if (!unit || typeof unit.id !== 'string' || typeof unit.text !== 'string') {
        return { ok: false, reason: 'invalid' }
      }
      if (Buffer.byteLength(unit.text, 'utf8') > MAX_UNIT_BYTES) return { ok: false, reason: 'too-large' }
      const descriptor = unitFromId(unit.id)
      if (!descriptor) return { ok: false, reason: 'unknown-unit' }

      // A pushed patch is merged, not adopted: the peer's copy may predate
      // entries only this machine has.
      if (descriptor.kind === 'patch') {
        const current = (await readLocalUnitText(descriptor, this.config)) ?? ''
        const merged = mergePatch({
          localText: current,
          remoteText: unit.text,
          base: this.state.patchBase[from],
          keepKeys: this.state.patchKeep[from],
          deny: this.effectiveDeny,
          localMtime: this.patchMtime(),
          remoteMtime: unit.updatedAt,
        })
        if (merged.rejected) return { ok: false, reason: merged.rejected.reason }
        if (merged.changed) {
          await applyUnit(this.ctx, { id: 'patch', kind: 'patch', text: merged.text }, this.log, this.config)
          this.log.info(
            `merge: patch <- ${from}${merged.conflicts.length ? ` (conflicts: ${merged.conflicts.join(', ')})` : ''}`,
          )
        }
        const hash = this.notePatchMerged(from, merged.text, merged)
        return { ok: true, hash }
      }

      const hash = hashText(unit.text)
      if (unit.hash && unit.hash !== hash) return { ok: false, reason: 'hash-mismatch' }

      const { units } = await this.noteLocal()
      const here = units.find((candidate) => candidate.id === unit.id) || null
      const base = payload.base == null ? null : String(payload.base)
      const known = this.baseFor(from, unit.id)

      if (here && here.hash === hash) {
        this.setBase(from, unit.id, hash)
        this.saveState()
        return { ok: true, note: 'already-synced' }
      }

      if (here) {
        const agreed = base === here.hash || known === here.hash
        if (!agreed) {
          // No baseline on either side yet: settle it with the same rule the pull
          // pass uses, so the two machines never disagree about the winner.
          const initial = known == null && base == null
          if (initial) {
            const winner = pickWinner(here, { hash, updatedAt: unit.updatedAt })
            if (winner !== 'remote') {
              return { ok: false, reason: 'conflict', hash: here.hash, kind: here.kind }
            }
          } else {
            const reply = { ok: false, reason: 'conflict', hash: here.hash, kind: here.kind }
            if (here.kind !== 'cred') reply.text = here.text
            return reply
          }
        }
      }

      await applyUnit(this.ctx, { ...descriptor, text: unit.text, encoding: unit.encoding }, this.log, this.config)
      this.setLocalHash(unit.id, hash, unit.updatedAt)
      this.setBase(from, unit.id, hash)
      delete this.state.pending[unit.id]
      this.saveState()
      this.log.info(`receive: ${unit.id} <- ${from}`)
      return { ok: true, hash }
    } catch (error) {
      this.log.warn(`receive failed: ${messageOf(error)}`)
      return { ok: false, reason: 'error', message: messageOf(error) }
    } finally {
      this.applying = false
    }
  }

  async stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.discovery) {
      try {
        this.discovery.stop()
      } catch {
        /* already closed */
      }
      this.discovery = null
    }
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = null
    for (const watcher of this.watchers) {
      try {
        watcher.close()
      } catch {
        /* already closed */
      }
    }
    this.watchers = []
    await stopServer(this.server)
    this.server = null
    this.saveState()
    this.log.info('stopped')
  }
}

