import fs from 'node:fs'

/**
 * Read JSON that may be absent, half-written or dotted with a BOM.
 *
 * Every caller of this is "best effort": a projection file, a status file, a
 * peer's cached advert. None of them is worth failing a sync pass over, so the
 * failure mode is a null the caller has to handle anyway — which is why this is
 * one function instead of a try block repeated in each module.
 */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}
