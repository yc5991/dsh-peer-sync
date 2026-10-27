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

/** WebDAV clients send the token as the Basic password; the username is ignored. */
function basicAuthorized(req, token) {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return false
  try {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8')
    const separator = decoded.indexOf(':')
    if (separator < 0) return false
    return constantTimeEqual(decoded.slice(separator + 1), token)
  } catch {
    return false
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
  const { host, port, token, self, version, build, snapshot, advertise, readSession, find, status, apply, pair, webdav, log } = options

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url || '/', 'http://peer.local')
        const peer = typeof req.headers['x-peer-name'] === 'string' ? req.headers['x-peer-name'] : undefined

        // WebDAV is mounted by the operating system, which authenticates with
        // HTTP Basic: the password is this machine's peer token.
        if (url.pathname === '/dav' || url.pathname.startsWith('/dav/')) {
          if (!webdav) {
            send(res, 404, { ok: false, reason: 'dav-disabled' })
            return
          }
          if (!basicAuthorized(req, token)) {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dsh-peer-sync"', 'content-length': 0 })
            res.end()
            return
          }
          await webdav.handle(req, res, url.pathname)
          return
        }

        // Pairing is the one route without a token: the caller does not have one
        // yet. It is guarded by the pairing policy instead.
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

        if (!constantTimeEqual(presentedToken(req), token)) {
          send(res, 401, { ok: false, reason: 'unauthorized' })
          return
        }

        if (req.method === 'GET' && url.pathname === '/v1/hello') {
          send(res, 200, {
            ok: true,
            peer: self,
            version,
            build,
            time: Date.now(),
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
