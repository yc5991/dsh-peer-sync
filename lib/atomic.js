import fs from 'node:fs'
import path from 'node:path'

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOENT'])

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Write through a temporary file in the same directory and rename over the
 * target, so a watcher (HMR included) never observes a half-written file.
 * Windows can briefly lock a file another process is reading, hence the retry.
 */
export async function writeFileAtomic(target, content, attempts = 5) {
  const dir = path.dirname(target)
  await fs.promises.mkdir(dir, { recursive: true })
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`)
  await fs.promises.writeFile(temp, content, 'utf8')
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.promises.rename(temp, target)
      return
    } catch (error) {
      if (attempt >= attempts || !RETRYABLE.has(error && error.code)) {
        await fs.promises.rm(temp, { force: true }).catch(() => {})
        throw error
      }
      await sleep(60 * attempt)
    }
  }
}

/** Same atomic replace for bytes, used by binary project files. */
export async function writeBytesAtomic(target, bytes, attempts = 5) {
  const dir = path.dirname(target)
  await fs.promises.mkdir(dir, { recursive: true })
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`)
  await fs.promises.writeFile(temp, bytes)
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.promises.rename(temp, target)
      return
    } catch (error) {
      if (attempt >= attempts || !RETRYABLE.has(error && error.code)) {
        await fs.promises.rm(temp, { force: true }).catch(() => {})
        throw error
      }
      await sleep(60 * attempt)
    }
  }
}

/** Same-directory copy used for conflict survivors next to the original. */
export async function writeConflictCopy(target, content, suffix) {
  const copy = `${target}.conflict-${suffix}`
  await writeFileAtomic(copy, content)
  return copy
}
