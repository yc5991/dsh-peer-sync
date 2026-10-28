// One-command health check for a peer-sync install.
//
// Everything here is read-only against the peer; the only mutations are a
// throwaway session on *this* machine, created and archived again, because the
// delivery path cannot be proven without one. Exit code 1 if anything fails, so
// it can be run by hand or from a script.
//
//   node test/smoke.mjs [--peer]

import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const withPeer = args.includes('--peer')

const home = process.env.USERPROFILE || process.env.HOME || ''
const configPath = path.join(home, '.dsh', 'peer-sync', 'config.json')
const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''))
const listen = `http://${config.listen.host}:${config.listen.port}`
const token = config.token
const peer = Array.isArray(config.peers) ? config.peers[0] : null

// Both adverts are opt-in per machine. The first run on the other machine exited 1
// because it treats "this machine publishes nothing on purpose" as a failure, which
// contradicted the documented meaning of the switch.
const bundlesOn = !(config.sync && config.sync.bundles === false)
const sessionsOn = Boolean((config.share && config.share.sessions) || (config.sync && config.sync.sessions))

const rows = []
const add = (name, ok, detail) => {
  rows.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail || ''}`)
}
// A peer that deliberately publishes nothing is not broken — but the difference
// between "nothing to sync" and "nothing published" has to be visible, because
// the panel cannot tell them apart either.
let warnings = 0
const warn = (name, detail) => {
  warnings += 1
  console.log(`${'WARN'.padEnd(4)}  ${name.padEnd(34)} ${detail || ''}`)
}

const call = async (base, route, init, peerToken) => {
  const response = await fetch(base + route, {
    ...(init || {}),
    headers: { 'x-peer-token': peerToken || token, 'content-type': 'application/json', ...((init && init.headers) || {}) },
  })
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text.slice(0, 120) }
  }
  return { status: response.status, body }
}

const post = (route, payload) => call(listen, route, { method: 'POST', body: JSON.stringify(payload) })

const run = async () => {
  // 1. This machine answers at all, and says which code it runs.
  try {
    const hello = await call(listen, '/v1/hello')
    add('local hello', hello.status === 200 && hello.body.ok === true, `build ${hello.body.build || '?'} pid ${hello.body.diag ? hello.body.diag.pid : '?'}`)
    const ownBundles = Array.isArray(hello.body.bundles) ? hello.body.bundles.length : 0
    const ownSessions = Array.isArray(hello.body.sessions) ? hello.body.sessions.length : 0
    if (ownBundles > 0) add('local publishes bundles', true, `${ownBundles} bundles`)
    else if (!bundlesOn) warn('local publishes bundles', 'sync.bundles is off here on purpose (opt-in), so nothing is published')
    else add('local publishes bundles', false, 'nothing published while sync.bundles is on')
    if (ownSessions > 0) add('local publishes sessions', true, `${ownSessions} sessions`)
    else if (!sessionsOn) warn('local publishes sessions', 'share.sessions is off here on purpose (opt-in)')
    else add('local publishes sessions', false, 'nothing published while share.sessions is on')
  } catch (error) {
    add('local hello', false, error.message)
    return
  }

  try {
    const status = await call(listen, '/v1/status')
    const units = status.body && status.body.status ? status.body.status.units : []
    add('local status', status.status === 200, `${Array.isArray(units) ? units.length : '?'} units`)
  } catch (error) {
    add('local status', false, error.message)
  }

  // 2. The session lifecycle on this machine: create, deliver, answer, archive, restore.
  let sessionId = null
  try {
    const created = await post('/v1/remote/session', { request: {} })
    sessionId = created.body && created.body.sessionId
    add('create session', Boolean(sessionId), created.body && (created.body.title || sessionId))
  } catch (error) {
    add('create session', false, error.message)
  }

  if (sessionId) {
    try {
      const sent = await post('/v1/remote/prompt', {
        sessionId,
        text: '只回复这一行，不要调用任何工具：SMOKE-OK',
        wait: true,
        waitSeconds: 90,
      })
      const answered = sent.body && sent.body.replied === true
      add('deliver and answer', answered, answered ? `${sent.body.waitedMs}ms "${String(sent.body.reply).slice(0, 20)}"` : sent.body && sent.body.reason)
      if (!answered) {
        // A turn that never answered still has to be stoppable, or the session is
        // stuck forever — that is exactly what /v1/remote/cancel is for.
        const cancelled = await post('/v1/remote/cancel', { sessionId })
        add('cancel stuck turn', cancelled.body && cancelled.body.ok === true, cancelled.body && (cancelled.body.reason || 'accepted'))
        await new Promise((r) => setTimeout(r, 2500))
      }
    } catch (error) {
      add('deliver and answer', false, error.message)
    }

    try {
      const archived = await post('/v1/remote/session/archive', { sessionId })
      add('archive session', archived.body && archived.body.ok === true, archived.body && String(archived.body.archived))
      const restored = await post('/v1/remote/session/unarchive', { sessionId })
      add('unarchive session', restored.body && restored.body.ok === true, restored.body && String(restored.body.archived))
      await post('/v1/remote/session/archive', { sessionId })
    } catch (error) {
      add('archive session', false, error.message)
    }
  }

  // 3. The peer, read-only.
  if (withPeer && peer) {
    try {
      const hello = await call(peer.url, '/v1/hello', undefined, peer.token)
      const ok = hello.status === 200 && hello.body.ok === true
      const diag = hello.body && hello.body.diag
      add('peer hello', ok, ok ? `build ${hello.body.build}${diag ? ` up ${Math.round(diag.uptimeMs / 60000)}m` : ''}` : `http ${hello.status}`)
      const sessions = (hello.body && hello.body.sessions) || []
      const bundles = (hello.body && hello.body.bundles) || []
      if (Array.isArray(sessions) && sessions.length > 0) add('peer advertises sessions', true, `${sessions.length} sessions`)
      else warn('peer advertises sessions', 'none: its share.sessions is off, or it has no sessions')
      if (Array.isArray(bundles) && bundles.length > 0) {
        const off = bundles.filter((bundle) => bundle && bundle.enabled === false).length
        add('peer advertises bundles', true, `${bundles.length} bundles, ${off} disabled`)
      } else {
        warn('peer advertises bundles', 'none: its sync.bundles is off, so the panel has no diff to show')
      }
      if (hello.body && !hello.body.diag) warn('peer load fingerprint', 'peer build predates 0.8.7: uptime/pid unknown')
    } catch (error) {
      add('peer hello', false, error.message)
    }
  }

  // 4. The peer projects this machine registered on a mount, when it is configured
  //    to have any. A workspace whose path no longer resolves opens onto nothing,
  //    which is worth failing over.
  const remoteConfigured = Boolean(config.remoteWorkspaces && config.remoteWorkspaces.register === true)
  if (remoteConfigured) {
    try {
      // The panel block lives in the status file, which every tick rewrites.
      const statusPath = path.join(home, '.dsh', 'peer-sync', 'status.json')
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf8').replace(/^\uFEFF/, ''))
      const list = Array.isArray(status.remoteWorkspaces) ? status.remoteWorkspaces : []
      if (list.length > 0) {
        const broken = list.filter((item) => item && item.reachable === false)
        add(
          'peer projects registered',
          broken.length === 0,
          `${list.length} workspace(s)${broken.length ? `, unreachable: ${broken.map((item) => item.title).join(', ')}` : ''}`,
        )
      } else {
        warn('peer projects registered', 'remoteWorkspaces is on but nothing matched a mount (does the peer advertise sessions?)')
      }
    } catch (error) {
      add('peer projects registered', false, error.message)
    }
  }

  const failed = rows.filter((row) => !row.ok).length
  const suffix = withPeer ? '' : ' (peer skipped: run with --peer)'
  console.log(`\n${rows.length - failed}/${rows.length} checks passed${suffix}${warnings > 0 ? `, ${warnings} warning(s)` : ''}`)
  process.exitCode = failed === 0 ? 0 : 1
}

run().catch((error) => {
  console.error('smoke test crashed:', error && error.message ? error.message : error)
  process.exitCode = 1
})
