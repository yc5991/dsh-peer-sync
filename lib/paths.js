import os from 'node:os'
import path from 'node:path'

function blank(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** `$DSH_HOME` when set, else `~/.dsh` — the same precedence the harness uses. */
export function dshHome() {
  const configured = blank(process.env.DSH_HOME)
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.dsh')
}

export function profileName() {
  return blank(process.env.DSH_PROFILE) || 'desktop'
}

/** `$DSH_PROFILE_DIR` is exported by the launcher; keep a sane fallback. */
export function profileDir() {
  const configured = blank(process.env.DSH_PROFILE_DIR)
  return configured ? path.resolve(configured) : path.join(dshHome(), 'profiles', profileName())
}

export function localDir() {
  return path.join(dshHome(), 'peer-sync')
}

export function configPath() {
  return path.join(localDir(), 'config.json')
}

export function statePath() {
  return path.join(localDir(), 'state.json')
}

export function statusPath() {
  return path.join(localDir(), 'status.json')
}

export function logPath() {
  return path.join(localDir(), 'sync.log')
}

/** The profile patch layer: the file that carries settings, model choice and presets. */
export function patchPath() {
  return path.join(profileDir(), 'cordis.patch.yml')
}

export function shadowPatchPath() {
  return path.join(dshHome(), 'cordis.patch.yml')
}

export function credentialsPath() {
  return path.join(dshHome(), '.credentials.yaml')
}

export function presetsDir() {
  return path.join(dshHome(), '.agent-presets')
}

/** Expand only `~` and `~/...`, the same narrow rule the harness uses. */
export function expandHome(input) {
  if (typeof input !== 'string' || !input) return input
  if (input === '~') return os.homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2))
  return input
}

/** The directory that holds every shared project on this machine. */
export function projectsRoot(config) {
  const configured = config && typeof config.projectsRoot === 'string' ? config.projectsRoot : ''
  const root = configured ? expandHome(configured) : path.join(os.homedir(), 'DSH', 'Projects')
  return path.resolve(root)
}

export function projectDir(config, name) {
  return path.join(projectsRoot(config), name)
}

/** Shorten an absolute path for logs and status output. */
export function display(p) {
  const home = dshHome()
  if (p === home) return '~/.dsh'
  if (p.startsWith(home + path.sep)) return `~/.dsh${p.slice(home.length)}`
  return p
}
