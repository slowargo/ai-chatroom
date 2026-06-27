import type { Database } from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { ulid } from 'ulid'
import type {
  AnnotatedEvent,
  ChatEvent,
  EventKind,
  OwnerSession,
  Participant,
  ParticipantRole,
  ParticipantType,
  PendingJoin,
  Persona,
  Room,
} from './types.js'

export class ConflictError extends Error {}
export class ValidationError extends Error {}

const NICKNAME_MAX = 32
// Nicknames must be whitespace- and @-free so `@mention` boundaries are unambiguous
// (the parser delimits mentions by whitespace / the @ that starts the next one).
// CJK and other letters are allowed on purpose — only the structural chars are banned.
export function assertValidNickname(nickname: string): void {
  if (!nickname) throw new ValidationError('nickname is required')
  if (nickname.length > NICKNAME_MAX)
    throw new ValidationError(`nickname must be at most ${NICKNAME_MAX} characters`)
  if (/[\s@]/u.test(nickname)) throw new ValidationError('nickname must not contain whitespace or "@"')
}

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
  private pendingJoins = new Map<string, PendingJoin>()

  constructor(
    private db: Database,
    private opts: StoreOptions = { brakeAfter: 3 },
  ) {}

  private now(): string {
    return new Date().toISOString()
  }

  /** Update the agent-loop brake threshold at runtime (admin settings). */
  setBrakeAfter(n: number): void {
    this.opts.brakeAfter = n
  }

  // ---- rooms ----

  createRoom(title = '', opts: { cwd?: string; machine_id?: string } = {}): Room {
    // an explicit title at creation is user-fixed (auto=0); an empty one awaits auto-decoration (auto=1)
    const room: Room = {
      id: ulid(),
      title,
      title_auto: title ? 0 : 1,
      cwd: opts.cwd ?? null,
      machine_id: opts.machine_id ?? null,
      created_at: this.now(),
    }
    this.db
      .prepare('INSERT INTO rooms (id, title, title_auto, cwd, machine_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(room.id, room.title, room.title_auto, room.cwd, room.machine_id, room.created_at)
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

  /**
   * Find the most recent room associated with a working directory.
   * Prefers an exact cwd + machine_id match; falls back to cwd-only if machineId is provided but no exact match.
   * Orders by rowid (insertion order) rather than id: ULIDs minted in the same millisecond order by
   * their random component, which does not reflect creation order — rowid is strictly monotonic.
   */
  findRoomByCwd(cwd: string, machineId?: string): Room | undefined {
    if (machineId) {
      const exact = this.db
        .prepare('SELECT * FROM rooms WHERE cwd = ? AND machine_id = ? ORDER BY rowid DESC LIMIT 1')
        .get(cwd, machineId) as Room | undefined
      if (exact) return exact
    }
    return this.db
      .prepare('SELECT * FROM rooms WHERE cwd = ? ORDER BY rowid DESC LIMIT 1')
      .get(cwd) as Room | undefined
  }

  deleteRoom(id: string): boolean {
    const room = this.getRoom(id)
    if (!room) return false
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM events WHERE room_id = ?').run(id)
      this.db.prepare('DELETE FROM participants WHERE room_id = ?').run(id)
      this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id)
    })()
    return true
  }

  /** Set the title; `auto` controls whether later auto-decoration may still overwrite it. */
  setRoomTitle(id: string, title: string, auto = true): void {
    this.db.prepare('UPDATE rooms SET title = ?, title_auto = ? WHERE id = ?').run(title, auto ? 1 : 0, id)
  }

  /** Count of chat messages in a room (excludes join/system/room_updated events). */
  messageCount(roomId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE room_id = ? AND kind = 'message'")
      .get(roomId) as { n: number }
    return row.n
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

  /**
   * Rejoin with a token reclaims the original uid and cursor; pass a different nickname to rename.
   * Rejoin without a token but with `reclaim` set returns the existing same-nickname identity as-is
   * (its token is not rotated), so multiple clients sharing a nickname coexist instead of kicking
   * each other offline.
   *
   * P1a — owner identity:
   *  - `asOwner` (caller verified a valid owner session): locate this room's single owner participant
   *    by role (NOT by nickname); if present, return it as-is (shared token, never rotated) so all of
   *    the owner's logged-in browsers share one in-room identity. If absent, create a fresh role=owner
   *    participant. The session token is never passed in as `input.token`.
   *  - `localMode` (no owner password configured): a new human participant is created as role=owner
   *    (zero-config "everyone is owner"); otherwise a new human is role=member.
   */
  joinRoom(
    roomId: string,
    input: {
      nickname: string
      type: ParticipantType
      persona_id?: string | null
      token?: string | null
      reclaim?: boolean
      asOwner?: boolean
      localMode?: boolean
    },
  ): { participant: Participant; rejoined: boolean; events: ChatEvent[] } {
    // Owner (session-backed) join: identity is keyed by owner+room, located by role — not by nickname.
    if (input.asOwner) {
      const existingOwner = this.db
        .prepare("SELECT * FROM participants WHERE room_id = ? AND role = 'owner' LIMIT 1")
        .get(roomId) as Participant | undefined
      if (existingOwner) {
        // Share the existing owner identity across browsers; do not rotate its token.
        return { participant: existingOwner, rejoined: true, events: [] }
      }
      // No owner yet in this room: create one with the requested nickname.
      return this.createParticipant(roomId, {
        nickname: input.nickname,
        type: input.type,
        role: 'owner',
        persona_id: input.persona_id ?? null,
      })
    }

    if (input.token) {
      const existing = this.getParticipantByToken(input.token)
      if (existing && existing.room_id === roomId) {
        if (input.nickname && input.nickname !== existing.nickname) {
          assertValidNickname(input.nickname)
          const conflict = this.db
            .prepare('SELECT 1 FROM participants WHERE room_id = ? AND nickname = ? AND uid != ?')
            .get(roomId, input.nickname, existing.uid)
          if (conflict) throw new ConflictError(`nickname "${input.nickname}" is taken in this room`)
          const oldNickname = existing.nickname
          const updated = { ...existing, nickname: input.nickname }
          let events: ChatEvent[] = []
          this.db.transaction(() => {
            this.db.prepare('UPDATE participants SET nickname = ? WHERE uid = ?').run(input.nickname, existing.uid)
            events = this.appendEvent(roomId, {
              kind: 'nickname_changed',
              sender_uid: existing.uid,
              text: `${oldNickname} is now ${input.nickname}`,
              payload: { uid: existing.uid, old_nickname: oldNickname, new_nickname: input.nickname },
            })
          })()
          return { participant: updated, rejoined: true, events }
        }
        return { participant: existing, rejoined: true, events: [] }
      }
    }
    assertValidNickname(input.nickname)
    const existing = this.db
      .prepare('SELECT * FROM participants WHERE room_id = ? AND nickname = ?')
      .get(roomId, input.nickname) as Participant | undefined
    if (existing) {
      if (input.reclaim) {
        // Reclaim by nickname (no token): return the existing identity as-is rather than rotating
        // its token. Rotating would invalidate the token already held by another browser/tab of the
        // same person, kicking it offline (this is the cross-browser "lost access" bug). Returning
        // the existing token lets multiple clients sharing a nickname coexist. In a trusted
        // environment the nickname is effectively the identity; stronger guarantees are deferred to
        // a future login layer.
        return { participant: existing, rejoined: true, events: [] }
      }
      throw new ConflictError(`nickname "${input.nickname}" is taken in this room`)
    }

    // Role assignment for a freshly created participant:
    //   agent → 'agent'; human → 'owner' in local mode (no owner password), else 'member'.
    const role: ParticipantRole =
      input.type === 'agent' ? 'agent' : input.localMode ? 'owner' : 'member'
    return this.createParticipant(roomId, {
      nickname: input.nickname,
      type: input.type,
      role,
      persona_id: input.persona_id ?? null,
    })
  }

  /** Insert a brand-new participant row (with role) and emit the member_joined event. */
  private createParticipant(
    roomId: string,
    input: { nickname: string; type: ParticipantType; role: ParticipantRole; persona_id?: string | null },
  ): { participant: Participant; rejoined: boolean; events: ChatEvent[] } {
    const participant: Participant = {
      uid: ulid(),
      room_id: roomId,
      persona_id: input.persona_id ?? null,
      nickname: input.nickname,
      type: input.type,
      role: input.role,
      token: randomBytes(24).toString('base64url'),
      last_acked_seq: 0,
      created_at: this.now(),
    }
    let events: ChatEvent[] = []
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO participants (uid, room_id, persona_id, nickname, type, role, token, last_acked_seq, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          participant.uid,
          participant.room_id,
          participant.persona_id,
          participant.nickname,
          participant.type,
          participant.role,
          participant.token,
          participant.last_acked_seq,
          participant.created_at,
        )
      events = this.appendEvent(roomId, {
        kind: 'member_joined',
        sender_uid: participant.uid,
        text: `${participant.nickname} joined`,
        payload: { uid: participant.uid, nickname: participant.nickname, type: participant.type, role: participant.role },
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

  // ---- pending joins ----

  createPendingJoin(roomId: string, nicknameRequested: string, personaId?: string): PendingJoin {
    const pj: PendingJoin = {
      request_id: ulid(),
      room_id: roomId,
      nickname_requested: nicknameRequested,
      persona_id: personaId,
      created_at: Date.now(),
      status: 'pending',
    }
    this.pendingJoins.set(pj.request_id, pj)
    return pj
  }

  getPendingJoin(requestId: string): PendingJoin | undefined {
    return this.pendingJoins.get(requestId)
  }

  listPendingJoins(roomId: string): PendingJoin[] {
    return [...this.pendingJoins.values()].filter((pj) => pj.room_id === roomId)
  }

  /**
   * Approve a pending join.
   * action='new': create a new participant with the given nickname (defaults to requested nickname).
   * action='bind': generate a new token for the existing member identified by bindUid.
   */
  approvePendingJoin(
    requestId: string,
    opts: { action: 'new' | 'bind'; nickname?: string; bindUid?: string },
  ): { pj: PendingJoin; events: ChatEvent[] } {
    const pj = this.pendingJoins.get(requestId)
    if (!pj) throw new ValidationError('pending join not found')
    if (pj.status !== 'pending') throw new ValidationError('pending join is no longer pending')

    let events: ChatEvent[] = []
    if (opts.action === 'new') {
      const nickname = opts.nickname?.trim() || pj.nickname_requested
      const result = this.joinRoom(pj.room_id, {
        nickname,
        type: 'agent',
        persona_id: pj.persona_id ?? null,
      })
      pj.assigned_uid = result.participant.uid
      pj.assigned_nickname = result.participant.nickname
      pj.token = result.participant.token
      events = result.events
    } else if (opts.action === 'bind') {
      if (!opts.bindUid) throw new ValidationError('bindUid is required for bind action')
      const existing = this.getParticipant(opts.bindUid)
      if (!existing || existing.room_id !== pj.room_id) throw new ValidationError('member not found in this room')
      const newToken = randomBytes(24).toString('base64url')
      this.db.prepare('UPDATE participants SET token = ? WHERE uid = ?').run(newToken, existing.uid)
      pj.assigned_uid = existing.uid
      pj.assigned_nickname = existing.nickname
      pj.token = newToken
    } else {
      throw new ValidationError('invalid action')
    }
    pj.status = 'approved'
    this.pendingJoins.set(requestId, pj)
    return { pj, events }
  }

  deletePendingJoin(requestId: string): void {
    this.pendingJoins.delete(requestId)
  }

  rejectPendingJoin(requestId: string, reason?: string): PendingJoin {
    const pj = this.pendingJoins.get(requestId)
    if (!pj) throw new ValidationError('pending join not found')
    if (pj.status !== 'pending') throw new ValidationError('pending join is no longer pending')
    pj.status = 'rejected'
    pj.reason = reason
    this.pendingJoins.set(requestId, pj)
    return pj
  }

  // ---- owner sessions ----

  /** Create a new owner session with a fresh token. Token uses same format as participant tokens. */
  createSession(label = ''): OwnerSession {
    const session: OwnerSession = {
      kind: 'session',
      id: ulid(),
      token: randomBytes(24).toString('base64url'),
      created_at: this.now(),
      last_used_at: this.now(),
      label,
    }
    this.db
      .prepare('INSERT INTO sessions (id, token, created_at, last_used_at, label) VALUES (?, ?, ?, ?, ?)')
      .run(session.id, session.token, session.created_at, session.last_used_at, session.label)
    return session
  }

  /** Look up a session by its token. Returns undefined if not found. */
  getSessionByToken(token: string): OwnerSession | undefined {
    // `kind` is not a stored column; add it so the returned object carries the union discriminant.
    const row = this.db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) as Omit<OwnerSession, 'kind'> | undefined
    return row ? { kind: 'session', ...row } : undefined
  }

  /** List all owner sessions (login devices), newest first. */
  listSessions(): OwnerSession[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY created_at DESC')
      .all() as Omit<OwnerSession, 'kind'>[]
    return rows.map((r) => ({ kind: 'session', ...r }))
  }

  /** Update last_used_at for a session. */
  touchSession(id: string): void {
    this.db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').run(this.now(), id)
  }

  /** Delete a single session (logout). */
  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  /** Delete all sessions (logout-all). */
  deleteAllSessions(): void {
    this.db.prepare('DELETE FROM sessions').run()
  }
}
