import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { createLog } from './log.js'
import { loadConfig, pairingText, PROTOCOL_VERSION, saveConfig } from './config.js'
import { applyBundleSet, applyUnit, keepConflictCopy, readLocalUnitText } from './apply.js'
import { collectUnits, hashText, manifestOf, readBundleSet, unitFromId, MAX_UNIT_BYTES } from './units.js'
import { startServer, stopServer } from './http.js'
import { writeBytesAtomic, writeFileAtomic } from './atomic.js'
import { archivedSessionIds, listLocalSessions, readableCwd, readSessionFiles, sessionTitles } from './sessions.js'
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

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
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
    /** Stable identity for discovery: hostname + home cannot collide in practice. */
    this.nodeId = hashText(`${os.hostname()}|${dshHome()}`).slice(0, 12)
  }

  async start() {
    fs.mkdirSync(localDir(), { recursive: true })
    const { config, created } = loadConfig()
    this.config = config
    this.state = readState()
    this.effectiveDeny = denyKeys(config.syncDeny)

    this.log.info(`self=${config.self} profile=${display(profileDir())} patch=${display(patchPath())}`)
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
          readSessionPage: (id, beforeSeq, max, through) => this.readSessionPage(id, beforeSeq, max, through),
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
    const body = {
      id: this.nodeId,
      name: this.config.self,
      platform: process.platform,
      httpPort: this.config.listen.port,
      token: this.config.token,
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
    if (!answer || answer.ok !== true || !answer.peer || !answer.peer.token) {
      this.log.warn(`pairing with ${beacon.name || beacon.id} refused: ${answer ? answer.reason || 'unknown' : 'no-response'}`)
      return
    }
    await this.upsertPeer({ id: answer.peer.id, name: answer.peer.name || beacon.name, url, token: answer.peer.token })
    this.log.info(`paired (discovered): ${beacon.name || beacon.id} at ${url}`)
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
    await this.upsertPeer({ id, name: typeof body.name === 'string' && body.name ? body.name : id, url, token })
    this.log.info(`paired (inbound): ${body.name || id} at ${url}`)
    return {
      ok: true,
      peer: { id: this.nodeId, name: this.config.self, token: this.config.token, httpPort: this.config.listen.port },
    }
  }

  /** Add or refresh one peer, persisting the machine-local config. */
  async upsertPeer({ id, name, url, token }) {
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
    } else {
      this.config.peers.push({ id, name, url, token })
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
    if (this.config.share && this.config.share.sessions) {
      const list = await listLocalSessions(this.config.sessionsLimit)
      const titles = sessionTitles()
      const archived = archivedSessionIds()
      payload.sessions = list.map((session) => ({
        id: session.id,
        cwd: readableCwd(session.cwdKey),
        title: titles.get(session.id) || '',
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

  async readSession(id) {
    if (!this.config || !this.config.sync.sessions) return null
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
        const match = records.find((record) => record && typeof record.path === "string" && path.resolve(record.path) === wanted)
        if (!match) continue
        try {
          if (typeof registry.delete === "function") await registry.delete(match.id)
          this.log.info(`workspace removed: ${match.path}`)
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
    try {
      // A stream opened against a prepared source drains its backlog and closes,
      // so waiting on one stream misses the answer. Poll fresh tail snapshots
      // instead: every follow() opening carries records for the recent window.
      let baseCursor = -1
      if (wait && typeof controller.follow === "function") {
        try {
          const probe = controller.follow({ address, maxMessages: 1 }, controllerSignal.signal)[Symbol.asyncIterator]()
          const first = await probe.next()
          const frame = first && !first.done ? first.value : null
          if (frame && typeof frame.cursor === "number") baseCursor = frame.cursor
          try { await probe.return() } catch { /* closed */ }
        } catch (error) {
          this.log.warn(`follow open failed: ${messageOf(error)}`)
        }
      }
      const request = { sessionId, requestId, content: [{ type: "text", text }] }
      const value = await controller.prompt(request, controllerSignal.signal)
      this.log.info(`remote prompt: session=${sessionId.slice(0, 8)} requestId=${requestId} bytes=${Buffer.byteLength(text, "utf8")}`)
      const accepted = Boolean(value && value.accepted)
      if (!wait) return { ok: true, requestId, accepted, value }
      if (typeof controller.follow !== "function") {
        return { ok: true, requestId, accepted, pending: true, note: "follow-unavailable" }
      }
      const budget = Number(waitSeconds) > 0 ? Number(waitSeconds) : 300
      const deadline = Date.now() + budget * 1000
      let reply = null
      let events = 0
      let lastSample = null
      const kinds = []
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
        lastSample = records[0] || lastSample
        for (const item of records) if (kinds.length < 12) kinds.push(String(item.event.type))
        // Pair inside the window: the reply belongs to the last turn in it, so
        // no seq arithmetic is needed (the snapshot window and baseCursor do not
        // necessarily describe the same range).
        const types = records.map((item) => item.event.type)
        const start = types.lastIndexOf("turn/start")
        const answer = (start >= 0 ? records.slice(start) : records)
          .filter((item) => item.event.type === "assistant/message")
          .pop()
        if (answer) {
          reply = lastAssistantText({ session: { eventsSnapshot: [answer.event] } })
          break
        }
      }
      controllerSignal.abort()

      return {
        ok: true,
        requestId,
        accepted,
        pending: reply === null,
        // `started` separates "queued but the agent never picked it up" from
        // "running, answer not finished yet" — an automation loop needs that.
        started: kinds.includes("turn/start"),
        waited: budget,
        baseCursor,
        events,
        kinds,
        reply,
        recordKeys: lastSample ? Object.keys(lastSample) : null,
        eventKeys: lastSample && lastSample.event ? Object.keys(lastSample.event).slice(0, 10) : null,
      }
    } catch (error) {
      const code = error && error.code ? error.code : "prompt-failed"
      this.log.warn(`remote prompt rejected: ${code}`)
      return { ok: false, reason: code, message: messageOf(error) }
    }
  }

  /** Read one session page without activating anything. */
  async readSessionPage(sessionId, beforeSeq, maxMessages, throughSeq) {
    const controller = serviceOf(this.ctx, "sessionController")
    if (!controller || typeof controller.page !== "function") return { ok: false, reason: "no-controller" }
    if (typeof sessionId !== "string" || !sessionId) return { ok: false, reason: "missing-session" }
    const through = Number(throughSeq) >= 0 ? Number(throughSeq) : -1
    const max = Number(maxMessages) > 0 ? Number(maxMessages) : 5
    // Try the two plausible request shapes and report both, so the contract is
    // settled by evidence instead of another guess.
    const shapes = [
      { label: "address", request: { address: { kind: "session", sessionId }, throughSeq: through, maxMessages: max } },
      { label: "flat", request: { sessionId, throughSeq: through, maxMessages: max } },
      { label: "address+through-1", request: { address: { kind: "session", sessionId }, throughSeq: Math.max(0, through - 1), maxMessages: max } },
    ]
    const attempts = []
    for (const shape of shapes) {
      try {
        const page = await controller.page(shape.request, new AbortController().signal)
        const records = Array.isArray(page && page.records) ? page.records : []
        attempts.push({
          shape: shape.label,
          ok: true,
          records: records.length,
          firstSeq: records[0] && records[0].event ? records[0].event.seq : null,
          lastSeq: records.length && records[records.length - 1].event ? records[records.length - 1].event.seq : null,
          hasMore: Boolean(page && page.hasMore),
        })
      } catch (error) {
        attempts.push({ shape: shape.label, ok: false, error: String((error && error.message) || error).slice(0, 140) })
      }
    }
    return { ok: true, pageArity: controller.page.length, attempts }
  }

  async writeStatus() {
    const peers = this.config.peers.map((peer) => {
      const health = this.peerHealth.get(peer.name) || {}
      return {
        name: peer.name,
        url: peer.url,
        reachable: Boolean(health.reachable),
        lastSyncAt: health.lastSyncAt ? new Date(health.lastSyncAt).toISOString() : null,
        lastError: health.lastError || null,
      }
    })
    const status = {
      self: this.config.self,
      updatedAt: new Date().toISOString(),
      listen: `${this.config.listen.host}:${this.config.listen.port}`,
      units: Object.keys(this.state.units),
      pending: Object.keys(this.state.pending),
      peers,
      log: display(`${localDir()}${path.sep}sync.log`),
    }
    try {
      await writeFileAtomic(statusPath(), `${JSON.stringify(status, null, 2)}\n`)
    } catch (error) {
      this.log.warn(`cannot write status.json: ${messageOf(error)}`)
    }
    return status
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
      const status = JSON.parse(fs.readFileSync(statusPath(), 'utf8').replace(/^\uFEFF/, ''))
      const wanted = readJson(path.join(localDir(), 'bundles.wanted.json')) || {}
      const peerName = Array.isArray(status.peers) && status.peers[0] ? status.peers[0].name : null
      let items = []
      if (peerName) {
        const index = readJson(path.join(localDir(), 'peers', peerName, 'sessions', 'index.json')) || {}
        items = Object.entries(index)
          .map(([id, value]) => ({ id, ...value }))
          .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      }
      return {
        ...status,
        units: { count: Array.isArray(status.units) ? status.units.length : 0, ids: status.units || [] },
        bundles: {
          toInstall: wanted.toInstall || [],
          needsManualInstall: wanted.needsManualInstall || [],
          stateDiff: wanted.stateDiff || [],
        },
        sessions: { peer: peerName, items },
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
        let hello
        try {
          hello = await this.request(peer, '/v1/hello')
          if (!hello || hello.ok !== true) throw new Error(hello ? hello.reason || 'bad-hello' : 'no-response')
          this.peerHealth.set(peer.name, { reachable: true, lastError: null, lastSyncAt: Date.now() })
          this.applyPeerDeny(hello)
        } catch (error) {
          const previous = this.peerHealth.get(peer.name) || {}
          const repeated = previous.reachable === false && previous.lastError === messageOf(error)
          this.peerHealth.set(peer.name, {
            reachable: false,
            lastError: messageOf(error),
            lastSyncAt: previous.lastSyncAt || 0,
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
    if (this.config.sync.sessions && Array.isArray(hello.sessions)) {
      await this.mirrorSessions(peer, hello.sessions).catch((error) => {
        this.log.warn(`session mirror from ${peer.name} failed: ${messageOf(error)}`)
      })
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
