import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { credentialsPath, patchPath, presetsDir, projectDir, projectsRoot } from './paths.js'
import { serviceOf } from './services.js'

export const MAX_UNIT_BYTES = 512 * 1024
export const MAX_PROJECT_FILE_BYTES = 1024 * 1024

const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.svn'])
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

// A shared project is synced at file granularity, so build output and virtual
// environments must never travel: they are machine-specific and enormous.
const PROJECT_SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.idea',
  '.vscode',
])
const PROJECT_SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.dshignore.lock'])

// Artifacts this plugin itself writes must never become sync units, or a
// conflict copy would replicate itself to the peer and back.
const PROJECT_SKIP_PATTERN = /(?:\.conflict-[^\\/]+|\.\d+\.\d+\.tmp)$/

export function hashText(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)
}

function statOf(file) {
  try {
    return fs.statSync(file)
  } catch {
    return null
  }
}

async function readText(file) {
  try {
    // Strip a BOM so a file written by a Windows editor hashes the same as the
    // same content written by the harness.
    return (await fs.promises.readFile(file, 'utf8')).replace(/^\uFEFF/, '')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

/** Rebuild a unit descriptor from its stable id (`patch`, `cred:NAME`, `preset:rel`, `proj:name:rel`). */
export function unitFromId(id) {
  if (typeof id !== 'string') return null
  if (id === 'patch') return { id, kind: 'patch' }
  if (id.startsWith('cred:')) return { id, kind: 'cred', name: id.slice('cred:'.length) }
  if (id.startsWith('preset:')) return { id, kind: 'preset', rel: id.slice('preset:'.length) }
  if (id.startsWith('proj:')) {
    const rest = id.slice('proj:'.length)
    const split = rest.indexOf(':')
    if (split <= 0) return null
    return { id, kind: 'project', project: rest.slice(0, split), rel: rest.slice(split + 1) }
  }
  return null
}

/**
 * A bundle spec only travels between machines when it names something the other
 * side can actually resolve: a registry spec, a git address, or a tarball URL.
 * `link:`, `file:`, and absolute paths point at this machine's disk.
 */
export function portableSpec(source) {
  if (typeof source !== 'string' || !source.trim()) return false
  const spec = source.trim()
  if (/^(link|file|portal|workspace):/i.test(spec)) return false
  if (/^[a-zA-Z]:[\\/]/.test(spec) || spec.startsWith('/') || spec.startsWith('\\\\')) return false
  if (spec.startsWith('.') || spec.startsWith('~')) return false
  return true
}

/**
 * The bundle set this machine runs, as a portable description. Derived from the
 * Plugin Manager rather than from package.json so installation-supplied bundles
 * and their enabled state are included.
 */
export async function readBundleSet(ctx) {
  const manager = serviceOf(ctx, 'pluginManager')
  if (!manager || typeof manager.listBundles !== 'function') return null
  let bundles
  try {
    bundles = await manager.listBundles()
  } catch {
    return null
  }
  if (!Array.isArray(bundles)) return null
  return bundles
    .filter((bundle) => bundle && typeof bundle.name === 'string')
    .map((bundle) => ({
      name: bundle.name,
      enabled: bundle.enabled !== false,
      source: portableSpec(bundle.source) ? bundle.source.trim() : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function readCredentialRefs() {
  const text = await readText(credentialsPath())
  if (!text) return []
  let document
  try {
    document = YAML.parse(text)
  } catch {
    return []
  }
  const refs = document && typeof document === 'object' ? document.refs : null
  if (!refs || typeof refs !== 'object') return []
  const entries = []
  for (const [name, value] of Object.entries(refs)) {
    if (typeof value === 'string' && value.length > 0) entries.push([name, value])
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]))
  return entries
}

async function readPresetFiles() {
  const root = presetsDir()
  const found = []

  async function walk(directory, prefix) {
    let entries
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const name = entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(name) || name.startsWith('.')) continue
        await walk(path.join(directory, name), prefix ? `${prefix}/${name}` : name)
        continue
      }
      if (!entry.isFile()) continue
      if (SKIP_FILES.has(name) || name.startsWith('.')) continue
      const absolute = path.join(directory, name)
      const stat = statOf(absolute)
      if (!stat || stat.size > MAX_UNIT_BYTES) continue
      let text
      try {
        text = await fs.promises.readFile(absolute, 'utf8')
      } catch {
        continue
      }
      if (text.includes('\u0000')) continue
      found.push([prefix ? `${prefix}/${name}` : name, { text, mtimeMs: stat.mtimeMs }])
    }
  }

  await walk(root, '')
  found.sort((a, b) => a[0].localeCompare(b[0]))
  return found
}

/**
 * A shared project is described by its files, not by the directory: the two
 * machines keep it at their own absolute path and only the project name and the
 * relative path travel.
 */
async function readProjectIgnores(dir) {
  const text = await readText(path.join(dir, '.dshignore'))
  if (!text) return []
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

function matchesIgnore(relative, base, rules) {
  for (const rule of rules) {
    const cleaned = rule.replace(/^\/+|\/+$/g, '')
    if (!cleaned) continue
    if (cleaned.endsWith('*')) {
      if (relative.startsWith(cleaned.slice(0, -1))) return true
      continue
    }
    if (relative === cleaned || relative.startsWith(`${cleaned}/`)) return true
    if (!cleaned.includes('/') && base === cleaned) return true
  }
  return false
}

export async function readProjectFiles(config) {
  const found = []
  const names = Array.isArray(config.projects) ? config.projects : []
  for (const project of names) {
    const dir = projectDir(config, project)
    const rules = await readProjectIgnores(dir)

    async function walk(directory, prefix) {
      let entries
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (PROJECT_SKIP_DIRECTORIES.has(entry.name)) continue
          if (matchesIgnore(relative, entry.name, rules)) continue
          await walk(path.join(directory, entry.name), relative)
          continue
        }
        if (!entry.isFile()) continue
        if (PROJECT_SKIP_FILES.has(entry.name)) continue
        if (PROJECT_SKIP_PATTERN.test(entry.name)) continue
        if (matchesIgnore(relative, entry.name, rules)) continue
        const absolute = path.join(directory, entry.name)
        const stat = statOf(absolute)
        if (!stat || stat.size > MAX_PROJECT_FILE_BYTES) continue
        let buffer
        try {
          buffer = await fs.promises.readFile(absolute)
        } catch {
          continue
        }
        const asText = buffer.toString('utf8')
        const isText = !buffer.includes(0) && Buffer.from(asText, 'utf8').equals(buffer)
        found.push({
          project,
          rel: relative,
          text: isText ? asText : buffer.toString('base64'),
          encoding: isText ? 'utf8' : 'base64',
          mtimeMs: stat.mtimeMs,
        })
      }
    }

    await walk(dir, '')
  }
  found.sort((a, b) => `${a.project}:${a.rel}`.localeCompare(`${b.project}:${b.rel}`))
  return found
}

/**
 * Whether this machine's own project rules exclude a path. Applied on the
 * receiving side too, so a peer that has not yet learned `.dshignore` cannot
 * push an excluded file in.
 */
export async function isIgnoredProjectFile(config, project, rel) {
  if (typeof rel !== 'string' || !rel) return false
  const segments = rel.split('/')
  if (segments.some((segment) => PROJECT_SKIP_DIRECTORIES.has(segment))) return true
  const base = segments[segments.length - 1]
  if (PROJECT_SKIP_FILES.has(base) || PROJECT_SKIP_PATTERN.test(base)) return true
  const rules = await readProjectIgnores(projectDir(config, project))
  return matchesIgnore(rel, base, rules)
}

/**
 * The units this machine currently offers. Content is the wire payload; the
 * hash is the version both sides compare.
 */
export async function collectUnits(config, ctx) {
  const units = []

  if (config.sync.patch) {
    const text = await readText(patchPath())
    if (text != null) {
      units.push({
        id: 'patch',
        kind: 'patch',
        text,
        updatedAt: statOf(patchPath())?.mtimeMs ?? 0,
      })
    }
  }

  if (config.sync.credentials) {
    const stamp = statOf(credentialsPath())?.mtimeMs ?? 0
    for (const [name, value] of await readCredentialRefs()) {
      units.push({ id: `cred:${name}`, kind: 'cred', name, text: value, updatedAt: stamp })
    }
  }

  if (config.sync.presets) {
    for (const [rel, entry] of await readPresetFiles()) {
      units.push({
        id: `preset:${rel}`,
        kind: 'preset',
        rel,
        text: entry.text,
        updatedAt: entry.mtimeMs,
      })
    }
  }

  if (config.sync.projects) {
    for (const file of await readProjectFiles(config)) {
      units.push({
        id: `proj:${file.project}:${file.rel}`,
        kind: 'project',
        project: file.project,
        rel: file.rel,
        text: file.text,
        encoding: file.encoding,
        updatedAt: file.mtimeMs,
      })
    }
  }

  for (const unit of units) unit.hash = hashText(unit.text)
  units.sort((a, b) => a.id.localeCompare(b.id))
  return units
}

/** Wire shape: no content, only what a peer needs to decide. */
export function manifestOf(units) {
  return units.map((unit) => ({
    id: unit.id,
    kind: unit.kind,
    hash: unit.hash,
    updatedAt: unit.updatedAt,
    // Binary project files travel as base64; the receiver must know which.
    encoding: unit.encoding || 'utf8',
  }))
}
