import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>

interface ConfigFile {
  machine_id?: string
  server?: {
    access_password?: string
    /** Pre-computed owner password hash ("salt:hash" hex). Preferred over env plaintext bootstrap. */
    owner_password_hash?: string
    port?: number
    /** Bind address; defaults to 127.0.0.1 (loopback only). */
    host?: string
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
  /** Bind address. Defaults to 127.0.0.1 (loopback only). */
  host: string
  /** Scrypt hash of the owner password, stored as "salt:hash" (hex). Null means local mode (no owner password). */
  ownerPasswordHash: string | null
}

/**
 * Hash a plaintext owner password with scrypt (salted), asynchronously to avoid
 * blocking the event loop. Returns a "salt:hash" hex string suitable for storage.
 */
export async function hashOwnerPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const hash = (await scrypt(plaintext, salt, 32)).toString('hex')
  return `${salt}:${hash}`
}

/**
 * Verify a plaintext password against a stored "salt:hash" string, asynchronously.
 * Returns true if they match.
 */
export async function verifyOwnerPassword(plaintext: string, stored: string): Promise<boolean> {
  const [salt, expectedHash] = stored.split(':')
  if (!salt || !expectedHash) return false
  try {
    const actual = await scrypt(plaintext, salt, 32)
    const expected = Buffer.from(expectedHash, 'hex')
    if (actual.length !== expected.length) return false
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** True for addresses that only accept connections from the local machine. */
function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  // NB: an empty host is NOT loopback — net.Server.listen('') binds all interfaces, so it must
  // go through the default-deny check rather than being treated as safe.
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h.startsWith('127.') ||
    h === '::1' ||
    h === '[::1]'
  )
}

/**
 * Default-deny guard for public exposure (P0b · F).
 * Returns an error message string if the server must refuse to start, else null.
 *
 * Refuses when binding to a non-loopback address (e.g. 0.0.0.0, ::, or a concrete public IP)
 * with NO access password and NO owner password configured. The explicit escape hatch is
 * CHATROOM_ALLOW_INSECURE_BIND=1.
 */
export function checkSecureBind(cfg: {
  host: string
  accessPassword: string | null
  ownerPasswordHash: string | null
  allowInsecure?: boolean
}): string | null {
  if (cfg.allowInsecure) return null
  if (isLoopbackHost(cfg.host)) return null
  if (cfg.accessPassword || cfg.ownerPasswordHash) return null
  return (
    `Refusing to start: binding to non-loopback host "${cfg.host}" with no authentication is unsafe.\n` +
    `Choose one of:\n` +
    `  1. Set an owner password (server.owner_password_hash / CHATROOM_OWNER_PASSWORD_HASH / CHATROOM_OWNER_PASSWORD) and/or an access password (CHATROOM_ACCESS_PASSWORD).\n` +
    `  2. Bind to localhost instead (unset CHATROOM_HOST or set it to 127.0.0.1) and front it with a reverse proxy / TLS.\n` +
    `  3. Explicitly override with CHATROOM_ALLOW_INSECURE_BIND=1 (NOT recommended).`
  )
}

export async function loadServerConfig(): Promise<ServerConfig> {
  const file = loadConfigFile()

  // Owner password resolution, in priority order:
  //   1. Pre-computed hash (config file or CHATROOM_OWNER_PASSWORD_HASH env) — preferred, no startup hashing cost.
  //   2. Plaintext bootstrap (CHATROOM_OWNER_PASSWORD env) — hashed once at startup, plaintext never stored.
  let ownerPasswordHash: string | null =
    process.env.CHATROOM_OWNER_PASSWORD_HASH ?? file.server?.owner_password_hash ?? null
  if (!ownerPasswordHash) {
    const rawOwnerPw = process.env.CHATROOM_OWNER_PASSWORD
    if (rawOwnerPw) {
      console.warn('[auth] CHATROOM_OWNER_PASSWORD env var detected — hashing at startup. Store the hash (server.owner_password_hash or CHATROOM_OWNER_PASSWORD_HASH) instead for production use.')
      ownerPasswordHash = await hashOwnerPassword(rawOwnerPw)
    }
  }

  return {
    accessPassword: process.env.CHATROOM_ACCESS_PASSWORD ?? file.server?.access_password ?? null,
    port: Number(process.env.CHATROOM_PORT ?? file.server?.port ?? 8787),
    host: process.env.CHATROOM_HOST ?? file.server?.host ?? '127.0.0.1',
    ownerPasswordHash,
  }
}
