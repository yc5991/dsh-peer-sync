import fs from 'node:fs'
import path from 'node:path'
import { dshHome } from './paths.js'
import { readJson } from './json.js'

/**
 * Session logs are the harness's own append-only files under
 * `<home>/sessions/<mangled cwd>/<session id>/session.v4.jsonl.zstd`.
 *
 * The container is harness-internal (Node's zstd decoder rejects it), so this
 * module never parses a transcript: it reads metadata for the advert and copies
 * the bytes verbatim into a read-only mirror. That keeps the mirror usable
 * without guessing at a format that may change under us.
 */
const SESSION_FILE = /^session\.[^\\/]+\.jsonl\.zstd$/i
const MAX_MIRROR_BYTES = 16 * 1024 * 1024

function statOf(file) {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

export function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

/** Titles are a projection; read them best-effort and never fail the advert. */
const TITLE_TTL_MS = 5000
let titleCache = { at: 0, titles: new Map() }

/**
 * The folded title inside one projection document.
 *
 * Two storage layouts exist: one per-session file (`record.rows.title.val`) and
 * an older single document keyed by id (`tables.sessions[id].rows.title.val`).
 * Reading only the second one is why every advertised title used to be empty:
 * the file it looked for does not exist on a current install.
 */
export function titleFromSnapshot(document, sessionId) {
  if (!document || typeof document !== 'object') return ''
  const fromRows = (rows) => (rows && rows.title && typeof rows.title.val === 'string' ? rows.title.val.trim() : '')
  const direct = fromRows(document.record && document.record.rows)
  if (direct) return direct
  const own = fromRows(document.rows)
  if (own) return own
  const table = sessionId && document.tables && document.tables.sessions ? document.tables.sessions[sessionId] : null
  return fromRows(table && table.rows)
}

export function sessionTitles() {
  const now = Date.now()
  if (now - titleCache.at < TITLE_TTL_MS) return titleCache.titles
  const titles = new Map()

  const dir = path.join(dshHome(), 'storages', 'session_projcache', 'sessions')
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    names = []
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    const title = titleFromSnapshot(readJson(path.join(dir, name)), id)
    if (title) titles.set(id, title)
  }

  // Older installs kept one document for every session; keep reading it so a
  // machine that has not migrated yet still shows titles.
  const legacy = readJson(path.join(dshHome(), 'storages', 'session_projcache.json'))
  const table = legacy && legacy.tables && legacy.tables.sessions ? legacy.tables.sessions : {}
  for (const [id, record] of Object.entries(table)) {
    if (titles.has(id)) continue
    const title = titleFromSnapshot(record, id)
    if (title) titles.set(id, title)
  }

  titleCache = { at: now, titles }
  return titles
}

/**
 * Look a title up across both key spellings.
 *
 * Session directories are `session-<uuid>` while the projection files are named
 * `<uuid>.json`. Both spellings are in play depending on which side produced the
 * id, and a strict `get` silently loses every title.
 */
export function titleOf(titles, id) {
  if (!titles || typeof id !== 'string' || !id) return ''
  const direct = titles.get(id)
  if (typeof direct === 'string' && direct) return direct
  const other = id.startsWith('session-') ? id.slice('session-'.length) : `session-${id}`
  const flipped = titles.get(other)
  return typeof flipped === 'string' ? flipped : ''
}

/**
 * Session id → directory key, without reading any file's metadata.
 *
 * The status file is written on a timer and the panel reads it synchronously, so
 * the marker needs a scan that does not touch every session's contents: one
 * readdir per directory is enough to answer "which project is this session in".
 */
export function localSessionDirs() {
  const out = []
  const root = sessionsRoot()
  let cwds
  try {
    cwds = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const cwd of cwds) {
    if (!cwd.isDirectory()) continue
    const cwdDir = path.join(root, cwd.name)
    let sessions
    try {
      sessions = fs.readdirSync(cwdDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      if (!/^session-[0-9a-z-]{8,}$/i.test(session.name)) continue
      out.push({ id: session.name, cwdKey: cwd.name })
    }
  }
  return out
}

/** Most recent sessions on this machine, newest first. */
export async function listLocalSessions(limit = 10) {
  const root = sessionsRoot()
  const found = []
  let cwds
  try {
    cwds = await fs.promises.readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const cwd of cwds) {
    if (!cwd.isDirectory()) continue
    const cwdDir = path.join(root, cwd.name)
    let sessions
    try {
      sessions = await fs.promises.readdir(cwdDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      // A project directory can sit beside session directories; only an id counts.
      if (!/^session-[0-9a-z-]{8,}$/i.test(session.name)) continue
      const dir = path.join(cwdDir, session.name)
      let entries
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      const files = []
      let size = 0
      let updatedAt = 0
      for (const entry of entries) {
        if (!entry.isFile() || !SESSION_FILE.test(entry.name)) continue
        const stat = statOf(path.join(dir, entry.name))
        if (!stat) continue
        files.push({ name: entry.name, size: stat.size })
        size += stat.size
        updatedAt = Math.max(updatedAt, stat.mtimeMs)
      }
      if (files.length === 0) continue
      found.push({ id: session.name, cwdKey: cwd.name, files, size, updatedAt })
    }
  }
  found.sort((a, b) => b.updatedAt - a.updatedAt)
  const bounded = Math.max(1, Math.min(200, Number(limit) || 10))
  return found.slice(0, bounded)
}

/** Raw bytes for one mirrored file, or null when the id/name is unknown. */
export async function readSessionFiles(id) {
  const sessions = await listLocalSessions(200)
  const found = sessions.find((session) => session.id === id)
  if (!found) return null
  const dir = path.join(sessionsRoot(), found.cwdKey, found.id)
  const files = []
  let total = 0
  for (const file of found.files) {
    if (total + file.size > MAX_MIRROR_BYTES) break
    let bytes
    try {
      bytes = await fs.promises.readFile(path.join(dir, file.name))
    } catch {
      continue
    }
    total += bytes.length
    files.push({ name: file.name, data: bytes.toString('base64') })
  }
  return { id: found.id, updatedAt: found.updatedAt, files }
}

/** Best-effort readable form of the mangled cwd directory name. */
export function readableCwd(cwdKey) {
  const trimmed = String(cwdKey || '').replace(/^--|--$/g, '')
  const parts = trimmed.split('-').filter(Boolean)
  if (parts.length === 0) return '(unknown)'
  // A leading single-letter segment is a Windows drive, not a missing root.
  if (/^[A-Za-z]$/.test(parts[0])) return `${parts[0]}:/${parts.slice(1).join('/')}`
  return `/${parts.join('/')}`
}

/** Session ids the workspace registry keeps archived. */
export function archivedSessionIds() {
  try {
    const document = JSON.parse(
      fs.readFileSync(path.join(dshHome(), 'storages', 'workspace.json'), 'utf8').replace(/^\uFEFF/, ''),
    )
    const ids = document && document.global && Array.isArray(document.global.archivedSessionIds)
      ? document.global.archivedSessionIds
      : []
    return new Set(ids.filter((id) => typeof id === 'string'))
  } catch {
    return new Set()
  }
}
