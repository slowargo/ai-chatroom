export interface Room {
  id: string
  title: string
  title_auto?: number
  cwd?: string | null
  machine_id?: string | null
  created_at: string
  last_seq: number
}

export interface Persona {
  id: string
  name: string
  system_prompt: string
}

export interface Member {
  uid: string
  nickname: string
  type: 'human' | 'agent'
  role?: 'owner' | 'member' | 'agent'
  persona_name: string | null
  online: boolean
  status: 'idle' | 'thinking' | 'waiting_human'
}

export interface ChatEvent {
  seq: number
  msg_id: string
  sender_uid: string | null
  kind: 'message' | 'member_joined' | 'member_left' | 'system' | 'room_updated' | 'room_deleted' | 'nickname_changed'
  text: string | null
  in_reply_to: string | null
  mentions: string[]
  muted: boolean
  payload: Record<string, unknown> | null
  created_at: string
}

export interface Identity {
  uid: string
  token: string
  nickname: string
}

export interface PendingJoin {
  request_id: string
  room_id: string
  nickname_requested: string
  persona_id?: string
  persona_name?: string | null
  created_at: number
  status: 'pending' | 'approved' | 'rejected'
  assigned_uid?: string
  assigned_nickname?: string
  token?: string
  reason?: string
}

export interface LlmInfo {
  enabled: boolean
  provider: string | null
  model: string | null
  models: string[]
}

/** One admin session (login device) as returned by /api/auth/sessions (token never exposed). */
export interface SessionInfo {
  id: string
  created_at: string
  last_used_at: string
  label: string
  /** true for the session whose token the caller is using */
  current: boolean
}

/** Admin settings view (/api/admin/settings). `env_pinned` fields cannot be changed from the UI. */
export interface AdminSettings {
  llm: LlmInfo & { env_pinned?: boolean }
  brake_after: number
  brake: { env_pinned: boolean }
  access_gate: { enabled: boolean; env_pinned: boolean; can_disable: boolean }
  admin_password: { env_pinned: boolean }
  password_mode: boolean
}

// ---- session token (admin auth) ----

const SESSION_TOKEN_KEY = 'chatroom:session_token'

/**
 * Cached server auth mode, populated by authMode(). null until first resolved.
 * Used to decide whether a stored session token is meaningful: in local mode the server never
 * consults the sessions table, so sending a session token only makes adminOnly treat it as an
 * (invalid) participant token and 403 every admin request.
 * Mode is process-static (decided at server startup by adminPasswordHash presence), so this cache
 * is intentionally never invalidated within a page session — a mode change only happens across a
 * server restart, after which the SPA reloads and re-fetches authMode.
 */
let _passwordMode: boolean | null = null

export function loadSessionToken(): string | null {
  try {
    return localStorage.getItem(SESSION_TOKEN_KEY)
  } catch {
    return null
  }
}

export function saveSessionToken(token: string) {
  try {
    localStorage.setItem(SESSION_TOKEN_KEY, token)
  } catch {
    // ignore storage failures (e.g. private mode / quota)
  }
}

export function clearSessionToken() {
  try {
    localStorage.removeItem(SESSION_TOKEN_KEY)
  } catch {
    // ignore
  }
}

// ---- access password (door guard) ----

/** Returns the stored access password for the x-access-password header, or null if not set. */
let _accessPassword: string | null = null

export function setAccessPassword(pw: string | null) {
  _accessPassword = pw
  try {
    if (pw) localStorage.setItem('chatroom:access_password', pw)
    else localStorage.removeItem('chatroom:access_password')
  } catch { /* ignore */ }
}

export function loadAccessPassword(): string | null {
  try {
    return localStorage.getItem('chatroom:access_password')
  } catch {
    return null
  }
}

export function initAccessPassword() {
  _accessPassword = loadAccessPassword()
}

// ---- HTTP helpers ----

/** Error carrying the HTTP status, so callers can branch on 401/403 without fragile string matching. */
export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

/** True for auth failures on management routes (missing/invalid admin credential). */
export function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403)
}

async function j<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`)
  return data as T
}

/**
 * Build common headers for fetch calls.
 * - accessPassword  → x-access-password header (door guard)
 * - adminToken      → Authorization: Bearer <session_token> (admin management routes)
 * - participantToken → Authorization: Bearer <participant_token> (room-scoped routes)
 * These are mutually exclusive for the Authorization header; admin takes precedence.
 */
function buildHeaders(opts: {
  body?: boolean
  adminToken?: string
  participantToken?: string
  accessPassword?: boolean
} = {}): Record<string, string> {
  const headers: Record<string, string> = {}
  if (opts.body) headers['content-type'] = 'application/json'
  if (opts.accessPassword !== false && _accessPassword) {
    headers['x-access-password'] = _accessPassword
  }
  const token = opts.adminToken ?? opts.participantToken
  if (token) headers['authorization'] = `Bearer ${token}`
  return headers
}

/** Resolve the admin credential: session token if available, else fall back to participant token for local mode. */
function adminCredential(participantToken?: string): string | undefined {
  // Local mode: never send a stored session token — the server would treat it as an invalid
  // participant token and 403. Fall back to the participant token (or no token, which is allowed).
  if (_passwordMode === false) return participantToken ?? undefined
  return loadSessionToken() ?? participantToken ?? undefined
}

function post(path: string, body: unknown, token?: string) {
  return fetch(path, {
    method: 'POST',
    headers: buildHeaders({ body: true, adminToken: token }),
    body: JSON.stringify(body),
  })
}

function postAdmin(path: string, body: unknown, participantToken?: string) {
  return fetch(path, {
    method: 'POST',
    headers: buildHeaders({ body: true, adminToken: adminCredential(participantToken) }),
    body: JSON.stringify(body),
  })
}

export const api = {
  // ---- read-only routes (only need access password) ----
  rooms: () => fetch('/api/rooms', { headers: buildHeaders() }).then((r) => j<Room[]>(r)),
  personas: () => fetch('/api/personas', { headers: buildHeaders() }).then((r) => j<Persona[]>(r)),
  llm: () => fetch('/api/llm', { headers: buildHeaders() }).then((r) => j<LlmInfo>(r)),

  // ---- admin management routes (need adminOnly credential) ----
  createRoom: (title = '', participantToken?: string) =>
    postAdmin('/api/rooms', { title }, participantToken).then((r) => j<Room>(r)),
  deleteRoom: (id: string, participantToken?: string) =>
    fetch(`/api/rooms/${id}`, {
      method: 'DELETE',
      headers: buildHeaders({ adminToken: adminCredential(participantToken) }),
    }).then((r) => { if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status}`) }),
  createPersona: (name: string, system_prompt: string, participantToken?: string) =>
    postAdmin('/api/personas', { name, system_prompt }, participantToken).then((r) => j<Persona>(r)),
  setLlmModel: (model: string, participantToken?: string) =>
    postAdmin('/api/llm/model', { model }, participantToken).then((r) => j<Omit<LlmInfo, 'models'>>(r)),
  approvePendingJoin: (
    roomId: string,
    requestId: string,
    participantToken: string,
    body: { action: 'new' | 'bind'; nickname?: string; bind_uid?: string },
  ) => postAdmin(`/api/rooms/${roomId}/pending-joins/${requestId}/approve`, body, participantToken)
    .then((r) => j<PendingJoin>(r)),
  rejectPendingJoin: (roomId: string, requestId: string, participantToken: string, reason?: string) =>
    postAdmin(`/api/rooms/${roomId}/pending-joins/${requestId}/reject`, { reason }, participantToken)
      .then((r) => j<PendingJoin>(r)),

  // ---- room-scoped routes (need participant token, plus access password) ----
  // When logged in (a session token is stored), send it as Authorization: Bearer so the server
  // resolves this as the owner's in-room identity (role=owner). When not logged in, no auth header
  // is sent and join behaves as before (nickname-based human / reclaim).
  join: (roomId: string, body: { nickname: string; type: 'human'; token?: string }) =>
    // In local mode a stored session token is meaningless (and would be mis-read as a participant
    // token), so don't send it — join then behaves as the normal nickname-based / reclaim flow.
    post(`/api/rooms/${roomId}/join`, body, _passwordMode === false ? undefined : (loadSessionToken() ?? undefined))
      .then((r) => j<Identity & { rejoined: boolean }>(r)),
  members: (roomId: string, token: string) =>
    fetch(`/api/rooms/${roomId}/members?token=${token}`, { headers: buildHeaders() })
      .then((r) => j<Member[]>(r)),
  sendMessage: (roomId: string, token: string, text: string) =>
    post(`/api/rooms/${roomId}/messages`, { text }, token).then((r) => j<{ msg_id: string; seq: number }>(r)),
  pendingJoins: (roomId: string, token: string) =>
    // /pending-joins is an adminOnly route → send the admin credential (session token in password
    // mode, participant token in local mode), same as createRoom/approve. Passing only the
    // participant token would 403 in password mode and hide the approval panel from the admin.
    fetch(`/api/rooms/${roomId}/pending-joins`, {
      headers: buildHeaders({ adminToken: adminCredential(token) }),
    }).then((r) => j<PendingJoin[]>(r)),

  // ---- admin: settings + session management (adminOnly) ----
  /** Public: whether the server requires admin login (password mode) or runs in local mode. */
  authMode: () =>
    fetch('/api/auth/mode', { headers: buildHeaders() })
      .then((r) => j<{ password_mode: boolean }>(r))
      .then((m) => { _passwordMode = m.password_mode; return m }),
  adminSettings: () =>
    fetch('/api/admin/settings', { headers: buildHeaders({ adminToken: adminCredential() }) })
      .then((r) => j<AdminSettings>(r)),
  updateAdminSettings: (body: { brake_after?: number; access_password?: string | null }) =>
    fetch('/api/admin/settings', {
      method: 'PATCH',
      headers: buildHeaders({ body: true, adminToken: adminCredential() }),
      body: JSON.stringify(body),
    }).then((r) => j<AdminSettings>(r)),
  changePassword: (old_password: string, new_password: string) =>
    postAdmin('/api/auth/password', { old_password, new_password }).then((r) => j<{ ok: true }>(r)),
  listSessions: () =>
    fetch('/api/auth/sessions', { headers: buildHeaders({ adminToken: adminCredential() }) })
      .then((r) => j<SessionInfo[]>(r)),
  revokeSession: (id: string) =>
    fetch(`/api/auth/sessions/${id}`, {
      method: 'DELETE',
      headers: buildHeaders({ adminToken: adminCredential() }),
    }).then((r) => { if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status}`) }),

  // ---- admin auth ----
  login: (password: string) =>
    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    }).then((r) => j<{ session_token: string }>(r)),
  logout: () => {
    const token = loadSessionToken()
    if (!token) return Promise.resolve()
    return fetch('/api/auth/logout', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    }).then(() => clearSessionToken())
  },
  logoutAll: () => {
    const token = loadSessionToken()
    if (!token) return Promise.resolve()
    return fetch('/api/auth/logout-all', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    }).then(() => clearSessionToken())
  },
}

export function identityKey(roomId: string) {
  return `chatroom:identity:${roomId}`
}

export function loadIdentity(roomId: string): Identity | null {
  try {
    return JSON.parse(localStorage.getItem(identityKey(roomId)) ?? '') as Identity
  } catch {
    return null
  }
}

export function saveIdentity(roomId: string, id: Identity) {
  localStorage.setItem(identityKey(roomId), JSON.stringify(id))
}

const lastNicknameKey = 'chatroom:lastNickname'

export function loadLastNickname(): string {
  try {
    return localStorage.getItem(lastNicknameKey) ?? ''
  } catch {
    return ''
  }
}

export function saveLastNickname(nickname: string) {
  try {
    localStorage.setItem(lastNicknameKey, nickname)
  } catch {
    // ignore storage failures (e.g. private mode / quota)
  }
}
