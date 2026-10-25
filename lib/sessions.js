import fs from 'node:fs'
import path from 'node:path'
import { dshHome } from './paths.js'

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
let titleCache = { at: 0, titles: new Map() }

export function sessionTitles() {
  const file = path.join(dshHome(), 'storages', 'session_projcache.json')
  const stat = statOf(file)
  if (!stat) return new Map()
  if (titleCache.at === stat.mtimeMs) return titleCache.titles
  const titles = new Map()
  try {
    const document = JSON.parse(fs.readFileSync(file, 'utf8'))
    const table = document && document.tables && document.tables.sessions
    for (const [id, record] of Object.entries(table || {})) {
      const title = record && record.rows && record.rows.title && record.rows.title.val
      if (typeof title === 'string' && title.trim()) titles.set(id, title.trim())
    }
  } catch {
    /* an unreadable projection only costs the titles */
  }
  titleCache = { at: stat.mtimeMs, titles }
  return titles
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
  return parts.length > 0 ? parts.join('/') : '(unknown)'
}
