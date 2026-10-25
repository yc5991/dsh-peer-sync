/**
 * Read an optional Cordis service without declaring it in `inject`.
 *
 * Cordis throws when a plugin reads a service property it did not inject, but
 * `ctx.get(name)` is the supported soft lookup — the same one the shipped
 * composition uses in `!!js` expressions. A missing service then simply means
 * "this host does not have that capability", which is what every optional
 * feature here wants.
 */
export function serviceOf(ctx, name) {
  if (!ctx || typeof name !== 'string') return undefined
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
  } catch {
    return undefined
  }
  return undefined
}
