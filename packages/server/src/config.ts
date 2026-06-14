import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface ConfigFile {
  machine_id?: string
  server?: {
    access_password?: string
    port?: number
  }
  servers?: Record<string, { password?: string }>
}

function loadConfigFile(): ConfigFile {
  try {
    const path = join(homedir(), '.ai-chatroom', 'config.json')
    return JSON.parse(readFileSync(path, 'utf-8')) as ConfigFile
  } catch {
    return {}
  }
}

export interface ServerConfig {
  accessPassword: string | null
  port: number
}

export function loadServerConfig(): ServerConfig {
  const file = loadConfigFile()
  return {
    accessPassword: process.env.CHATROOM_ACCESS_PASSWORD ?? file.server?.access_password ?? null,
    port: Number(process.env.CHATROOM_PORT ?? file.server?.port ?? 8787),
  }
}
