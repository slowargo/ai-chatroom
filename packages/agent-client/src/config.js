import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export const CONFIG_DIR = join(homedir(), '.ai-chatroom')
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

export function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

export function saveConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 })
}

/**
 * Generate and persist a machine_id if one does not already exist.
 * Only call this from the `init` command — read-only commands must not write files.
 */
export function ensureMachineId() {
  const config = loadConfig()
  if (config.machine_id) return config.machine_id
  const suffix = randomBytes(2).toString('hex')
  const id = `${userInfo().username}@${hostname()}-${suffix}`
  config.machine_id = id
  saveConfig(config)
  return id
}

/**
 * Look up the stored password for a given server URL.
 * Matches on host:port from the URL.
 */
export function getPasswordForServer(serverUrl) {
  try {
    const u = new URL(serverUrl)
    const key = u.host // e.g. "localhost:8787"
    const config = loadConfig()
    return config.servers?.[key]?.password ?? null
  } catch {
    return null
  }
}
