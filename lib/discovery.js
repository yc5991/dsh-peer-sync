import dgram from 'node:dgram'
import os from 'node:os'

export const PROTOCOL_TAG = 'dsh-peer-sync'

function broadcastAddresses() {
  const addresses = new Set(['255.255.255.255'])
  const interfaces = os.networkInterfaces()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const ip = entry.address.split('.').map(Number)
      const mask = (entry.netmask || '255.255.255.255').split('.').map(Number)
      if (ip.length !== 4 || mask.length !== 4) continue
      const broadcast = ip.map((octet, index) => (octet & mask[index]) | (~mask[index] & 255))
      addresses.add(broadcast.join('.'))
    }
  }
  return [...addresses]
}

/**
 * LAN discovery over UDP broadcast.
 *
 * Announcements are deliberately small and contain no secret: the peer id, the
 * HTTP port to knock on, and a token fingerprint so two machines that already
 * share a token can recognise each other without pairing again. Both a direct
 * cable (two addresses in one subnet) and a normal Wi-Fi network reach each
 * other through the subnet broadcast address.
 */
export function startDiscovery(options) {
  const {
    port,
    selfId,
    selfName,
    platform,
    httpPort,
    tokenFingerprint,
    announceMs = 10000,
    extraTargets = [],
    onBeacon,
    log,
  } = options

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  let timer = null
  let closed = false
  const seen = new Map()

  const payload = () =>
    Buffer.from(
      JSON.stringify({
        m: PROTOCOL_TAG,
        v: 1,
        id: selfId,
        name: selfName,
        platform,
        httpPort,
        fp: tokenFingerprint,
        ts: Date.now(),
      }),
    )

  const send = () => {
    if (closed) return
    const message = payload()
    for (const address of new Set([...broadcastAddresses(), ...extraTargets])) {
      try {
        socket.send(message, 0, message.length, port, address, () => {})
      } catch {
        /* one unreachable target must not stop the rest */
      }
    }
  }

  socket.on('error', (error) => {
    log?.warn(`discovery socket: ${error && error.message ? error.message : error}`)
    try {
      socket.close()
    } catch {
      /* already closed */
    }
  })

  socket.on('message', (buffer, rinfo) => {
    let beacon
    try {
      beacon = JSON.parse(buffer.toString('utf8'))
    } catch {
      return
    }
    if (!beacon || beacon.m !== PROTOCOL_TAG || beacon.v !== 1) return
    if (typeof beacon.id !== 'string' || !beacon.id || beacon.id === selfId) return
    if (typeof beacon.httpPort !== 'number' || beacon.httpPort <= 0) return
    seen.set(beacon.id, { ...beacon, address: rinfo.address, seenAt: Date.now() })
    try {
      onBeacon?.({ ...beacon, address: rinfo.address })
    } catch (error) {
      log?.warn(`discovery handler: ${error && error.message ? error.message : error}`)
    }
  })

  socket.bind(port, () => {
    try {
      socket.setBroadcast(true)
    } catch {
      /* some platforms refuse; the limited broadcast still goes out */
    }
    log?.info(`discovery on udp:${port}`)
    send()
    timer = setInterval(send, Math.max(2000, announceMs))
  })

  return {
    peers() {
      return [...seen.values()]
    },
    stop() {
      closed = true
      if (timer) clearInterval(timer)
      timer = null
      try {
        socket.close()
      } catch {
        /* already closed */
      }
    },
  }
}
