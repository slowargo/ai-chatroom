export interface Room {
  id: string
  title: string
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
  persona_name: string | null
  online: boolean
}

export interface ChatEvent {
  seq: number
  msg_id: string
  sender_uid: string | null
  kind: 'message' | 'member_joined' | 'member_left' | 'system' | 'room_updated' | 'room_deleted'
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

export interface LlmInfo {
  enabled: boolean
  provider: string | null
  model: string | null
  models: string[]
}

async function j<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
  return data as T
}

function post(path: string, body: unknown, token?: string) {
  return fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

export const api = {
  rooms: () => fetch('/api/rooms').then((r) => j<Room[]>(r)),
  createRoom: (title = '') => post('/api/rooms', { title }).then((r) => j<Room>(r)),
  join: (roomId: string, body: { nickname: string; type: 'human'; token?: string }) =>
    post(`/api/rooms/${roomId}/join`, body).then((r) => j<Identity & { rejoined: boolean }>(r)),
  members: (roomId: string, token: string) =>
    fetch(`/api/rooms/${roomId}/members?token=${token}`).then((r) => j<Member[]>(r)),
  sendMessage: (roomId: string, token: string, text: string) =>
    post(`/api/rooms/${roomId}/messages`, { text }, token).then((r) => j<{ msg_id: string; seq: number }>(r)),
  personas: () => fetch('/api/personas').then((r) => j<Persona[]>(r)),
  createPersona: (name: string, system_prompt: string) =>
    post('/api/personas', { name, system_prompt }).then((r) => j<Persona>(r)),
  llm: () => fetch('/api/llm').then((r) => j<LlmInfo>(r)),
  setLlmModel: (model: string) => post('/api/llm/model', { model }).then((r) => j<Omit<LlmInfo, 'models'>>(r)),
  deleteRoom: (id: string) => fetch(`/api/rooms/${id}`, { method: 'DELETE' }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); }),
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
