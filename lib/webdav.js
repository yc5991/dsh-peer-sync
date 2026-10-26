import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * A small WebDAV server over the existing peer channel.
 *
 * macOS mounts it with the system WebDAV client (`mount_webdav`), so the point
 * is to satisfy exactly what that client needs: OPTIONS advertising DAV 1/2,
 * PROPFIND with Depth 0/1, read/write methods, MOVE/COPY/MKCOL, and LOCK/UNLOCK
 * (WebDAVFS refuses to write to a share that cannot lock).
 *
 * Auth is the peer token: HTTP Basic with any username and the token as the
 * password. There is no account on the machine, which is the whole reason this
 * exists instead of SMB.
 */

const XML_HEADER = '<?xml version="1.0" encoding="utf-8"?>'

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function httpDate(date) {
  return new Date(date).toUTCString()
}

function etagOf(stat) {
  return `"${crypto.createHash('sha1').update(`${stat.size}-${stat.mtimeMs}`).digest('hex').slice(0, 16)}"`
}

function responseXml({ href, isDir, stat }) {
  const type = isDir ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>'
  const size = isDir ? '' : `<D:getcontentlength>${stat.size}</D:getcontentlength>`
  return [
    '<D:response>',
    `<D:href>${xmlEscape(href)}</D:href>`,
    '<D:propstat>',
    '<D:prop>',
    type,
    size,
    `<D:getlastmodified>${httpDate(stat.mtime)}</D:getlastmodified>`,
    `<D:getetag>${xmlEscape(etagOf(stat))}</D:getetag>`,
    '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope>',
    '<D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>',
    '</D:prop>',
    '<D:status>HTTP/1.1 200 OK</D:status>',
    '</D:propstat>',
    '</D:response>',
  ].join('')
}

function lockXml(token) {
  return `${XML_HEADER}<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>` +
    `<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope>` +
    `<D:depth>infinity</D:depth><D:timeout>Second-3600</D:timeout>` +
    `<D:locktoken><D:href>${xmlEscape(token)}</D:href></D:locktoken>` +
    `</D:activelock></D:lockdiscovery></D:prop>`
}

function send(res, status, body, headers) {
  const payload = body == null ? '' : body
  res.writeHead(status, {
    'content-length': Buffer.byteLength(payload),
    ...(headers || {}),
  })
  res.end(payload)
}

function xml(res, status, body) {
  send(res, status, body, { 'content-type': 'application/xml; charset=utf-8' })
}

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function destinationPath(req) {
  const header = req.headers.destination
  if (typeof header !== 'string' || !header) return null
  try {
    const url = new URL(header, 'http://peer.local')
    return decodeURIComponent(url.pathname)
  } catch {
    return null
  }
}

export function createWebdav(options) {
  const { root, log, maxBytes = 512 * 1024 * 1024 } = options
  const base = path.resolve(root)
  const locks = new Map()

  /** Map a request path to a filesystem path, refusing anything outside the root. */
  function resolve(requestPath) {
    let relative
    try {
      relative = decodeURIComponent(String(requestPath || '').replace(/^\/dav\/?/, ''))
    } catch {
      return null
    }
    const target = path.resolve(base, relative)
    if (target !== base && !target.startsWith(base + path.sep)) return null
    return target
  }

  function hrefOf(target) {
    const relative = path.relative(base, target).split(path.sep).map(encodeURIComponent).join('/')
    return `/dav${relative ? `/${relative}` : '/'}`
  }

  function statOf(target) {
    try {
      return fs.statSync(target)
    } catch {
      return null
    }
  }

  async function handle(req, res, requestPath) {
    const method = String(req.method || '').toUpperCase()
    const target = resolve(requestPath)
    if (!target) {
      send(res, 403, 'forbidden')
      return true
    }

    if (method === 'OPTIONS') {
      send(res, 200, '', {
        DAV: '1, 2',
        Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND, PROPPATCH, COPY, MOVE, LOCK, UNLOCK',
        'MS-Author-Via': 'DAV',
      })
      return true
    }

    if (method === 'PROPFIND') {
      const stat = statOf(target)
      if (!stat) {
        send(res, 404, 'not found')
        return true
      }
      const depth = String(req.headers.depth || '1')
      const parts = [responseXml({ href: hrefOf(target), isDir: stat.isDirectory(), stat })]
      if (stat.isDirectory() && depth !== '0') {
        let entries = []
        try {
          entries = fs.readdirSync(target, { withFileTypes: true })
        } catch {
          entries = []
        }
        for (const entry of entries) {
          const child = path.join(target, entry.name)
          const childStat = statOf(child)
          if (!childStat) continue
          parts.push(responseXml({ href: hrefOf(child), isDir: childStat.isDirectory(), stat: childStat }))
        }
      }
      xml(res, 207, `${XML_HEADER}<D:multistatus xmlns:D="DAV:">${parts.join('')}</D:multistatus>`)
      return true
    }

    if (method === 'GET' || method === 'HEAD') {
      const stat = statOf(target)
      if (!stat || stat.isDirectory()) {
        send(res, stat ? 405 : 404, stat ? 'is a collection' : 'not found')
        return true
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': stat.size,
        'last-modified': httpDate(stat.mtime),
        etag: etagOf(stat),
        'accept-ranges': 'none',
      })
      if (method === 'HEAD') {
        res.end()
        return true
      }
      fs.createReadStream(target).pipe(res)
      return true
    }

    if (method === 'PUT') {
      const parent = path.dirname(target)
      if (target === base || !statOf(parent)) {
        send(res, 409, 'no parent collection')
        return true
      }
      const existed = Boolean(statOf(target))
      try {
        const body = await readBody(req, maxBytes)
        const temp = `${target}.dav-${process.pid}-${Date.now()}.tmp`
        fs.writeFileSync(temp, body)
        fs.renameSync(temp, target)
      } catch (error) {
        log?.warn(`dav put ${requestPath}: ${error && error.message ? error.message : error}`)
        send(res, 507, 'write failed')
        return true
      }
      send(res, existed ? 204 : 201, '')
      return true
    }

    if (method === 'MKCOL') {
      if (statOf(target)) {
        send(res, 405, 'exists')
        return true
      }
      try {
        fs.mkdirSync(target, { recursive: false })
      } catch {
        send(res, 409, 'no parent collection')
        return true
      }
      send(res, 201, '')
      return true
    }

    if (method === 'DELETE') {
      if (!statOf(target) || target === base) {
        send(res, 404, 'not found')
        return true
      }
      try {
        fs.rmSync(target, { recursive: true, force: true })
      } catch {
        send(res, 500, 'delete failed')
        return true
      }
      send(res, 204, '')
      return true
    }

    if (method === 'MOVE' || method === 'COPY') {
      const destination = resolve(destinationPath(req) || '')
      if (!destination || destination === base) {
        send(res, 400, 'bad destination')
        return true
      }
      const source = statOf(target)
      if (!source) {
        send(res, 404, 'not found')
        return true
      }
      const existed = Boolean(statOf(destination))
      try {
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        if (method === 'MOVE') {
          fs.rmSync(destination, { recursive: true, force: true })
          fs.renameSync(target, destination)
        } else if (source.isDirectory()) {
          fs.cpSync(target, destination, { recursive: true })
        } else {
          fs.copyFileSync(target, destination)
        }
      } catch (error) {
        log?.warn(`dav ${method.toLowerCase()} ${requestPath}: ${error && error.message ? error.message : error}`)
        send(res, 409, 'operation failed')
        return true
      }
      send(res, existed ? 204 : 201, '')
      return true
    }

    if (method === 'PROPPATCH') {
      xml(
        res,
        207,
        `${XML_HEADER}<D:multistatus xmlns:D="DAV:"><D:response><D:href>${xmlEscape(hrefOf(target))}</D:href>` +
          '<D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>',
      )
      return true
    }

    if (method === 'LOCK') {
      const token = `opaquelocktoken:${crypto.randomUUID()}`
      locks.set(hrefOf(target), token)
      res.setHeader('Lock-Token', `<${token}>`)
      xml(res, 200, lockXml(token))
      return true
    }

    if (method === 'UNLOCK') {
      locks.delete(hrefOf(target))
      send(res, 204, '')
      return true
    }

    send(res, 405, 'method not allowed')
    return true
  }

  return { handle, root: base, locks }
}
