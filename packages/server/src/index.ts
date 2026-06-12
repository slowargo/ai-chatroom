import { serve } from '@hono/node-server'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { openDb } from './db.js'
import { Hub } from './hub.js'
import { Llm } from './llm.js'
import { Store } from './store.js'

const dataDir = process.env.CHATROOM_DATA_DIR ?? join(homedir(), '.ai-chatroom')
mkdirSync(dataDir, { recursive: true })
const dbPath = process.env.CHATROOM_DB ?? join(dataDir, 'chatroom.db')

const here = dirname(fileURLToPath(import.meta.url))
const webDist = resolve(here, '../../web/dist')

const store = new Store(openDb(dbPath), {
  brakeAfter: Number(process.env.CHATROOM_BRAKE_AFTER ?? 3),
})
const app = createApp({
  store,
  hub: new Hub(),
  llm: Llm.fromEnv(),
  pollWindowMs: Number(process.env.CHATROOM_POLL_WINDOW_MS ?? 25_000),
  webDist: existsSync(webDist) ? webDist : undefined,
})

const port = Number(process.env.CHATROOM_PORT ?? 8787)
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`ai-chatroom server listening on http://localhost:${info.port}`)
  console.log(`db: ${dbPath}`)
  console.log(`web ui: ${existsSync(webDist) ? webDist : '(not built — run pnpm --filter @chatroom/web build)'}`)
})
