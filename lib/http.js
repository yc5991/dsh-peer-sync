import crypto from 'node:crypto'
import http from 'node:http'

export const MAX_BODY_BYTES = 2 * 1024 * 1024

function constantTimeEqual(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected.length === 0) return false
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * WebDAV clients send the credential as the Basic password; the username is
 * ignored. Which credentials are acceptable is decided by the caller, so a
 * per-peer key works as a mount password and revoking a peer also kills its
 * mount.
 */
function basicCredential(req) {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return ''
  try {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8')
    const separator = decoded.indexOf(':')
    return separator < 0 ? '' : decoded.slice(separator + 1)
  } catch {
    return ''
  }
}

function presentedToken(req) {  const header = req.headers['x-peer-token']
  if (typeof header === 'string' && header) return header
  const authorization = req.headers.authorization
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim()
  }
  return ''
}

/**
 * The peer transport. Deliberately a separate listener rather than a route on
 * the harness web server: the GUI must stay on loopback, while this one binds
 * the direct-link interface and speaks a token-authenticated protocol of its own.
 */
export function startServer(options) {
  const { host, port, token, self, version, build, diagnose, snapshot, advertise, readSession, find, status, apply, pair, webdav, authorize, peerTrust, log } = options
  // Default keeps the module usable stand-alone (tests); the plugin always
  // passes its own, which also accepts the per-peer keys.
  const accepts = typeof authorize === 'function' ? authorize : (presented) => constantTimeEqual(presented, token)

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url || '/', 'http://peer.local')
        const peer = typeof req.headers['x-peer-name'] === 'string' ? req.headers['x-peer-name'] : undefined

        // WebDAV is mounted by the operating system, which authenticates with
        // HTTP Basic: the password is a credential this machine accepts.
        if (url.pathname === '/dav' || url.pathname.startsWith('/dav/')) {
          if (!webdav) {
            send(res, 404, { ok: false, reason: 'dav-disabled' })
            return
          }
          const credential = basicCredential(req)
          if (!accepts(credential)) {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dsh-peer-sync"', 'content-length': 0 })
            res.end()
            return
          }
          // A mount held by a revoked peer is refused here too, not just at the
          // protocol routes: the mount is the same machine doing the same reads.
          if (peerTrust && peerTrust(credential) === 'revoked') {
            send(res, 403, { ok: false, reason: 'peer-revoked' })
            return
          }
          await webdav.handle(req, res, url.pathname)
          return
        }

        // Pairing is the one route without a credential: the caller does not have
        // one yet. It is guarded by the pairing policy instead.
        if (req.method === 'POST' && url.pathname === '/v1/pair') {
          if (!pair) {
            send(res, 404, { ok: false, reason: 'pairing-disabled' })
            return
          }
          const body = await readJson(req)
          const answer = await pair(body || {}, req.socket.remoteAddress || '')
          send(res, answer && answer.ok ? 200 : 403, answer)
          return
        }

        if (!accepts(presentedToken(req))) {
          send(res, 401, { ok: false, reason: 'unauthorized' })
          return
        }

        // A revoked peer still holds a valid token, so authorization and trust
        // are separate questions and both have to pass.
        if (peerTrust && peerTrust(presentedToken(req)) === 'revoked') {
          send(res, 403, { ok: false, reason: 'peer-revoked' })
          return
        }

        if (req.method === 'GET' && url.pathname === '/v1/hello') {
          send(res, 200, {
            ok: true,
            peer: self,
            version,
            build,
            time: Date.now(),
            // Which file and process is answering: `build` alone cannot tell a
            // fresh module from a cached one, and that difference cost an hour
            // twice. Everything here is for the operator, not for the protocol.
            diag: typeof diagnose === 'function' ? diagnose() : null,
            units: await snapshot(),
            // Advisory only: the receiving side decides whether to act on it.
            ...(advertise ? await advertise() : {}),
          })
          return
        }

        if (req.method === 'GET' && url.pathname === '/v1/session') {
          if (!readSession) {
            send(res, 404, { ok: false, reason: 'sessions-disabled' })
            return
          }
          const id = url.searchParams.get('id') || ''
          const session = await readSession(id)
          if (!session) {
            send(res, 404, { ok: false, reason: 'unknown-session' })
            return
          }
          send(res, 200, { ok: true, ...session })
          return
        }

        if (req.method === "GET" && url.pathname === "/v1/remote/result") {
          const answer = await options.remoteResult(url.searchParams.get("sessionId") || "")
          send(res, answer && answer.ok ? 200 : 403, answer)
          return
        }

        if (req.method === "POST" && url.pathname === "/v1/remote/session/unarchive") {
          const body = await readJson(req)
          const answer = await options.remoteUnarchive(body || {})
          send(res, answer && answer.ok ? 200 : 403, answer)
          return
        }

        if (req.method === "POST" && url.pathname === "/v1/remote/session/archive") {
          const body = await readJson(req)
          const answer = await options.remoteArchive(body || {})
          send(res, answer && answer.ok ? 200 : 403, answer)
          return
        }

        if (req.method === "POST" && url.pathname === "/v1/remote/cancel") {
          const body = await readJson(req)
          const answer = await options.remoteCancel(body || {})
          send(res, answer && answer.ok ? 200 : 403, answer)
          return
        }

        if (req.method === "POST" && url.pathname === "/v1/remote/session") {
          const body = await readJson(req)
          const answer = await options.remoteSession(body || {})
          send(res, answer && answer.ok ? 200 : 403, answer)
          return
        }

        if (req.method === "POST" && url.pathname === "/v1/remote/prompt") {
          const body = await readJson(req)
          const answer = await options.remotePrompt(body && body.sessionId, body && body.text, body && body.wait, body && body.waitSeconds)
          send(res, answer && answer.ok ? 200 : 403, answer)
          return
        }

        if (req.method === "GET" && url.pathname === "/v1/session/page") {
          const answer = await options.readSessionPage(url.searchParams.get("id") || "", url.searchParams.get("beforeSeq"), url.searchParams.get("max"), url.searchParams.get("throughSeq"))
          send(res, answer && answer.ok ? 200 : 403, answer)
          return
        }

        if (req.method === 'GET' && url.pathname === '/v1/unit') {
          const id = url.searchParams.get('id') || ''
          const unit = await find(id)
          if (!unit) {
            send(res, 404, { ok: false, reason: 'unknown-unit' })
            return
          }
          send(res, 200, { ok: true, id: unit.id, kind: unit.kind, hash: unit.hash, text: unit.text })
          return
        }

        if (req.method === 'GET' && url.pathname === '/v1/status') {
          send(res, 200, { ok: true, peer: self, version, build, status: await status() })
          return
        }

        if (req.method === 'POST' && url.pathname === '/v1/apply') {
          const body = await readJson(req)
          if (!body || typeof body !== 'object') {
            send(res, 400, { ok: false, reason: 'invalid-body' })
            return
          }
          const result = await apply({ ...body, from: body.from || peer })
          send(res, result && result.ok ? 200 : 409, result)
          return
        }

        send(res, 404, { ok: false, reason: 'not-found' })
      } catch (error) {
        log?.warn(`request ${req.method} ${req.url} failed: ${error && error.message ? error.message : error}`)
        send(res, 500, { ok: false, reason: 'error', message: String(error && error.message ? error.message : error) })
      }
    })()
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

/** Close every socket so a reload does not leave the port bound. */
export function stopServer(server) {
  return new Promise((resolve) => {
    if (!server) {
      resolve()
      return
    }
    try {
      server.closeAllConnections?.()
      server.close(() => resolve())
    } catch {
      resolve()
    }
  })
}
