import crypto from 'node:crypto'
import YAML from 'yaml'

/**
 * The profile patch is a *list* of loader entries, so syncing it as one opaque
 * file means any edit on one machine replaces everything the other machine had.
 * This module merges the list instead: one slot per entry, keyed by `id` — and
 * for `insert:` blocks, by the inserted entry's `config.id`, because those
 * blocks carry the agent presets and have no id of their own.
 *
 * Slots are merged against the last agreed snapshot (a 3-way merge, per slot):
 *   - only the peer changed it  -> take the peer's
 *   - only we changed it        -> keep ours
 *   - both changed it           -> the newer file wins that slot; the loser's
 *                                  copy is reported so the caller can save it
 */

function hashValue(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)
}

function keyOf(inserted, index) {
  if (inserted && typeof inserted === 'object') {
    if (inserted.config && typeof inserted.config.id === 'string' && inserted.config.id) {
      return `insert:${inserted.config.id}`
    }
    if (typeof inserted.id === 'string' && inserted.id) return `insert:${inserted.id}`
  }
  return `insert:#${index}`
}

/** Flatten the document into slots: plain entries and single inserted entries. */
export function slotsOfDocument(document) {
  const sequence = document && document.contents
  const items = sequence && Array.isArray(sequence.items) ? sequence.items : []
  const slots = []
  for (const node of items) {
    let value
    try {
      value = node && typeof node.toJSON === 'function' ? node.toJSON() : node
    } catch {
      continue
    }
    if (!value || typeof value !== 'object') continue
    if (typeof value.id === 'string' && value.id) {
      slots.push({ key: `id:${value.id}`, kind: 'entry', id: value.id, value, node })
      continue
    }
    if (Array.isArray(value.insert)) {
      value.insert.forEach((inserted, index) => {
        slots.push({
          key: keyOf(inserted, index),
          kind: 'insert',
          id: keyOf(inserted, index),
          value: inserted,
          node,
        })
      })
    }
  }
  return slots
}

export function patchSlots(text) {
  const map = new Map()
  for (const slot of slotsOfDocument(YAML.parseDocument(text))) {
    map.set(slot.key, { ...slot, hash: hashValue(slot.value) })
  }
  return map
}

/** Insert-block slots become their own single-entry block, which the loader accepts. */
function blockFor(slot) {
  return slot.kind === 'insert' ? { insert: [slot.value] } : slot.value
}

/**
 * Merge `remoteText` into `localText`.
 * Returns the new text, whether it differs from the local text, the keys that
 * conflicted, and the remote versions that lost (for a sidecar copy).
 */
export function mergePatch({ localText, remoteText, base, keepKeys, deny, localMtime, remoteMtime }) {
  const localDocument = YAML.parseDocument(localText)
  const remoteDocument = YAML.parseDocument(remoteText)
  if (localDocument.errors && localDocument.errors.length > 0) {
    return { text: localText, changed: false, conflicts: [], won: [], rejected: { reason: 'local-unparsable' } }
  }
  if (remoteDocument.errors && remoteDocument.errors.length > 0) {
    return { text: localText, changed: false, conflicts: [], won: [], rejected: { reason: 'remote-unparsable' } }
  }

  const localSlots = new Map(slotsOfDocument(localDocument).map((slot) => [slot.key, slot]))
  const remoteSlots = new Map(
    slotsOfDocument(remoteDocument).map((slot) => [slot.key, { ...slot, hash: hashValue(slot.value) }]),
  )
  const baseline = base && typeof base === 'object' ? base : {}
  const pinned = new Set(Array.isArray(keepKeys) ? keepKeys : [])
  const remoteWins = (Number(remoteMtime) || 0) > (Number(localMtime) || 0)

  const keep = new Map()
  const order = []
  const conflicts = []
  const won = []
  const lost = []

  const decide = (key) => {
    const here = localSlots.get(key)
    const there = remoteSlots.get(key)
    const hereHash = here ? hashValue(here.value) : undefined
    const thereHash = there ? there.hash : undefined
    const baseHash = baseline[key]

    // A denied slot is local-only: it is neither sent nor accepted.
    if (deny && deny.has(key)) return { use: here ? 'local' : 'skip' }

    if (here && !there) return { use: 'local' }
    if (!here && there) return { use: 'remote' }
    if (hereHash === thereHash) return { use: 'local' }

    // A slot this machine already won and has not managed to push yet must not
    // be pulled back by the peer's stale value.
    if (pinned.has(key)) return { use: 'local' }

    const localChanged = hereHash !== baseHash
    const remoteChanged = thereHash !== baseHash
    if (remoteChanged && !localChanged) return { use: 'remote' }
    if (localChanged && !remoteChanged) return { use: 'local' }

    conflicts.push(key)
    if (remoteWins) {
      lost.push({ key, value: here.value })
      return { use: 'remote' }
    }
    lost.push({ key, value: there.value })
    won.push(key)
    return { use: 'local' }
  }

  for (const slot of localSlots.values()) {
    const decision = decide(slot.key)
    keep.set(slot.key, decision.use === 'remote' ? remoteSlots.get(slot.key) : slot)
    order.push(slot.key)
  }
  for (const [key, slot] of remoteSlots) {
    if (localSlots.has(key)) continue
    keep.set(key, slot)
    order.push(key)
  }

  // Rebuild the document from the decided slots, reusing local nodes so their
  // comments survive; a slot taken from the peer is re-created from its value.
  // Canonical order so two machines that hold the same content build byte-identical
  // files: plain entries by key, then the preset insert blocks by key. Without
  // this the two sides would keep re-sending each other the same entries in a
  // different order.
  const ordered = [...order].sort((a, b) => {
    const aInsert = a.startsWith('insert:')
    const bInsert = b.startsWith('insert:')
    if (aInsert !== bInsert) return aInsert ? 1 : -1
    return a.localeCompare(b)
  })

  const items = []
  for (const key of ordered) {
    const slot = keep.get(key)
    if (!slot) continue
    const localSlot = localSlots.get(key)
    if (localSlot && localSlot.node && hashValue(localSlot.value) === hashValue(slot.value)) {
      items.push(localSlot.node)
      continue
    }
    items.push(localDocument.createNode(blockFor(slot)))
  }

  const nextDocument = localDocument
  nextDocument.contents.items = items
  const text = String(nextDocument)
  return {
    text,
    changed: text !== localText,
    conflicts,
    won,
    lost,
    keys: ordered,
  }
}

/** The snapshot a 3-way merge needs: one hash per merged slot. */
export function slotHashes(text) {
  const out = {}
  for (const [key, slot] of patchSlots(text)) out[key] = slot.hash
  return out
}

/** Normalize a user-written deny list into slot keys. */
export function denyKeys(list) {
  const keys = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== 'string') continue
    const key = raw.trim()
    if (!key) continue
    keys.add(key.startsWith('id:') || key.startsWith('insert:') ? key : `id:${key}`)
  }
  return keys
}

/** Remove the denied slots from a patch before it leaves this machine. */
export function stripDenied(text, deny) {
  if (!deny || deny.size === 0) return text
  const document = YAML.parseDocument(text)
  const items = []
  for (const node of (document.contents && document.contents.items) || []) {
    let value
    try {
      value = node && typeof node.toJSON === 'function' ? node.toJSON() : node
    } catch {
      items.push(node)
      continue
    }
    if (value && typeof value === 'object' && typeof value.id === 'string' && value.id) {
      if (!deny.has(`id:${value.id}`)) items.push(node)
      continue
    }
    if (value && typeof value === 'object' && Array.isArray(value.insert)) {
      const remaining = value.insert.filter((inserted, index) => !deny.has(keyOf(inserted, index)))
      if (remaining.length === value.insert.length) items.push(node)
      else if (remaining.length > 0) items.push(document.createNode({ insert: remaining }))
      continue
    }
    items.push(node)
  }
  document.contents.items = items
  return String(document)
}

/**
 * The patch's identity is its entry set, not its bytes: two machines that agree
 * on every entry must compare equal even when their formatting, comment blocks
 * or entry order differ. Hashing the text would make them keep re-sending the
 * same content forever.
 */
export function patchContentHash(text, deny) {
  const slots = patchSlots(deny && deny.size > 0 ? stripDenied(text, deny) : text)
  const canonical = [...slots.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, slot]) => [key, slot.hash])
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32)
}
