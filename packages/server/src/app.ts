import { Hono } from 'hono'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { streamSSE } from 'hono/streaming'
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import type { Hub } from './hub.js'
import type { Llm } from './llm.js'
import { ConflictError, ValidationError, type Store } from './store.js'
import type { ChatEvent, OwnerSession, Participant, ParticipantType } from './types.js'
import { verifyOwnerPassword } from './config.js'

/** Resolve callbacks waiting for a pending join decision, keyed by request_id */
const pendingJoinWaiters = new Map<string, ((result: unknown) => void)[]>()

export interface AppDeps {
  store: Store
  hub: Hub
  llm: Llm
  /** long-poll window; the timeout is a transport liveness detail invisible to agents */
  pollWindowMs?: number
  /** absolute path of the built web UI; omit to disable static serving */
  webDist?: string
  /**
   * if set, /api/* routes require this password via x-access-password header, with two exceptions:
   * room-scoped SSE (/api/rooms/:id/stream) accepts a valid ?token= instead (EventSource cannot set
   * headers), and the global /api/rooms/stream is disabled (403) since it has no token to validate.
   */
  accessPassword?: string | null
  /** scrypt hash of the owner password ("salt:hash" hex). If absent, local mode: any human participant token is owner. */
  ownerPasswordHash?: string | null
}

type Env = { Variables: { me: Participant | OwnerSession } }

// ---- in-process rate limiter for login endpoint ----
interface RateLimitEntry {
  fails: number
  lockedUntil: number
}
const loginRateMap = new Map<string, RateLimitEntry>()
const RATE_MAP_MAX = 5000

function getRateLimitEntry(ip: string): RateLimitEntry {
  return loginRateMap.get(ip) ?? { fails: 0, lockedUntil: 0 }
}

function recordLoginFailure(ip: string): void {
  // Evict oldest entry if at capacity
  if (!loginRateMap.has(ip) && loginRateMap.size >= RATE_MAP_MAX) {
    const oldest = loginRateMap.keys().next().value
    if (oldest) loginRateMap.delete(oldest)
  }
  const entry = getRateLimitEntry(ip)
  entry.fails++
  // First 3 failures are lenient (no lockout); from 4th: 2^(fails-3) seconds, capped at 300s
  const delaySec = entry.fails > 3 ? Math.min(Math.pow(2, entry.fails - 3), 300) : 0
  entry.lockedUntil = delaySec > 0 ? Date.now() + delaySec * 1000 : 0
  loginRateMap.set(ip, entry)
}

function clearRateLimitEntry(ip: string): void {
  loginRateMap.delete(ip)
}

/** Normalize an address so IPv4 and its IPv4-mapped IPv6 form share one rate-limit bucket. */
function normalizeIp(ip: string): string {
  const h = ip.trim().toLowerCase()
  return h.startsWith('::ffff:') ? h.slice('::ffff:'.length) : h
}

function getClientIp(c: Context): string {
  // Behind a reverse proxy, the real client IP is in X-Forwarded-For; only trust it
  // when TRUST_PROXY is explicitly set (otherwise a client could spoof the header to
  // dodge per-IP rate limiting).
  if (process.env.TRUST_PROXY) {
    const fwd = c.req.header('x-forwarded-for')
    if (fwd) return normalizeIp(fwd.split(',')[0]!)
  }
  // Default: the socket remote address from @hono/node-server's IncomingMessage.
  // c.env.incoming is the Node http.IncomingMessage; its socket carries the peer address.
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
  const addr = incoming?.socket?.remoteAddress
  return addr ? normalizeIp(addr) : 'unknown'
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function publicParticipant(p: Participant) {
  const { token: _token, ...rest } = p
  return rest
}

// Title auto-decoration fires only at these message-count milestones (not on every
// message), refining the auto title as the topic takes shape. Count 1 names the room
// as soon as there's any content; count 2 lets the first real reply supersede a weak
// first title (e.g. a bare URL); the final milestone locks it.
const TITLE_MILESTONES = [1, 2, 6]
const TITLE_LOCK_AT = 6 // the final milestone: lock the auto title against further changes

const BARE_URL = /^https?:\/\/\S+$/i

/** Deterministic fallback title when the LLM is unavailable: prefer the first message with real words over a bare URL. */
function fallbackTitle(messages: Array<{ text: string }>): string {
  const pick = messages.find((m) => m.text && !BARE_URL.test(m.text.trim())) ?? messages[0]
  const t = pick?.text?.trim() ?? ''
  return t.length > 40 ? `${t.slice(0, 40)}…` : t
}

export function createApp(deps: AppDeps) {
  const { store, hub, llm } = deps
  const pollWindowMs = deps.pollWindowMs ?? 25_000
  const ownerPasswordHash = deps.ownerPasswordHash ?? null
  const app = new Hono<Env>()

  const emit = (roomId: string, events: ChatEvent[]) => {
    hub.publish(roomId, events)
    return events
  }

  // highest milestone count whose generated title we've applied per room; guards against a
  // slower earlier-milestone generation clobbering a later, richer one (last-writer-wins is wrong here)
  const lastTitledCount = new Map<string, number>()

  if (deps.accessPassword) {
    const hash = (s: string) => createHash('sha256').update(s).digest()
    const pwHash = hash(deps.accessPassword)
    app.use('/api/*', async (c, next) => {
      // SSE endpoints cannot set headers (EventSource limitation), so allow ?token= to bypass
      // the access password check for room-scoped SSE only. The token must be a valid participant token.
      const path = c.req.path
      if (path.match(/^\/api\/rooms\/[^/]+\/stream$/)) {
        const token = c.req.query('token')
        if (token && store.getParticipantByToken(token)) {
          await next()
          return
        }
      }
      // Global rooms stream: disabled when access password is set (no safe way to authenticate EventSource)
      if (path === '/api/rooms/stream') {
        return c.json({ error: 'global room stream is disabled when access password is set; use poll /api/rooms instead' }, 403)
      }
      const pw = c.req.header('x-access-password') ?? ''
      if (!timingSafeEqual(hash(pw), pwHash)) return c.json({ error: 'access password required' }, 401)
      await next()
    })
  }

  const auth = createMiddleware<Env>(async (c, next) => {
    const token =
      c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? c.req.query('token')
    if (!token) return c.json({ error: 'missing token' }, 401)
    const me = store.getParticipantByToken(token)
    if (!me) return c.json({ error: 'invalid token' }, 401)
    const roomId = c.req.param('id')
    if (roomId && me.room_id !== roomId) return c.json({ error: 'token is for another room' }, 403)
    c.set('me', me)
    await next()
  })

  /**
   * ownerOnly middleware (self-contained, method X per design).
   * Does NOT depend on the auth middleware. Replaces auth+adminOnly on management routes.
   *
   * Path is decided solely by startup config (ownerPasswordHash), never by request fields:
   *   - ownerPasswordHash set  → look up sessions table; hit → pass; else → 403
   *   - ownerPasswordHash null → local mode (zero-config):
   *       if token provided: must be a valid human participant token → pass; else 403
   *       if no token: pass unconditionally (local = fully trusted, no credentials required)
   *
   * Red line: when ownerPasswordHash is set, NO participant token may pass ownerOnly.
   */
  const ownerOnly = createMiddleware<Env>(async (c, next) => {
    // ownerOnly routes are regular HTTP (never SSE), so the token comes from the Authorization
    // header only — no ?token= query fallback (which would leak tokens into proxy logs / history).
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')

    if (ownerPasswordHash) {
      // Password mode: a valid session token is required
      if (!token) return c.json({ error: 'owner session token required' }, 401)
      const session = store.getSessionByToken(token)
      if (!session) return c.json({ error: 'owner session required' }, 403)
      // Update last_used_at
      store.touchSession(session.id)
      c.set('me', session)
      await next()
    } else {
      // Local mode (zero-config): no owner password set means fully trusted.
      // If a token is provided, validate it as a human participant token to set 'me'.
      // If no token is provided, allow through unconditionally (backwards-compatible local behavior).
      //
      // TRUST-MODEL NOTE: in local mode the management/approval routes accept a request with no
      // token at all. This is an ACCEPTED trade-off, not a gap: local mode is defined as a fully
      // trusted, single-operator environment (loopback bind, no public exposure). Hardening for
      // untrusted/public deployments is done by setting an owner password (session auth) and/or an
      // access password — see docs/owner-role-and-password-model.md. We deliberately do NOT add
      // route-level special-casing to weaken this; the auth path is decided solely by startup config.
      if (token) {
        const participant = store.getParticipantByToken(token)
        if (!participant) return c.json({ error: 'invalid token' }, 403)
        if (participant.type !== 'human') return c.json({ error: 'owner access required' }, 403)
        c.set('me', participant)
      }
      await next()
    }
  })

  app.onError((err, c) => {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400)
    if (err instanceof ConflictError) return c.json({ error: err.message }, 409)
    console.error(err)
    return c.json({ error: 'internal error' }, 500)
  })

  // ---- auth (login / logout / logout-all) ----

  app.post('/api/auth/login', async (c) => {
    if (!ownerPasswordHash) {
      return c.json({ error: 'owner password is not configured' }, 400)
    }
    const ip = getClientIp(c)
    // Rate limit check
    const entry = getRateLimitEntry(ip)
    if (entry.lockedUntil > Date.now()) {
      const retryAfter = Math.ceil((entry.lockedUntil - Date.now()) / 1000)
      return c.json(
        { error: 'too many failed login attempts', retry_after: retryAfter },
        429,
        { 'Retry-After': String(retryAfter) },
      )
    }

    const body = (await c.req.json().catch(() => ({}))) as { password?: string }
    const password = body.password ?? ''

    if (!(await verifyOwnerPassword(password, ownerPasswordHash))) {
      recordLoginFailure(ip)
      return c.json({ error: 'invalid password' }, 401)
    }

    // Success: clear rate limit, create session
    clearRateLimitEntry(ip)
    const session = store.createSession()
    return c.json({ session_token: session.token }, 201)
  })

  app.post('/api/auth/logout', async (c) => {
    if (!ownerPasswordHash) {
      return c.json({ error: 'owner password is not configured' }, 400)
    }
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    if (!token) return c.json({ error: 'missing token' }, 401)
    const session = store.getSessionByToken(token)
    if (!session) return c.json({ error: 'invalid session token' }, 401)
    store.deleteSession(session.id)
    return c.json({ ok: true })
  })

  app.post('/api/auth/logout-all', async (c) => {
    if (!ownerPasswordHash) {
      return c.json({ error: 'owner password is not configured' }, 400)
    }
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    if (!token) return c.json({ error: 'missing token' }, 401)
    const session = store.getSessionByToken(token)
    if (!session) return c.json({ error: 'invalid session token' }, 401)

    // Rate limit check for logout-all (shares login rate limit to prevent abuse)
    const ip = getClientIp(c)
    const entry = getRateLimitEntry(ip)
    if (entry.lockedUntil > Date.now()) {
      const retryAfter = Math.ceil((entry.lockedUntil - Date.now()) / 1000)
      return c.json(
        { error: 'too many failed attempts', retry_after: retryAfter },
        429,
        { 'Retry-After': String(retryAfter) },
      )
    }

    store.deleteAllSessions()
    return c.json({ ok: true })
  })

  // ---- rooms ----

  app.post('/api/rooms', ownerOnly, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { title?: string; cwd?: string; machine_id?: string }
    // a fresh room has no events yet; include last_seq so clients can render the count without a refetch
    const room = { ...store.createRoom(body.title ?? '', { cwd: body.cwd, machine_id: body.machine_id }), last_seq: 0 }
    hub.broadcastRoomChange('created', room)
    return c.json(room, 201)
  })

  app.get('/api/rooms', (c) => c.json(store.listRooms()))

  app.get('/api/rooms/resolve', (c) => {
    const cwd = c.req.query('cwd')
    if (!cwd) return c.json({ error: 'cwd is required' }, 400)
    const machineId = c.req.query('machine_id') ?? undefined
    const room = store.findRoomByCwd(cwd, machineId)
    return room ? c.json(room) : c.json({ error: 'no room found for this cwd' }, 404)
  })

  app.get('/api/rooms/stream', (c) => {
    return streamSSE(c, async (stream) => {
      // CRITICAL: subscribe BEFORE snapshot (same pattern as per-room SSE)
      const queue: Array<{ type: string; data: unknown }> = []
      let wakeup: (() => void) | null = null
      const unsub = hub.subscribeRoomChanges((type, data) => {
        queue.push({ type, data })
        wakeup?.()
      })
      stream.onAbort(() => { unsub(); wakeup?.() })
      // Send snapshot after subscribing — events during snapshot fetch go to queue
      await stream.writeSSE({ event: 'rooms:snapshot', data: JSON.stringify(store.listRooms()) })
      while (!stream.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wakeup = resolve
            setTimeout(resolve, 15_000)  // keepalive aligned with per-room SSE
          })
          wakeup = null
          if (stream.aborted) break
          if (queue.length === 0) {
            await stream.writeSSE({ event: 'ping', data: '' })
            continue
          }
        }
        while (queue.length > 0) {
          const ev = queue.shift()!
          await stream.writeSSE({ event: `room:${ev.type}`, data: JSON.stringify(ev.data) })
        }
      }
    })
  })

  app.get('/api/rooms/:id', (c) => {
    const room = store.getRoom(c.req.param('id'))
    return room ? c.json(room) : c.json({ error: 'room not found' }, 404)
  })

  app.delete('/api/rooms/:id', ownerOnly, (c) => {
    const roomId = c.req.param('id')
    const room = store.getRoom(roomId)
    if (!room) return c.json({ error: 'room not found' }, 404)
    hub.publish(roomId, [
      {
        room_id: roomId,
        seq: Number.MAX_SAFE_INTEGER,
        msg_id: '',
        sender_uid: null,
        kind: 'room_deleted',
        text: null,
        in_reply_to: null,
        mentions: [],
        muted: false,
        payload: null,
        created_at: new Date().toISOString(),
      },
    ])
    hub.broadcastRoomChange('deleted', room)
    lastTitledCount.delete(roomId)
    store.deleteRoom(roomId)
    return c.body(null, 204)
  })

  // ---- join / members ----

  app.post('/api/rooms/:id/join', async (c) => {
    const roomId = c.req.param('id')
    if (!store.getRoom(roomId)) return c.json({ error: 'room not found' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as {
      nickname?: string
      nickname_hint?: string
      type?: ParticipantType
      persona_id?: string
      token?: string
    }
    const type = body.type ?? 'agent'
    if (type !== 'human' && type !== 'agent') return c.json({ error: 'invalid type' }, 400)
    const persona = body.persona_id ? store.getPersona(body.persona_id) : undefined
    if (body.persona_id && !persona) return c.json({ error: 'persona not found' }, 404)

    // P1a — owner (session-backed) join. Only when an owner password is configured AND the
    // Authorization header carries a valid owner session token. The owner gets/keeps this room's
    // single role=owner participant, located by role (not nickname), shared across browsers.
    // CRITICAL: the session token is never passed as a participant token; it only flips `asOwner`.
    // On re-join the existing owner participant is returned as-is, so a changed nickname/persona
    // only takes effect on the first create.
    if (ownerPasswordHash) {
      const authToken = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
      if (authToken && store.getSessionByToken(authToken)) {
        // Owner is always a human identity; a fallback nickname keeps the first-time create valid.
        const ownerNick = body.nickname?.trim() || 'owner'
        const { participant, rejoined, events } = store.joinRoom(roomId, {
          nickname: ownerNick,
          type: 'human',
          persona_id: persona?.id ?? null,
          asOwner: true,
        })
        emit(roomId, events)
        return c.json(
          {
            ...publicParticipant(participant),
            token: participant.token,
            rejoined,
            persona: participant.persona_id ? store.getPersona(participant.persona_id) ?? null : null,
          },
          rejoined ? 200 : 201,
        )
      }
    }

    // Agent without a token goes through approval flow
    if (type === 'agent' && !body.token) {
      const hint = body.nickname_hint?.trim().replace(/[@\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20)
      const nicknameRequested = body.nickname?.trim() || hint
        || persona?.name?.replace(/[@\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
        || 'agent'
      const pj = store.createPendingJoin(roomId, nicknameRequested, body.persona_id)
      return c.json({ status: 'pending', request_id: pj.request_id }, 202)
    }

    let nickname = body.nickname?.trim()
    const autoNick = !nickname && !body.token
    let base = ''
    if (autoNick) {
      const taken = store.listParticipants(roomId).map((p) => p.nickname)
      const generated = persona ? await llm.genNickname(persona.name, persona.system_prompt, taken) : null
      // caller-supplied hint (e.g. "claude-opus" from an agent's agent+model) beats a random suffix
      const hint = body.nickname_hint?.trim().replace(/[@\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20)
      // LLM output / persona names may carry spaces; sanitize so the auto path always
      // satisfies assertValidNickname (no whitespace/@, non-empty). 24-char cap leaves
      // headroom for the `-suffix` below to stay within the nickname length limit.
      base =
        (generated || hint || `${persona?.name ?? type}-${Math.random().toString(36).slice(2, 6)}`)
          .replace(/[@\s]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 24) || type
      nickname = taken.includes(base) ? `${base}-${Math.random().toString(36).slice(2, 6)}` : base
    }

    // The taken-check above is non-atomic: across the await in genNickname, a concurrent join can
    // claim the same base, so joinRoom's own pre-check then throws ConflictError. Retry the
    // auto-assigned path with a fresh suffix; an explicit nickname clash stays a 409.
    let joined: ReturnType<typeof store.joinRoom>
    for (let attempt = 0; ; attempt++) {
      try {
        joined = store.joinRoom(roomId, {
          nickname: nickname ?? '',
          type,
          persona_id: persona?.id ?? null,
          token: body.token ?? null,
          reclaim: !autoNick,
          // local mode (no owner password) → a new human is role=owner; otherwise role=member
          localMode: !ownerPasswordHash,
        })
        break
      } catch (err) {
        if (err instanceof ConflictError && autoNick && attempt < 5) {
          nickname = `${base}-${Math.random().toString(36).slice(2, 6)}`
          continue
        }
        throw err
      }
    }
    const { participant, rejoined, events } = joined
    emit(roomId, events)
    return c.json(
      {
        ...publicParticipant(participant),
        token: participant.token,
        rejoined,
        persona: persona ?? (participant.persona_id ? store.getPersona(participant.persona_id) : null) ?? null,
      },
      rejoined ? 200 : 201,
    )
  })

  // ---- pending joins ----

  app.get('/api/rooms/:id/pending-joins', ownerOnly, (c) => {
    const roomId = c.req.param('id')
    if (!store.getRoom(roomId)) return c.json({ error: 'room not found' }, 404)
    return c.json(
      store
        .listPendingJoins(roomId)
        .filter((pj) => pj.status === 'pending')
        .map((pj) => ({
          ...pj,
          persona_name: pj.persona_id ? store.getPersona(pj.persona_id)?.name ?? null : null,
        })),
    )
  })

  app.post('/api/rooms/:id/pending-joins/:rid/approve', ownerOnly, async (c) => {
    const roomId = c.req.param('id')
    const rid = c.req.param('rid')
    if (!store.getRoom(roomId)) return c.json({ error: 'room not found' }, 404)
    const pending = store.getPendingJoin(rid)
    if (!pending || pending.room_id !== roomId) return c.json({ error: 'request not found in this room' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as {
      action?: 'new' | 'bind'
      nickname?: string
      bind_uid?: string
    }
    if (!body.action) return c.json({ error: 'action is required' }, 400)
    const { pj, events } = store.approvePendingJoin(rid, { action: body.action, nickname: body.nickname, bindUid: body.bind_uid })
    emit(roomId, events)
    const waiters = pendingJoinWaiters.get(rid) ?? []
    pendingJoinWaiters.delete(rid)
    for (const resolve of waiters) resolve(pj)
    return c.json(pj)
  })

  app.post('/api/rooms/:id/pending-joins/:rid/reject', ownerOnly, async (c) => {
    const roomId = c.req.param('id')
    const rid = c.req.param('rid')
    if (!store.getRoom(roomId)) return c.json({ error: 'room not found' }, 404)
    const pending = store.getPendingJoin(rid)
    if (!pending || pending.room_id !== roomId) return c.json({ error: 'request not found in this room' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string }
    const pj = store.rejectPendingJoin(rid, body.reason)
    const waiters = pendingJoinWaiters.get(rid) ?? []
    pendingJoinWaiters.delete(rid)
    for (const resolve of waiters) resolve(pj)
    return c.json(pj)
  })

  /** No-auth poll endpoint: agent waits up to 60s for admin decision */
  app.get('/api/rooms/:id/pending-joins/:rid/poll', async (c) => {
    const rid = c.req.param('rid')
    const pj = store.getPendingJoin(rid)
    if (!pj) return c.json({ error: 'request not found' }, 404)
    if (pj.status !== 'pending') {
      store.deletePendingJoin(rid)
      return c.json(pj)
    }

    const result = await new Promise<unknown>((resolve) => {
      const existing = pendingJoinWaiters.get(rid) ?? []
      existing.push(resolve)
      pendingJoinWaiters.set(rid, existing)
      setTimeout(() => {
        const waiters = pendingJoinWaiters.get(rid)
        if (waiters) {
          const idx = waiters.indexOf(resolve)
          if (idx !== -1) waiters.splice(idx, 1)
        }
        resolve({ status: 'pending' })
      }, 60_000)
    })
    const final = result as { status?: string }
    if (final.status && final.status !== 'pending') store.deletePendingJoin(rid)
    return c.json(result)
  })

  app.get('/api/rooms/:id/members', auth, (c) => {
    const roomId = c.req.param('id')
    const online = hub.online(roomId)
    return c.json(
      store.listParticipants(roomId).map((p) => ({
        ...publicParticipant(p),
        online: online.has(p.uid) || hub.isBusy(roomId, p.uid),
        status: hub.statusOf(roomId, p.uid),
        persona_name: p.persona_id ? store.getPersona(p.persona_id)?.name ?? null : null,
      })),
    )
  })

  // ---- messages / events ----

  app.post('/api/rooms/:id/messages', auth, async (c) => {
    const roomId = c.req.param('id')
    // auth middleware guarantees a Participant here (room-scoped routes never carry an OwnerSession)
    const me = c.get('me') as Participant
    const body = (await c.req.json().catch(() => ({}))) as {
      text?: string
      in_reply_to?: string
      mentions?: string[]
    }
    const text = body.text?.trim()
    if (!text) return c.json({ error: 'text is required' }, 400)
    const mentions = store.resolveMentions(roomId, text, body.mentions)
    const events = emit(
      roomId,
      store.appendEvent(roomId, {
        kind: 'message',
        sender_uid: me.uid,
        text,
        in_reply_to: body.in_reply_to ?? null,
        mentions,
      }),
    )
    maybeDecorateTitle(roomId)
    const msg = events[0]
    return c.json({ msg_id: msg.msg_id, seq: msg.seq, mentions: msg.mentions, muted: msg.muted }, 201)
  })

  // Auto-name a room from its content, but only at the TITLE_MILESTONES message counts.
  // Refines the auto title as the topic takes shape and locks it at TITLE_LOCK_AT.
  // Never touches a user-fixed title.
  function maybeDecorateTitle(roomId: string) {
    const room = store.getRoom(roomId)
    if (!room || room.title_auto === 0) return
    const count = store.messageCount(roomId)
    if (!TITLE_MILESTONES.includes(count)) return
    const lock = count >= TITLE_LOCK_AT
    const recent = store.recentMessages(roomId, 8)
    console.log(`[title] room=${roomId} milestone=${count} lock=${lock}, generating title…`)
    void llm
      .genTitle(recent)
      .then((generated) => {
        const current = store.getRoom(roomId)
        if (!current || current.title_auto === 0) return
        if ((lastTitledCount.get(roomId) ?? 0) > count) {
          console.log(`[title] room=${roomId} milestone=${count} skipped: later milestone already applied`)
          return
        }
        // LLM was configured but this call failed: keep the existing (LLM-generated)
        // title rather than downgrading to the crude fallback or locking it. When the
        // LLM is disabled entirely, every title is a fallback and the milestone
        // progression (e.g. bare URL → first real reply) must still apply.
        if (llm.enabled() && generated == null && current.title) {
          console.log(`[title] room=${roomId} milestone=${count} generation failed; keeping existing title`)
          return
        }
        const title = generated ?? fallbackTitle(recent)
        console.log(`[title] room=${roomId} milestone=${count} generated=${generated != null} title=${JSON.stringify(title)}`)
        if (!title || title === current.title) {
          if (lock && current.title) {
            store.setRoomTitle(roomId, current.title, false)
            console.log(`[title] room=${roomId} milestone=${count} title unchanged, locked title_auto=0`)
          }
          return
        }
        lastTitledCount.set(roomId, count)
        store.setRoomTitle(roomId, title, !lock)
        // the latest appended event's seq is the room's last_seq — reuse it so the broadcast carries
        // the field getRoom() omits (else clients render an "undefined" count)
        const updateEvents = store.appendEvent(roomId, { kind: 'room_updated', payload: { title } })
        emit(roomId, updateEvents)
        const lastSeq = updateEvents[updateEvents.length - 1]?.seq ?? 0
        const updatedRoom = store.getRoom(roomId)
        if (updatedRoom) hub.broadcastRoomChange('updated', { ...updatedRoom, last_seq: lastSeq })
        console.log(`[title] room=${roomId} milestone=${count} updated to ${JSON.stringify(title)} auto=${!lock}`)
      })
      .catch((err) => console.warn(`[title] room=${roomId} milestone=${count} failed:`, err))
  }

  app.get('/api/rooms/:id/events', auth, (c) => {
    const roomId = c.req.param('id')
    const after = Number(c.req.query('after') ?? 0)
    const limit = Math.min(Number(c.req.query('limit') ?? 200), 500)
    const events = store.listEventsAnnotated(roomId, after, limit, (c.get('me') as Participant).uid)
    return c.json({ events, has_more: events.length === limit })
  })

  app.post('/api/rooms/:id/ack', auth, async (c) => {
    const roomId = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as { seq?: number }
    if (typeof body.seq !== 'number') return c.json({ error: 'seq is required' }, 400)
    const me = c.get('me') as Participant
    const result = store.ack(me.uid, body.seq)
    if (me.type === 'agent') hub.setThinking(roomId, me.uid)
    return c.json({ last_acked_seq: result })
  })

  app.post('/api/rooms/:id/status', auth, async (c) => {
    const roomId = c.req.param('id')
    const me = c.get('me') as Participant
    if (me.type !== 'agent') return c.json({ error: 'agent access required' }, 403)
    const body = (await c.req.json().catch(() => ({}))) as { status?: string }
    if (body.status !== 'waiting_human') return c.json({ error: 'invalid status: only "waiting_human" is accepted' }, 400)
    hub.setWaiting(roomId, me.uid)
    return c.json({ ok: true })
  })

  // ---- agent long-poll ----

  app.get('/api/rooms/:id/wait', auth, async (c) => {
    const roomId = c.req.param('id')
    const me = c.get('me') as Participant
    const after = c.req.query('after') !== undefined ? Number(c.req.query('after')) : me.last_acked_seq
    const windowMs = Math.min(Number(c.req.query('window_ms') ?? pollWindowMs), 1_200_000)

    hub.clearThinking(roomId, me.uid)
    const untrack = hub.track(roomId, me.uid)
    const ac = new AbortController()
    const onClientGone = () => ac.abort()
    c.req.raw.signal.addEventListener('abort', onClientGone)
    try {
      // subscribe before checking the DB so no event slips between check and wait
      const live = hub.waitFor(roomId, (ev) => store.wakes(ev, me.uid), windowMs, ac.signal)
      let woke = store.findWakeEvent(roomId, me.uid, after) !== undefined
      if (!woke) woke = await live
      ac.abort()
      if (!woke) return c.json({ woke: false, cursor: after, latest_seq: after, events: [] })
      const events = store.listEventsAnnotated(roomId, after, 500, me.uid)
      return c.json({
        woke: true,
        cursor: after,
        latest_seq: events.at(-1)?.seq ?? after,
        has_more: events.length === 500,
        events,
      })
    } finally {
      c.req.raw.signal.removeEventListener('abort', onClientGone)
      untrack()
    }
  })

  // ---- web UI live stream (SSE, full firehose) ----

  app.get('/api/rooms/:id/stream', auth, (c) => {
    const roomId = c.req.param('id')
    const me = c.get('me') as Participant
    let after = Number(c.req.header('last-event-id') ?? c.req.query('after') ?? 0)
    return streamSSE(c, async (stream) => {
      const untrack = hub.track(roomId, me.uid)
      const queue: ChatEvent[] = []
      let wakeup: (() => void) | null = null
      const unsub = hub.subscribe(roomId, (ev) => {
        queue.push(ev)
        wakeup?.()
      })
      const statusQueue: Array<{uid: string, status: 'idle' | 'thinking' | 'waiting_human'}> = []
      const unsubStatus = hub.subscribeStatus(roomId, (uid, status) => {
        statusQueue.push({ uid, status })
        wakeup?.()
      })
      const presenceQueue: Array<{uid: string, online: boolean}> = []
      const unsubPresence = hub.subscribePresence(roomId, (uid, online) => {
        presenceQueue.push({ uid, online })
        wakeup?.()
      })
      stream.onAbort(() => {
        unsub()
        unsubStatus()
        unsubPresence()
        untrack()
        wakeup?.()
      })
      const send = (ev: ChatEvent) =>
        stream.writeSSE({ id: String(ev.seq), event: 'chat', data: JSON.stringify(ev) })
      for (const ev of store.listEvents(roomId, after, 1000)) {
        await send(ev)
        after = ev.seq
      }
      // send a presence snapshot so the client can sync member online state immediately
      const onlineSnapshot = [...hub.onlineWithThinking(roomId)]
      await stream.writeSSE({ event: 'presence:snapshot', data: JSON.stringify({ online: onlineSnapshot }) })
      while (!stream.aborted) {
        if (queue.length === 0 && statusQueue.length === 0 && presenceQueue.length === 0) {
          await new Promise<void>((resolve) => {
            wakeup = resolve
            setTimeout(resolve, 15_000)
          })
          wakeup = null
          if (stream.aborted) break
          if (queue.length === 0 && statusQueue.length === 0 && presenceQueue.length === 0) {
            await stream.writeSSE({ event: 'ping', data: '' })
            continue
          }
        }
        while (queue.length > 0) {
          const ev = queue.shift()!
          if (ev.seq > after) {
            await send(ev)
            after = ev.seq
          }
        }
        while (statusQueue.length > 0) {
          const s = statusQueue.shift()!
          await stream.writeSSE({ event: 'status', data: JSON.stringify({ uid: s.uid, status: s.status }) })
        }
        while (presenceQueue.length > 0) {
          const p = presenceQueue.shift()!
          await stream.writeSSE({ event: 'presence', data: JSON.stringify(p) })
        }
      }
    })
  })

  // ---- personas ----

  app.get('/api/personas', (c) => c.json(store.listPersonas()))

  app.post('/api/personas', ownerOnly, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; system_prompt?: string }
    const name = body.name?.trim()
    if (!name || !body.system_prompt) return c.json({ error: 'name and system_prompt are required' }, 400)
    try {
      return c.json(store.createPersona(name, body.system_prompt), 201)
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return c.json({ error: `persona "${name}" already exists` }, 409)
      }
      throw err
    }
  })

  // ---- llm ----

  app.get('/api/llm', async (c) => {
    const models = await llm.listModels()
    return c.json({ ...llm.info(), models })
  })

  app.post('/api/llm/model', ownerOnly, async (c) => {
    if (!llm.enabled()) return c.json({ error: 'llm is not configured' }, 400)
    const body = (await c.req.json().catch(() => ({}))) as { model?: string }
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) return c.json({ error: 'model is required' }, 400)
    llm.setModel(model)
    return c.json(llm.info())
  })

  // ---- static web UI ----

  if (deps.webDist) {
    const dist = deps.webDist
    app.get('*', async (c) => {
      const reqPath = normalize(c.req.path).replace(/^(\.\.[/\\])+/, '')
      const filePath = join(dist, reqPath === '/' ? 'index.html' : reqPath)
      if (!filePath.startsWith(dist)) return c.notFound()
      try {
        const body = await readFile(filePath)
        return c.body(body, 200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' })
      } catch {
        // SPA fallback
        try {
          return c.html(await readFile(join(dist, 'index.html'), 'utf-8'))
        } catch {
          return c.notFound()
        }
      }
    })
  }

  return app
}
