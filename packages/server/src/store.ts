import type { Database } from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { ulid } from 'ulid'
import type {
  AnnotatedEvent,
  ChatEvent,
  EventKind,
  Participant,
  ParticipantType,
  Persona,
  Room,
} from './types.js'

export class ConflictError extends Error {}

export interface StoreOptions {
  /** mute agent-to-agent mentions after this many consecutive agent messages (no human in between) */
  brakeAfter: number
}

interface AppendInput {
  kind: EventKind
  sender_uid?: string | null
  text?: string | null
  in_reply_to?: string | null
  mentions?: string[]
  payload?: Record<string, unknown> | null
}

interface EventRowRaw {
  room_id: string
  seq: number
  msg_id: string
  sender_uid: string | null
  kind: EventKind
  text: string | null
  in_reply_to: string | null
  mentions: string
  muted: number
  payload: string | null
  created_at: string
}

function rowToEvent(r: EventRowRaw): ChatEvent {
  return {
    ...r,
    mentions: JSON.parse(r.mentions) as string[],
    muted: r.muted === 1,
    payload: r.payload ? (JSON.parse(r.payload) as Record<string, unknown>) : null,
  }
}

export class Store {
  constructor(
    private db: Database,
    private opts: StoreOptions = { brakeAfter: 3 },
  ) {}

  private now(): string {
    return new Date().toISOString()
  }

  // ---- rooms ----

  createRoom(title = ''): Room {
    const room: Room = { id: ulid(), title, created_at: this.now() }
    this.db
      .prepare('INSERT INTO rooms (id, title, created_at) VALUES (?, ?, ?)')
      .run(room.id, room.title, room.created_at)
    return room
  }

  listRooms(): Array<Room & { last_seq: number }> {
    return this.db
      .prepare(
        `SELECT r.*, COALESCE((SELECT MAX(seq) FROM events e WHERE e.room_id = r.id), 0) AS last_seq
         FROM rooms r ORDER BY r.created_at DESC`,
      )
      .all() as Array<Room & { last_seq: number }>
  }

  getRoom(id: string): Room | undefined {
    return this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as Room | undefined
  }

  setRoomTitle(id: string, title: string): void {
    this.db.prepare('UPDATE rooms SET title = ? WHERE id = ?').run(title, id)
  }

  // ---- personas ----

  createPersona(name: string, systemPrompt: string): Persona {
    const p: Persona = { id: ulid(), name, system_prompt: systemPrompt, created_at: this.now() }
    this.db
      .prepare('INSERT INTO personas (id, name, system_prompt, created_at) VALUES (?, ?, ?, ?)')
      .run(p.id, p.name, p.system_prompt, p.created_at)
    return p
  }

  listPersonas(): Persona[] {
    return this.db.prepare('SELECT * FROM personas ORDER BY created_at').all() as Persona[]
  }

  getPersona(id: string): Persona | undefined {
    return this.db.prepare('SELECT * FROM personas WHERE id = ?').get(id) as Persona | undefined
  }

  // ---- participants ----

  /** Rejoin with a token reclaims the original uid and cursor. */
  joinRoom(
    roomId: string,
    input: { nickname: string; type: ParticipantType; persona_id?: string | null; token?: string | null },
  ): { participant: Participant; rejoined: boolean; events: ChatEvent[] } {
    if (input.token) {
      const existing = this.getParticipantByToken(input.token)
      if (existing && existing.room_id === roomId) {
        return { participant: existing, rejoined: true, events: [] }
      }
    }
    const conflict = this.db
      .prepare('SELECT 1 FROM participants WHERE room_id = ? AND nickname = ?')
      .get(roomId, input.nickname)
    if (conflict) throw new ConflictError(`nickname "${input.nickname}" is taken in this room`)

    const participant: Participant = {
      uid: ulid(),
      room_id: roomId,
      persona_id: input.persona_id ?? null,
      nickname: input.nickname,
      type: input.type,
      token: randomBytes(24).toString('base64url'),
      last_acked_seq: 0,
      created_at: this.now(),
    }
    let events: ChatEvent[] = []
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO participants (uid, room_id, persona_id, nickname, type, token, last_acked_seq, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          participant.uid,
          participant.room_id,
          participant.persona_id,
          participant.nickname,
          participant.type,
          participant.token,
          participant.last_acked_seq,
          participant.created_at,
        )
      events = this.appendEvent(roomId, {
        kind: 'member_joined',
        sender_uid: participant.uid,
        text: `${participant.nickname} joined`,
        payload: { uid: participant.uid, nickname: participant.nickname, type: participant.type },
      })
    })()
    return { participant, rejoined: false, events }
  }

  getParticipantByToken(token: string): Participant | undefined {
    return this.db.prepare('SELECT * FROM participants WHERE token = ?').get(token) as
      | Participant
      | undefined
  }

  getParticipant(uid: string): Participant | undefined {
    return this.db.prepare('SELECT * FROM participants WHERE uid = ?').get(uid) as
      | Participant
      | undefined
  }

  listParticipants(roomId: string): Participant[] {
    return this.db
      .prepare('SELECT * FROM participants WHERE room_id = ? ORDER BY created_at')
      .all(roomId) as Participant[]
  }

  ack(uid: string, seq: number): number {
    this.db
      .prepare('UPDATE participants SET last_acked_seq = MAX(last_acked_seq, ?) WHERE uid = ?')
      .run(seq, uid)
    return (this.getParticipant(uid) as Participant).last_acked_seq
  }

  // ---- events ----

  /**
   * Append an event; returns the inserted events (the brake may add a trailing system event).
   * Mentions in agent messages are muted once `brakeAfter` consecutive agent messages
   * have accumulated with no human message in between.
   */
  appendEvent(roomId: string, input: AppendInput): ChatEvent[] {
    const inserted: ChatEvent[] = []
    this.db.transaction(() => {
      let muted = false
      let brakeJustEngaged = false
      const sender = input.sender_uid ? this.getParticipant(input.sender_uid) : undefined
      if (input.kind === 'message' && sender?.type === 'agent' && (input.mentions?.length ?? 0) > 0) {
        const n = this.agentMessagesSinceHuman(roomId)
        if (n >= this.opts.brakeAfter) {
          muted = true
          brakeJustEngaged = n === this.opts.brakeAfter
        }
      }
      inserted.push(this.insertEvent(roomId, input, muted))
      if (brakeJustEngaged) {
        inserted.push(
          this.insertEvent(
            roomId,
            {
              kind: 'system',
              text: `Auto-brake: ${this.opts.brakeAfter}+ consecutive agent messages without human input. Agent-to-agent mentions are muted until a human speaks.`,
              payload: { reason: 'brake' },
            },
            false,
          ),
        )
      }
    })()
    return inserted
  }

  private insertEvent(roomId: string, input: AppendInput, muted: boolean): ChatEvent {
    const next =
      ((
        this.db
          .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE room_id = ?')
          .get(roomId) as { m: number }
      ).m ?? 0) + 1
    const ev: ChatEvent = {
      room_id: roomId,
      seq: next,
      msg_id: ulid(),
      sender_uid: input.sender_uid ?? null,
      kind: input.kind,
      text: input.text ?? null,
      in_reply_to: input.in_reply_to ?? null,
      mentions: input.mentions ?? [],
      muted,
      payload: input.payload ?? null,
      created_at: this.now(),
    }
    this.db
      .prepare(
        `INSERT INTO events (room_id, seq, msg_id, sender_uid, kind, text, in_reply_to, mentions, muted, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ev.room_id,
        ev.seq,
        ev.msg_id,
        ev.sender_uid,
        ev.kind,
        ev.text,
        ev.in_reply_to,
        JSON.stringify(ev.mentions),
        ev.muted ? 1 : 0,
        ev.payload ? JSON.stringify(ev.payload) : null,
        ev.created_at,
      )
    return ev
  }

  /** count of messages since (and excluding) the last human message; all of them are agent messages */
  private agentMessagesSinceHuman(roomId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM events e
         WHERE e.room_id = ? AND e.kind = 'message'
           AND e.seq > COALESCE((
             SELECT MAX(m.seq) FROM events m
             JOIN participants p ON p.uid = m.sender_uid
             WHERE m.room_id = e.room_id AND m.kind = 'message' AND p.type = 'human'
           ), 0)`,
      )
      .get(roomId) as { n: number }
    return row.n
  }

  listEvents(roomId: string, after = 0, limit = 200): ChatEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE room_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(roomId, after, limit) as EventRowRaw[]
    return rows.map(rowToEvent)
  }

  /** listEvents plus mentions_you / replied_by_you annotations for the given viewer */
  listEventsAnnotated(roomId: string, after: number, limit: number, viewerUid: string): AnnotatedEvent[] {
    const repliedStmt = this.db.prepare(
      'SELECT 1 FROM events WHERE room_id = ? AND sender_uid = ? AND in_reply_to = ? LIMIT 1',
    )
    return this.listEvents(roomId, after, limit).map((ev) => {
      const out: AnnotatedEvent = { ...ev }
      if (ev.kind === 'message' && (ev.mentions.includes(viewerUid) || ev.mentions.includes('all'))) {
        out.mentions_you = !ev.muted && ev.sender_uid !== viewerUid
        out.replied_by_you = repliedStmt.get(roomId, viewerUid, ev.msg_id) !== undefined
      }
      return out
    })
  }

  /**
   * The wait() wake condition: an unmuted message after `after` that mentions `uid`
   * (or @all), was not sent by `uid`, and that `uid` has not replied to yet.
   */
  findWakeEvent(roomId: string, uid: string, after: number): ChatEvent | undefined {
    const row = this.db
      .prepare(
        `SELECT e.* FROM events e
         WHERE e.room_id = ? AND e.seq > ? AND e.kind = 'message' AND e.muted = 0
           AND e.sender_uid IS NOT ?
           AND EXISTS (SELECT 1 FROM json_each(e.mentions) WHERE value IN (?, 'all'))
           AND NOT EXISTS (
             SELECT 1 FROM events r
             WHERE r.room_id = e.room_id AND r.sender_uid = ? AND r.in_reply_to = e.msg_id
           )
         ORDER BY e.seq LIMIT 1`,
      )
      .get(roomId, after, uid, uid, uid) as EventRowRaw | undefined
    return row ? rowToEvent(row) : undefined
  }

  /** live-event variant of the wake condition (no replied check: the event was just created) */
  wakes(ev: ChatEvent, uid: string): boolean {
    return (
      ev.kind === 'message' &&
      !ev.muted &&
      ev.sender_uid !== uid &&
      (ev.mentions.includes(uid) || ev.mentions.includes('all'))
    )
  }

  /**
   * Resolve mentions server-side from the message text (single source of truth),
   * honoring an optional explicit uid list from the client.
   */
  resolveMentions(roomId: string, text: string, explicit?: string[]): string[] {
    const members = this.listParticipants(roomId)
    const found = new Set<string>()
    if (/@all(\b|$)/.test(text)) found.add('all')
    for (const m of members) {
      const escaped = m.nickname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // \p{L}\p{N} instead of \w: the boundary must also reject CJK continuations (@架构 vs @架构师)
      if (new RegExp(`@${escaped}(?![\\p{L}\\p{N}_-])`, 'u').test(text)) found.add(m.uid)
    }
    for (const uid of explicit ?? []) {
      if (uid === 'all' || members.some((m) => m.uid === uid)) found.add(uid)
    }
    return [...found]
  }

  recentMessages(roomId: string, limit: number): Array<{ nickname: string; text: string }> {
    const rows = this.db
      .prepare(
        `SELECT p.nickname AS nickname, e.text AS text FROM events e
         JOIN participants p ON p.uid = e.sender_uid
         WHERE e.room_id = ? AND e.kind = 'message'
         ORDER BY e.seq DESC LIMIT ?`,
      )
      .all(roomId, limit) as Array<{ nickname: string; text: string }>
    return rows.reverse()
  }
}
