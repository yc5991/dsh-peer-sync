// Simulated second machine for the discovery test: it answers the pairing
// handshake over HTTP and keeps broadcasting a beacon on the discovery port.
//
//   node test/fake-peer.mjs <httpPort> <discoveryPort> [runForMs]

import dgram from 'node:dgram'
import http from 'node:http'

const httpPort = Number(process.argv[2] || 4599)
const discoveryPort = Number(process.argv[3] || 4401)
const runForMs = Number(process.argv[4] || 12000)

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    console.log(`HTTP ${req.method} ${req.url} ${body.slice(0, 240)}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        peer: { id: 'peer-b', name: 'b', token: 'b-token', httpPort },
      }),
    )
  })
})

server.listen(httpPort, '127.0.0.1', () => console.log(`fake peer http on ${httpPort}`))

const socket = dgram.createSocket('udp4')
const beacon = Buffer.from(
  JSON.stringify({
    m: 'dsh-peer-sync',
    v: 1,
    id: 'peer-b',
    name: 'b',
    platform: 'darwin',
    httpPort,
    fp: 'deadbeef',
    ts: Date.now(),
  }),
)

const timer = setInterval(() => {
  socket.send(beacon, 0, beacon.length, discoveryPort, '127.0.0.1', () => {})
}, 1000)

setTimeout(() => {
  clearInterval(timer)
  socket.close()
  server.close()
  process.exit(0)
}, runForMs)
