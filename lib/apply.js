import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { writeBytesAtomic, writeConflictCopy, writeFileAtomic } from './atomic.js'
import { credentialsPath, localDir, patchPath, presetsDir, projectDir } from './paths.js'
import { isIgnoredProjectFile } from './units.js'
import { serviceOf } from './services.js'

/**
 * Reconcile this machine's bundle set with the peer's description of it.
 *
 * Installing runs pnpm and can take minutes, so it only happens when the user
 * opted in (`bundlesMode: 'install'`); otherwise the diff is reported and parked
 * in `bundles.wanted.json`. Nothing is ever removed or disabled here: a bundle
 * the peer runs and this machine deliberately switched off stays switched off.
 */
export async function applyBundleSet(ctx, list, log, config) {
  const manager = serviceOf(ctx, 'pluginManager')
  if (!manager || typeof manager.listBundles !== 'function') {
    log?.warn('bundles: plugin manager is unavailable on this host')
    return
  }
  if (!Array.isArray(list) || list.length === 0) return
  const local = await manager.listBundles()
  const have = new Map((local || []).map((bundle) => [bundle.name, bundle]))

  const installable = []
  const manual = []
  const stateDiff = []
  for (const want of list) {
    if (!want || typeof want.name !== 'string') continue
    const here = have.get(want.name)
    if (!here) {
      if (typeof want.source === 'string' && want.source) installable.push(want)
      else manual.push(want.name)
      continue
    }
    const localOn = here.enabled !== false
    const wantOn = want.enabled !== false
    if (localOn !== wantOn) stateDiff.push(`${want.name}: ${localOn ? 'on' : 'off'} -> ${wantOn ? 'on' : 'off'}`)
  }

  if (installable.length === 0 && manual.length === 0 && stateDiff.length === 0) {
    log?.info('bundles: already aligned')
    return
  }

  const mode = config && config.bundlesMode === 'install' ? 'install' : 'detect'
  const diff = {
    mode,
    toInstall: installable.map((bundle) => `${bundle.name} (${bundle.source})`),
    needsManualInstall: manual,
    stateDiff,
  }
  const wantedFile = path.join(localDir(), 'bundles.wanted.json')
  // The peer advertises on every tick; only rewrite when the picture changed.
  let previous = null
  try {
    previous = JSON.parse(await fs.readFile(wantedFile, 'utf8'))
  } catch {
    previous = null
  }
  const unchanged =
    previous &&
    JSON.stringify({ ...previous, at: undefined }) === JSON.stringify({ ...diff, at: undefined })
  if (!unchanged) {
    await writeFileAtomic(wantedFile, `${JSON.stringify({ ...diff, at: new Date().toISOString() }, null, 2)}\n`).catch(
      () => null,
    )
  }

  if (installable.length > 0) {
    log?.info(`bundles: ${installable.length} to install (${mode}): ${installable.map((b) => b.name).join(', ')}`)
  }
  if (manual.length > 0) {
    log?.warn(`bundles: ${manual.length} cannot be installed from a spec (local link or none): ${manual.join(', ')}`)
  }
  if (stateDiff.length > 0) {
    log?.info(`bundles: enabled-state differs, left alone: ${stateDiff.join('; ')}`)
  }

  if (mode !== 'install') return

  for (const bundle of installable) {
    try {
      log?.info(`bundles: installing ${bundle.name} from ${bundle.source}`)
      const result = await manager.installBundle(bundle.source)
      log?.info(`bundles: ${bundle.name} -> ${result && result.application ? result.application : 'done'}`)
    } catch (error) {
      log?.warn(`bundles: install ${bundle.name} failed: ${error && error.message ? error.message : error}`)
    }
  }
}

/**
 * Last-resort credential write: merge only the `refs` map and keep everything
 * else in the document, so machine-bound `records` survive even when the
 * credential service cannot be reached through this context.
 */
async function writeCredentialDirectly(name, value) {
  const file = credentialsPath()
  let document = null
  try {
    document = YAML.parse(await fs.readFile(file, 'utf8'))
  } catch {
    document = null
  }
  const next = document && typeof document === 'object' ? document : { version: 1, refs: {}, records: {} }
  next.refs = next.refs && typeof next.refs === 'object' ? next.refs : {}
  next.refs[name] = value
  await writeFileAtomic(file, YAML.stringify(next))
}

/**
 * Apply one unit locally. Each kind uses the narrowest mechanism that keeps the
 * harness consistent: the patch is a plain file HMR already watches, credential
 * refs go through the credential service so machine-bound records survive, and
 * presets are ordinary files.
 */
export async function applyUnit(ctx, unit, log, config) {
  if (unit.kind === 'patch') {
    await writeFileAtomic(patchPath(), unit.text)
    return
  }

  if (unit.kind === 'cred') {
    if (!unit.name) throw new Error('credential unit without a name')
    const credentials = serviceOf(ctx, 'credentials')
    if (credentials && typeof credentials.set === 'function') {
      try {
        await credentials.set(unit.name, unit.text)
        return
      } catch (error) {
        log?.warn(
          `凭据服务写入 ${unit.name} 失败，改为直接合并 .credentials.yaml: ${error && error.message ? error.message : error}`,
        )
      }
    }
    await writeCredentialDirectly(unit.name, unit.text)
    return
  }

  if (unit.kind === 'preset') {
    if (!unit.rel) throw new Error('preset unit without a relative path')
    const root = path.resolve(presetsDir())
    const target = path.resolve(root, unit.rel)
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`preset path escapes the presets directory: ${unit.rel}`)
    }
    await writeFileAtomic(target, unit.text)
    return
  }

  if (unit.kind === 'project') {
    if (!unit.project || !unit.rel) throw new Error('project unit without a project or path')
    // The peer may not have learned `.dshignore` yet; this machine's own rules
    // still decide what may land here.
    if (await isIgnoredProjectFile(config, unit.project, unit.rel)) {
      log?.info(`project: skipped ${unit.project}/${unit.rel} (ignored here)`)
      return
    }
    const target = resolveProjectTarget(config, unit.project, unit.rel)
    if (!target) throw new Error(`project path escapes its project directory: ${unit.rel}`)
    const bytes = unit.encoding === 'base64' ? Buffer.from(unit.text, 'base64') : Buffer.from(unit.text, 'utf8')
    await writeBytesAtomic(target, bytes)
    return
  }

  throw new Error(`unknown unit kind: ${unit.kind}`)
}

/** Resolve one project-relative path, refusing anything that escapes the folder. */
function resolveProjectTarget(config, project, relative) {
  const base = path.resolve(projectDir(config, project))
  const target = path.resolve(base, relative)
  if (target !== base && !target.startsWith(base + path.sep)) return null
  return target
}

/** Read what this machine currently holds for a unit, or null when it has none. */
export async function readLocalUnitText(unit, config) {
  try {
    if (unit.kind === 'patch') return await fs.readFile(patchPath(), 'utf8')
    if (unit.kind === 'preset' && unit.rel) {
      const root = path.resolve(presetsDir())
      const target = path.resolve(root, unit.rel)
      if (target !== root && !target.startsWith(root + path.sep)) return null
      return await fs.readFile(target, 'utf8')
    }
    if (unit.kind === 'project' && unit.project && unit.rel) {
      const target = resolveProjectTarget(config, unit.project, unit.rel)
      if (!target) return null
      const buffer = await fs.readFile(target)
      const asText = buffer.toString('utf8')
      const isText = !buffer.includes(0) && Buffer.from(asText, 'utf8').equals(buffer)
      return isText ? asText : buffer.toString('base64')
    }
  } catch {
    return null
  }
  return null
}

/** Keep the version that lost a conflict next to the file it would have replaced. */
export async function keepConflictCopy(unit, text, label, config) {
  if (unit.kind === 'patch') return writeConflictCopy(patchPath(), text, label)
  if (unit.kind === 'preset' && unit.rel) {
    const target = path.resolve(presetsDir(), unit.rel)
    return writeConflictCopy(target, text, label)
  }
  if (unit.kind === 'project' && unit.project && unit.rel) {
    const target = resolveProjectTarget(config, unit.project, unit.rel)
    if (!target) return null
    const bytes = unit.encoding === 'base64' ? Buffer.from(text, 'base64') : Buffer.from(text, 'utf8')
    const copy = `${target}.conflict-${label}`
    await writeBytesAtomic(copy, bytes)
    return copy
  }
  return null
}
