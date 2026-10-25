import { SyncEngine } from './lib/sync.js'

export const name = 'peer-sync'

/**
 * The sync engine needs the credential service to write API keys through the
 * service rather than by rewriting `.credentials.yaml` (which also carries
 * machine-bound records that must never be copied between machines).
 */
export const inject = ['credentials']

export function apply(ctx) {
  // `ctx.effect` is what makes the disposer authoritative: on profile
  // recomposition the old engine stops — and releases its listening socket —
  // before a new one starts.
  ctx.effect(() => {
    const engine = new SyncEngine(ctx)
    engine.start().catch((error) => {
      engine.log.error(`start failed: ${error && error.message ? error.message : error}`)
    })
    return async () => {
      await engine.stop()
    }
  })
}
