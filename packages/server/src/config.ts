import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
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
    /** mute agent-to-agent mentions after this many consecutive agent messages */
    brake_after?: number
  }
  servers?: Record<string, { password?: string }>
}

/** Absolute path of the user config file. Kept homedir-based (NOT CHATROOM_DATA_DIR) so reads and writes agree. */
function configPath(): string {
  return join(homedir(), '.ai-chatroom', 'config.json')
}

function loadConfigFile(): ConfigFile {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf-8')) as ConfigFile
  } catch {
    return {}
  }
}

/**
 * Persist changed `server.*` fields back to config.json (read-merge-write).
 * Preserves unknown fields (machine_id, servers, …) and any server.* keys not being changed.
 * Pass a field value of `undefined` to delete that key (e.g. disabling the access password).
 *
 * NOTE: this is read-merge-write and NOT atomic against *external* concurrent modification (e.g. a
 * CLI tool editing config.json at the same instant) — last writer wins. The server itself is the sole
 * intended writer and runs single-threaded, so in-process calls cannot interleave; the cross-process
 * race is accepted given the single-operator deployment model.
 */
function writeServerConfigFields(fields: Partial<NonNullable<ConfigFile['server']>>): void {
  const current = loadConfigFile()
  const server: Record<string, unknown> = { ...current.server }
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) delete server[k]
    else server[k] = v
  }
  const next: ConfigFile = { ...current, server: server as ConfigFile['server'] }
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', 'utf-8')
}

export interface ServerConfig {
  accessPassword: string | null
  port: number
  /** Bind address. Defaults to 127.0.0.1 (loopback only). */
  host: string
  /** Scrypt hash of the owner password, stored as "salt:hash" (hex). Null means local mode (no owner password). */
  ownerPasswordHash: string | null
  /** mute agent-to-agent mentions after this many consecutive agent messages */
  brakeAfter: number
  /**
   * Which fields are pinned by an environment variable. A pinned field cannot be changed from the
   * admin UI (the env wins on restart, so a runtime write to config.json would silently no-op).
   */
  envPinned: {
    ownerPasswordHash: boolean
    accessPassword: boolean
    brakeAfter: boolean
  }
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
  // owner password is env-pinned when it comes from an env var (pre-hashed or plaintext bootstrap),
  // not from config.json — in that case the admin UI must not offer to change it.
  const ownerEnvPinned = !!(process.env.CHATROOM_OWNER_PASSWORD_HASH || process.env.CHATROOM_OWNER_PASSWORD)
  let ownerPasswordHash: string | null =
    process.env.CHATROOM_OWNER_PASSWORD_HASH ?? file.server?.owner_password_hash ?? null
  if (!ownerPasswordHash) {
    const rawOwnerPw = process.env.CHATROOM_OWNER_PASSWORD
    if (rawOwnerPw) {
      console.warn('[auth] CHATROOM_OWNER_PASSWORD env var detected — hashing at startup. Store the hash (server.owner_password_hash or CHATROOM_OWNER_PASSWORD_HASH) instead for production use.')
      ownerPasswordHash = await hashOwnerPassword(rawOwnerPw)
    }
  }

  // An empty-string env var means "unset", not "set to empty". Otherwise it would pin a degenerate
  // value the admin UI then refuses to fix: CHATROOM_ACCESS_PASSWORD="" → gate off yet env-pinned;
  // CHATROOM_BRAKE_AFTER="" → Number('')=0 → brake engages on the very first agent message.
  const accessEnv = process.env.CHATROOM_ACCESS_PASSWORD || undefined
  const brakeEnv = process.env.CHATROOM_BRAKE_AFTER || undefined
  const accessEnvPinned = accessEnv !== undefined
  const brakeEnvPinned = brakeEnv !== undefined

  return {
    accessPassword: accessEnv ?? file.server?.access_password ?? null,
    port: Number(process.env.CHATROOM_PORT ?? file.server?.port ?? 8787),
    host: process.env.CHATROOM_HOST ?? file.server?.host ?? '127.0.0.1',
    ownerPasswordHash,
    brakeAfter: Number(brakeEnv ?? file.server?.brake_after ?? 3),
    envPinned: {
      ownerPasswordHash: ownerEnvPinned,
      accessPassword: accessEnvPinned,
      brakeAfter: brakeEnvPinned,
    },
  }
}

/**
 * Mutable, persisted server config shared across the app.
 *
 * Holds the runtime-changeable knobs (owner password hash, access password, brake threshold) behind
 * getters so middleware/handlers always observe the current value rather than a startup snapshot.
 * Setters persist to config.json. Immutable startup facts (host, allowInsecure, env-pinned flags) are
 * kept here too so the access-gate guard can mirror the startup checkSecureBind rule.
 */
export class RuntimeConfig {
  private _ownerPasswordHash: string | null
  private _accessPassword: string | null
  private _brakeAfter: number
  readonly host: string
  readonly allowInsecure: boolean
  readonly envPinned: ServerConfig['envPinned']
  /** How changed fields are persisted; defaults to writing config.json. Injectable so tests stay file-free. */
  private readonly persist: (fields: Partial<NonNullable<ConfigFile['server']>>) => void

  constructor(
    cfg: ServerConfig,
    opts: { allowInsecure: boolean; persist?: (fields: Partial<NonNullable<ConfigFile['server']>>) => void },
  ) {
    this._ownerPasswordHash = cfg.ownerPasswordHash
    this._accessPassword = cfg.accessPassword
    this._brakeAfter = cfg.brakeAfter
    this.host = cfg.host
    this.allowInsecure = opts.allowInsecure
    this.envPinned = cfg.envPinned
    this.persist = opts.persist ?? writeServerConfigFields
  }

  get ownerPasswordHash(): string | null {
    return this._ownerPasswordHash
  }
  get accessPassword(): string | null {
    return this._accessPassword
  }
  get brakeAfter(): number {
    return this._brakeAfter
  }

  /** Persist a new owner password hash. Caller must reject when envPinned.ownerPasswordHash. */
  setOwnerPasswordHash(hash: string): void {
    this._ownerPasswordHash = hash
    this.persist({ owner_password_hash: hash })
  }

  /** Enable/disable/change the access password. `null` disables the gate. Caller must guard secure-bind + envPinned. */
  setAccessPassword(pw: string | null): void {
    this._accessPassword = pw && pw.length > 0 ? pw : null
    this.persist({ access_password: this._accessPassword ?? undefined })
  }

  setBrakeAfter(n: number): void {
    this._brakeAfter = n
    this.persist({ brake_after: n })
  }
}
