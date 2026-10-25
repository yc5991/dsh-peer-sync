// Standalone harness: runs one SyncEngine against a throwaway DSH home so the
// transport, merge rules and bundle reconciliation can be exercised without
// touching the real profile.
//
//   node test/peer.mjs <home> <runForMs> [label]
//
// Two services are faked:
//   - credentials: merges into that home's `.credentials.yaml` the way
//     `dsh-credentials-local` does, leaving `records` untouched;
//   - pluginManager: reads `<home>/peer-sync/bundles.json` as this machine's
//     bundle set and records every install instead of running pnpm.

import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'

const home = path.resolve(process.argv[2] || '')
const runForMs = Number(process.argv[3] || 8000)
const label = process.argv[4] || path.basename(home)

if (!home) {
  console.error('usage: node test/peer.mjs <home> <runForMs> [label]')
  process.exit(2)
}

process.env.DSH_HOME = home
process.env.DSH_PROFILE_DIR = path.join(home, 'profiles', 'desktop')

const { SyncEngine } = await import('../lib/sync.js')

const credentialsFile = path.join(home, '.credentials.yaml')
const bundlesFile = path.join(home, 'peer-sync', 'bundles.json')

const credentials = {
  async set(ref, value) {
    const current = fs.existsSync(credentialsFile)
      ? YAML.parse(fs.readFileSync(credentialsFile, 'utf8'))
      : { version: 1, refs: {}, records: {} }
    current.refs = current.refs || {}
    current.refs[ref] = value
    fs.writeFileSync(credentialsFile, YAML.stringify(current))
    console.log(`[${label}] fake credential service wrote ${ref}`)
  },
}

const installed = []

const pluginManager = {
  async listBundles() {
    const base = fs.existsSync(bundlesFile) ? JSON.parse(fs.readFileSync(bundlesFile, 'utf8')) : []
    return [...base, ...installed].map((bundle) => ({
      name: bundle.name,
      enabled: bundle.enabled !== false,
      source: bundle.source,
    }))
  },
  async installBundle(spec) {
    const name = String(spec).replace(/@[^/]*$/, '')
    installed.push({ name, enabled: true, source: spec })
    console.log(`[${label}] fake pluginManager install: ${spec}`)
    return { application: 'applied', bundle: name }
  },
}

const engine = new SyncEngine({
  // Mimic Cordis's soft service lookup so the plugin's `serviceOf` path is the
  // one under test, not a plain property read.
  get: (name) => ({ credentials, pluginManager }[name]),
  credentials,
  pluginManager,
})
await engine.start()
console.log(`[${label}] running for ${runForMs}ms`)

const until = Date.now() + runForMs
while (Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 200))

await engine.stop()
console.log(`[${label}] done`)
