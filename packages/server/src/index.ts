import { serve } from '@hono/node-server'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { RuntimeConfig, checkSecureBind, loadServerConfig } from './config.js'
import { openDb } from './db.js'
import { Hub } from './hub.js'
import { Llm } from './llm.js'
import { Store } from './store.js'

const dataDir = process.env.CHATROOM_DATA_DIR ?? join(homedir(), '.ai-chatroom')
mkdirSync(dataDir, { recursive: true })
const dbPath = process.env.CHATROOM_DB ?? join(dataDir, 'chatroom.db')

const here = dirname(fileURLToPath(import.meta.url))
const webDist = resolve(here, '../../web/dist')

const serverConfig = await loadServerConfig()

// Default-deny: refuse to start when exposed publicly with no authentication (P0b · F).
const bindError = checkSecureBind({
  host: serverConfig.host,
  accessPassword: serverConfig.accessPassword,
  adminPasswordHash: serverConfig.adminPasswordHash,
  allowInsecure: !!process.env.CHATROOM_ALLOW_INSECURE_BIND,
})
if (bindError) {
  console.error(bindError)
  process.exit(1)
}

const store = new Store(openDb(dbPath), { brakeAfter: serverConfig.brakeAfter })
// Mutable, persisted config shared with the app so /admin can change these at runtime.
const runtimeConfig = new RuntimeConfig(serverConfig, {
  allowInsecure: !!process.env.CHATROOM_ALLOW_INSECURE_BIND,
})
const app = createApp({
  store,
  hub: new Hub(),
  llm: Llm.fromEnv(),
  pollWindowMs: Number(process.env.CHATROOM_POLL_WINDOW_MS ?? 25_000),
  webDist: existsSync(webDist) ? webDist : undefined,
  config: runtimeConfig,
})

const port = serverConfig.port
const hostname = serverConfig.host
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`ai-chatroom server listening on http://${info.address}:${info.port}`)
  console.log(`db: ${dbPath}`)
  console.log(`web ui: ${existsSync(webDist) ? webDist : '(not built — run pnpm --filter @chatroom/web build)'}`)
  if (serverConfig.accessPassword) console.log('access password: enabled')
  if (serverConfig.adminPasswordHash) console.log('admin password: enabled (session auth mode)')
  else console.log('admin password: not set (local mode — any human participant token has admin access)')
})
