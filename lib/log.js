import fs from 'node:fs'
import { localDir, logPath, display } from './paths.js'

const MAX_LOG_BYTES = 512 * 1024

function text(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack || value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Console plus a rotating file under `~/.dsh/peer-sync/sync.log`. The file
 * matters because two-machine sync problems are diagnosed after the fact.
 */
export function createLog(scope) {
  let ready = false

  function ensure() {
    if (ready) return
    fs.mkdirSync(localDir(), { recursive: true })
    ready = true
    try {
      const stat = fs.statSync(logPath(), { throwIfNoEntry: false })
      if (stat && stat.size > MAX_LOG_BYTES) fs.renameSync(logPath(), `${logPath()}.1`)
      // A leading BOM keeps Windows PowerShell's default reader on UTF-8.
      if (!fs.existsSync(logPath())) fs.writeFileSync(logPath(), '\uFEFF')
    } catch {
      /* rotation is best effort */
    }
  }

  function record(level, args) {
    const line = `${new Date().toISOString()} ${level} [${scope}] ${args.map(text).join(' ')}`
    if (level === 'ERROR' || level === 'WARN') console.warn(line)
    else console.log(line)
    try {
      ensure()
      fs.appendFileSync(logPath(), `${line}\n`)
    } catch {
      /* a full or locked log must never break syncing */
    }
  }

  return {
    info: (...args) => record('INFO ', args),
    warn: (...args) => record('WARN ', args),
    error: (...args) => record('ERROR', args),
    path: logPath,
    displayPath: () => display(logPath()),
  }
}
