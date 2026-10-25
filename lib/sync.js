import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLog } from './log.js'
import { loadConfig, pairingText, PROTOCOL_VERSION, saveConfig } from './config.js'
import { applyBundleSet, applyUnit, keepConflictCopy, readLocalUnitText } from './apply.js'
import { collectUnits, hashText, manifestOf, readBundleSet, unitFromId, MAX_UNIT_BYTES } from './units.js'
import { startServer, stopServer } from './http.js'
import { writeBytesAtomic, writeFileAtomic } from './atomic.js'
import { listLocalSessions, readableCwd, readSessionFiles, sessionTitles } from './sessions.js'
import { serviceOf } from './services.js'
import { startDiscovery } from './discovery.js'
import { dshHome, display, localDir, patchPath, pickListenAddress, presetsDir, profileDir, projectDir, projectsRoot, statePath, statusPath } from './paths.js'

function emptyState() {
  return { units: {}, bases: {}, pending: {}, lastSyncAt: 0 }
}

function readState() {
  try {
    const text = fs.readFileSync(statePath(), 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text)
    return {
      units: parsed && typeof parsed.units === 'object' && parsed.units ? parsed.units : {},
      bases: parsed && typeof parsed.bases === 'object' && parsed.bases ? parsed.bases : {},
      pending: parsed && typeof parsed.pending === 'object' && parsed.pending ? parsed.pending : {},
      lastSyncAt: Number(parsed && parsed.lastSyncAt) || 0,
    }
  } catch {
    return emptyState()
  }
}

function messageOf(error) {
  return error && error.message ? error.message : String(error)
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
    /** Stable identity for discovery: hostname + home cannot collide in practice. */
    this.nodeId = hashText(`${os.hostname()}|${dshHome()}`).slice(0, 12)
  }

  async start() {
    fs.mkdirSync(localDir(), { recursive: true })
    const { config, created } = loadConfig()
    this.config = config
    this.state = readState()

    this.log.info(`self=${config.self} profile=${display(profileDir())} patch=${display(patchPath())}`)
    if (created) {
      this.log.info(`created ${display(localDir())}/config.json`)
      this.log.info(`pairing:\n${pairingText(config)}`)
    }

    if (!config.enabled) {
      this.log.info('disabled by config.enabled=false')
      return
    }
    if (config.peers.length === 0) {
      this.log.warn('no peers configured; add the other machine to config.json -> peers')
    }

    await this.ensureProjects()
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
    const peer = this.config.peers.find((entry) => (id && entry.id === id) || entry.url === url)
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
    const units = await collectUnits(this.config, this.ctx)
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
    const units = await collectUnits(this.config, this.ctx)
    return manifestOf(units)
  }

  /** Everything the handshake carries beyond the unit manifest. */
  async advertise() {
    if (!this.config) return {}
    const payload = { bundles: null, sessions: null }
    if (this.config.sync.bundles) payload.bundles = await readBundleSet(this.ctx)
    if (this.config.sync.sessions) {
      const list = await listLocalSessions(this.config.sessionsLimit)
      const titles = sessionTitles()
      payload.sessions = list.map((session) => ({
        id: session.id,
        cwd: readableCwd(session.cwdKey),
        title: titles.get(session.id) || '',
        updatedAt: session.updatedAt,
        size: session.size,
      }))
    }
    return payload
  }

  async readSession(id) {
    if (!this.config || !this.config.sync.sessions) return null
    return readSessionFiles(id)
  }

  async find(id) {
    const units = await collectUnits(this.config, this.ctx)
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
    if (hashText(answer.text) !== remote.hash) throw new Error(`${remote.id}: hash does not match the manifest`)
    const descriptor = unitFromId(remote.id)
    if (!descriptor) throw new Error(`${remote.id}: unknown unit`)

    // A version this machine is about to lose is never dropped silently.
    if (backup) {
      const previous = await readLocalUnitText(descriptor, this.config)
      if (previous != null && hashText(previous) !== remote.hash) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        await keepConflictCopy(descriptor, previous, `${this.config.self}-${stamp}`, this.config).catch(() => null)
      }
    }

    await applyUnit(this.ctx, { ...descriptor, text: answer.text, encoding: remote.encoding }, this.log, this.config)
    this.setLocalHash(remote.id, remote.hash, Date.now())
    this.setBase(peer.name, remote.id, remote.hash)
    delete this.state.pending[remote.id]
    this.log.info(`${label}: ${remote.id} <- ${peer.name}`)
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
      if (!there) shouldSend = true
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
