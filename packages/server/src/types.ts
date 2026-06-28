export type ParticipantType = 'human' | 'agent'

/**
 * Participant role within a room (P1a):
 *  - 'owner'  : the single system owner present in this room (management authority)
 *  - 'member' : a non-owner human (only assigned when an admin password is set)
 *  - 'agent'  : an agent participant
 */
export type ParticipantRole = 'owner' | 'member' | 'agent'

export type EventKind = 'message' | 'member_joined' | 'member_left' | 'system' | 'room_updated' | 'room_deleted' | 'nickname_changed'

export interface Room {
  id: string
  title: string
  /** 1 = title is auto-generated and may still be refined; 0 = user-fixed, locked */
  title_auto: number
  cwd: string | null
  machine_id: string | null
  created_at: string
}

export interface Persona {
  id: string
  name: string
  system_prompt: string
  created_at: string
}

export interface Participant {
  uid: string
  room_id: string
  persona_id: string | null
  nickname: string
  type: ParticipantType
  role: ParticipantRole
  token: string
  last_acked_seq: number
  created_at: string
}

export interface ChatEvent {
  room_id: string
  seq: number
  msg_id: string
  sender_uid: string | null
  kind: EventKind
  text: string | null
  in_reply_to: string | null
  /** uids, may contain the literal "all" */
  mentions: string[]
  /** muted by the agent-loop brake: does not trigger wait() wakeups */
  muted: boolean
  payload: Record<string, unknown> | null
  created_at: string
}

export interface PendingJoin {
  request_id: string
  room_id: string
  nickname_requested: string
  persona_id?: string
  created_at: number
  status: 'pending' | 'approved' | 'rejected'
  assigned_uid?: string
  assigned_nickname?: string
  token?: string
  reason?: string
}

/** A verified admin session (row from the sessions table) */
export interface AdminSession {
  /** Discriminant for the `Participant | AdminSession` union (Participant has no `kind`). */
  kind: 'session'
  id: string
  token: string
  created_at: string
  last_used_at: string
  label: string
}

/** ChatEvent plus per-viewer annotations added when listing a backlog */
export interface AnnotatedEvent extends ChatEvent {
  /** true when this event mentions the viewer and the viewer already replied to it */
  replied_by_you?: boolean
  /** true when this event mentions the viewer */
  mentions_you?: boolean
}
