import { SyncEngine } from './lib/sync.js'
import { serviceOf } from './lib/services.js'

export const name = 'peer-sync'

/**
 * The sync engine needs the credential service to write API keys through the
 * service rather than by rewriting `.credentials.yaml` (which also carries
 * machine-bound records that must never be copied between machines).
 */
export const inject = ['credentials']

/**
 * Same-origin endpoints for the settings panel.
 *
 * The peer channel is a separate listener that only speaks token auth, so the
 * browser cannot call it without the token ending up in the page. These routes
 * live on the GUI server instead: the page is already authenticated there, and
 * nothing new is exposed to the LAN. Loopback is checked anyway, because a route
 * registered on the GUI server inherits whatever that server allows.
 */
const API_PREFIX = '/api/peer-sync'

function loopbackOnly(req) {
  const address = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '')
  return address === '' || address === '127.0.0.1' || address === '::1'
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Shape of a host service, for deciding whether a feature can be built at all.
 *
 * The plugin soft-depends on services it does not inject (`sessionController`,
 * `agents`, 鈥? and their signatures differ between harness versions. Rather than
 * guess 鈥?twice now a guess cost a wrong implementation 鈥?this reports exactly
 * what the running host exposes. Read-only, loopback only, fixed allowlist.
 */
const INTROSPECTABLE = new Set(['agents', 'agentLoop', 'sessionController', 'sessionQuery', 'workspaceRegistry', 'webServer'])

function introspect(ctx, name) {
  if (!INTROSPECTABLE.has(name)) return { ok: false, reason: 'not-allowed', allowed: [...INTROSPECTABLE] }
  const service = serviceOf(ctx, name)
  if (!service) return { ok: false, reason: 'absent' }
  const keys = new Set()
  for (let object = service, depth = 0; object && depth < 4; object = Object.getPrototypeOf(object), depth += 1) {
    for (const key of Object.getOwnPropertyNames(object)) {
      if (key !== 'constructor') keys.add(key)
    }
  }
  const members = []
  for (const key of [...keys].sort()) {
    let value
    try {
      value = service[key]
    } catch (error) {
      members.push({ key, type: 'getter-threw', message: String((error && error.message) || error) })
      continue
    }
    if (typeof value === 'function') {
      members.push({ key, type: 'function', arity: value.length, async: value.constructor && value.constructor.name === 'AsyncFunction' })
    } else {
      members.push({ key, type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value })
    }
  }
  return { ok: true, service: name, members }
}

function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`invalid JSON: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

function panelApi(engine, ctx) {
  return async (req, res) => {
    try {
      if (!loopbackOnly(req)) {
        sendJson(res, 403, { ok: false, reason: 'loopback-only' })
        return
      }
      const url = new URL(req.url || '/', 'http://gui.local')
      const route = url.pathname.slice(API_PREFIX.length)

      // Rebuilt on every request: the panel must never show a stale peer state
      // just because the page was opened before the last sync pass.
      if (req.method === 'GET' && (route === '/snapshot' || route === '/snapshot/')) {
        sendJson(res, 200, { ok: true, snapshot: engine.pageSnapshot() })
        return
      }

      if (req.method === 'GET' && route === '/introspect') {
        sendJson(res, 200, introspect(ctx, url.searchParams.get('service') || ''))
        return
      }

      if (req.method === 'POST' && route === '/prompt') {
        const body = await readJsonBody(req)
        sendJson(res, 200, await engine.promptPeer(body.peer, body.sessionId, body.text, body.wait !== false, body.waitSeconds))
        return
      }

      if (req.method === 'POST' && route === '/trust') {
        const body = await readJsonBody(req)
        sendJson(res, 200, await engine.setPeerTrust(body.peer, body.trust))
        return
      }

      if (req.method === 'POST' && route === '/session/new') {
        const body = await readJsonBody(req)
        sendJson(res, 200, await engine.createSession(body.request || body || {}))
        return
      }

      if (req.method === 'POST' && route === '/session/remote') {
        const body = await readJsonBody(req)
        sendJson(res, 200, await engine.remoteCreateSession(body.peer, body.request || body || {}))
        return
      }

      if (req.method === 'POST' && route === '/session/archive') {
        const body = await readJsonBody(req)
        sendJson(res, 200, await engine.archiveSession(body.sessionId))
        return
      }

      sendJson(res, 404, { ok: false, reason: 'unknown-route' })
    } catch (error) {
      engine.log.warn(`panel api ${req.method} ${req.url} failed: ${error && error.message ? error.message : error}`)
      sendJson(res, 500, { ok: false, reason: 'handler-failed', message: error && error.message ? error.message : String(error) })
    }
  }
}

export function apply(ctx) {
  // `ctx.effect` is what makes the disposer authoritative: on profile
  // recomposition the old engine stops 鈥?and releases its listening socket 鈥?  // before a new one starts.
  ctx.effect(() => {
    const engine = new SyncEngine(ctx)
    engine.start().catch((error) => {
      engine.log.error(`start failed: ${error && error.message ? error.message : error}`)
    })

    // The settings tab reads one snapshot; the page carries it because the
    // Desktop shell may not share the web server's origin with the panel.
    const webServer = serviceOf(ctx, 'webServer')
    let untap = null
    if (webServer && typeof webServer.tapIndex === 'function') {
      try {
        untap = webServer.tapIndex((html) => engine.injectSnapshot(html))
      } catch (error) {
        engine.log.warn(`cannot inject the settings snapshot: ${error && error.message ? error.message : error}`)
      }
    }

    // The panel's write path: send a message to a peer session, change trust.
    let unroute = null
    if (webServer && typeof webServer.register === 'function') {
      try {
        unroute = webServer.register({ kind: 'prefix', path: API_PREFIX, handler: panelApi(engine, ctx) })
      } catch (error) {
        engine.log.warn(`cannot register the panel api: ${error && error.message ? error.message : error}`)
      }
    }

    return async () => {
      if (typeof unroute === 'function') unroute()
      if (typeof untap === 'function') untap()
      await engine.stop()
    }
  })
}

