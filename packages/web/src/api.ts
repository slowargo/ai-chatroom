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

// ---- session token (owner auth) ----

const SESSION_TOKEN_KEY = 'chatroom:session_token'

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

async function j<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
  return data as T
}

/**
 * Build common headers for fetch calls.
 * - accessPassword  → x-access-password header (door guard)
 * - ownerToken      → Authorization: Bearer <session_token> (owner management routes)
 * - participantToken → Authorization: Bearer <participant_token> (room-scoped routes)
 * These are mutually exclusive for the Authorization header; owner takes precedence.
 */
function buildHeaders(opts: {
  body?: boolean
  ownerToken?: string
  participantToken?: string
  accessPassword?: boolean
} = {}): Record<string, string> {
  const headers: Record<string, string> = {}
  if (opts.body) headers['content-type'] = 'application/json'
  if (opts.accessPassword !== false && _accessPassword) {
    headers['x-access-password'] = _accessPassword
  }
  const token = opts.ownerToken ?? opts.participantToken
  if (token) headers['authorization'] = `Bearer ${token}`
  return headers
}

/** Resolve the owner credential: session token if available, else fall back to participant token for local mode. */
function ownerCredential(participantToken?: string): string | undefined {
  return loadSessionToken() ?? participantToken ?? undefined
}

function post(path: string, body: unknown, token?: string) {
  return fetch(path, {
    method: 'POST',
    headers: buildHeaders({ body: true, ownerToken: token }),
    body: JSON.stringify(body),
  })
}

function postOwner(path: string, body: unknown, participantToken?: string) {
  return fetch(path, {
    method: 'POST',
    headers: buildHeaders({ body: true, ownerToken: ownerCredential(participantToken) }),
    body: JSON.stringify(body),
  })
}

export const api = {
  // ---- read-only routes (only need access password) ----
  rooms: () => fetch('/api/rooms', { headers: buildHeaders() }).then((r) => j<Room[]>(r)),
  personas: () => fetch('/api/personas', { headers: buildHeaders() }).then((r) => j<Persona[]>(r)),
  llm: () => fetch('/api/llm', { headers: buildHeaders() }).then((r) => j<LlmInfo>(r)),

  // ---- owner management routes (need ownerOnly credential) ----
  createRoom: (title = '', participantToken?: string) =>
    postOwner('/api/rooms', { title }, participantToken).then((r) => j<Room>(r)),
  deleteRoom: (id: string, participantToken?: string) =>
    fetch(`/api/rooms/${id}`, {
      method: 'DELETE',
      headers: buildHeaders({ ownerToken: ownerCredential(participantToken) }),
    }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`) }),
  createPersona: (name: string, system_prompt: string, participantToken?: string) =>
    postOwner('/api/personas', { name, system_prompt }, participantToken).then((r) => j<Persona>(r)),
  setLlmModel: (model: string, participantToken?: string) =>
    postOwner('/api/llm/model', { model }, participantToken).then((r) => j<Omit<LlmInfo, 'models'>>(r)),
  approvePendingJoin: (
    roomId: string,
    requestId: string,
    participantToken: string,
    body: { action: 'new' | 'bind'; nickname?: string; bind_uid?: string },
  ) => postOwner(`/api/rooms/${roomId}/pending-joins/${requestId}/approve`, body, participantToken)
    .then((r) => j<PendingJoin>(r)),
  rejectPendingJoin: (roomId: string, requestId: string, participantToken: string, reason?: string) =>
    postOwner(`/api/rooms/${roomId}/pending-joins/${requestId}/reject`, { reason }, participantToken)
      .then((r) => j<PendingJoin>(r)),

  // ---- room-scoped routes (need participant token, plus access password) ----
  // When logged in (a session token is stored), send it as Authorization: Bearer so the server
  // resolves this as the owner's in-room identity (role=owner). When not logged in, no auth header
  // is sent and join behaves as before (nickname-based human / reclaim).
  join: (roomId: string, body: { nickname: string; type: 'human'; token?: string }) =>
    post(`/api/rooms/${roomId}/join`, body, loadSessionToken() ?? undefined)
      .then((r) => j<Identity & { rejoined: boolean }>(r)),
  members: (roomId: string, token: string) =>
    fetch(`/api/rooms/${roomId}/members?token=${token}`, { headers: buildHeaders() })
      .then((r) => j<Member[]>(r)),
  sendMessage: (roomId: string, token: string, text: string) =>
    post(`/api/rooms/${roomId}/messages`, { text }, token).then((r) => j<{ msg_id: string; seq: number }>(r)),
  pendingJoins: (roomId: string, token: string) =>
    // /pending-joins is an ownerOnly route → send the owner credential (session token in password
    // mode, participant token in local mode), same as createRoom/approve. Passing only the
    // participant token would 403 in password mode and hide the approval panel from the owner.
    fetch(`/api/rooms/${roomId}/pending-joins`, {
      headers: buildHeaders({ ownerToken: ownerCredential(token) }),
    }).then((r) => j<PendingJoin[]>(r)),

  // ---- owner auth ----
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
