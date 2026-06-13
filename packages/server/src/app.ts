import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { streamSSE } from 'hono/streaming'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import type { Hub } from './hub.js'
import type { Llm } from './llm.js'
import { ConflictError, ValidationError, type Store } from './store.js'
import type { ChatEvent, Participant, ParticipantType } from './types.js'

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
}

type Env = { Variables: { me: Participant } }

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
  return t.length > 24 ? `${t.slice(0, 24)}…` : t
}

export function createApp(deps: AppDeps) {
  const { store, hub, llm } = deps
  const pollWindowMs = deps.pollWindowMs ?? 25_000
  const app = new Hono<Env>()

  const emit = (roomId: string, events: ChatEvent[]) => {
    hub.publish(roomId, events)
    return events
  }

  // highest milestone count whose generated title we've applied per room; guards against a
  // slower earlier-milestone generation clobbering a later, richer one (last-writer-wins is wrong here)
  const lastTitledCount = new Map<string, number>()

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

  /** Admin-only middleware: requires auth middleware to have run first, then checks type=human */
  const adminOnly = createMiddleware<Env>(async (c, next) => {
    const me = c.get('me')
    if (me.type !== 'human') return c.json({ error: 'admin access required' }, 403)
    await next()
  })

  app.onError((err, c) => {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400)
    if (err instanceof ConflictError) return c.json({ error: err.message }, 409)
    console.error(err)
    return c.json({ error: 'internal error' }, 500)
  })

  // ---- rooms ----

  app.post('/api/rooms', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { title?: string }
    return c.json(store.createRoom(body.title ?? ''), 201)
  })

  app.get('/api/rooms', (c) => c.json(store.listRooms()))

  app.get('/api/rooms/:id', (c) => {
    const room = store.getRoom(c.req.param('id'))
    return room ? c.json(room) : c.json({ error: 'room not found' }, 404)
  })

  app.delete('/api/rooms/:id', (c) => {
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

  app.get('/api/rooms/:id/pending-joins', auth, adminOnly, (c) => {
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

  app.post('/api/rooms/:id/pending-joins/:rid/approve', auth, adminOnly, async (c) => {
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

  app.post('/api/rooms/:id/pending-joins/:rid/reject', auth, adminOnly, async (c) => {
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
        online: online.has(p.uid),
        persona_name: p.persona_id ? store.getPersona(p.persona_id)?.name ?? null : null,
      })),
    )
  })

  // ---- messages / events ----

  app.post('/api/rooms/:id/messages', auth, async (c) => {
    const roomId = c.req.param('id')
    const me = c.get('me')
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
        emit(roomId, store.appendEvent(roomId, { kind: 'room_updated', payload: { title } }))
        console.log(`[title] room=${roomId} milestone=${count} updated to ${JSON.stringify(title)} auto=${!lock}`)
      })
      .catch((err) => console.warn(`[title] room=${roomId} milestone=${count} failed:`, err))
  }

  app.get('/api/rooms/:id/events', auth, (c) => {
    const roomId = c.req.param('id')
    const after = Number(c.req.query('after') ?? 0)
    const limit = Math.min(Number(c.req.query('limit') ?? 200), 500)
    const events = store.listEventsAnnotated(roomId, after, limit, c.get('me').uid)
    return c.json({ events, has_more: events.length === limit })
  })

  app.post('/api/rooms/:id/ack', auth, async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { seq?: number }
    if (typeof body.seq !== 'number') return c.json({ error: 'seq is required' }, 400)
    return c.json({ last_acked_seq: store.ack(c.get('me').uid, body.seq) })
  })

  // ---- agent long-poll ----

  app.get('/api/rooms/:id/wait', auth, async (c) => {
    const roomId = c.req.param('id')
    const me = c.get('me')
    const after = c.req.query('after') !== undefined ? Number(c.req.query('after')) : me.last_acked_seq
    const windowMs = Math.min(Number(c.req.query('window_ms') ?? pollWindowMs), 120_000)

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
    const me = c.get('me')
    let after = Number(c.req.header('last-event-id') ?? c.req.query('after') ?? 0)
    return streamSSE(c, async (stream) => {
      const untrack = hub.track(roomId, me.uid)
      const queue: ChatEvent[] = []
      let wakeup: (() => void) | null = null
      const unsub = hub.subscribe(roomId, (ev) => {
        queue.push(ev)
        wakeup?.()
      })
      stream.onAbort(() => {
        unsub()
        untrack()
        wakeup?.()
      })
      const send = (ev: ChatEvent) =>
        stream.writeSSE({ id: String(ev.seq), event: 'chat', data: JSON.stringify(ev) })
      for (const ev of store.listEvents(roomId, after, 1000)) {
        await send(ev)
        after = ev.seq
      }
      while (!stream.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wakeup = resolve
            setTimeout(resolve, 15_000)
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
          if (ev.seq > after) {
            await send(ev)
            after = ev.seq
          }
        }
      }
    })
  })

  // ---- personas ----

  app.get('/api/personas', (c) => c.json(store.listPersonas()))

  app.post('/api/personas', async (c) => {
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

  app.post('/api/llm/model', async (c) => {
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
