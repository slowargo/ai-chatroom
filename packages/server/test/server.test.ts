import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { openDb } from '../src/db.js'
import { Hub } from '../src/hub.js'
import { Llm } from '../src/llm.js'
import { Store } from '../src/store.js'
import type { AnnotatedEvent } from '../src/types.js'

type App = ReturnType<typeof createApp>

let app: App

function api(path: string, init?: RequestInit & { token?: string }) {
  const headers = new Headers(init?.headers)
  if (init?.body) headers.set('content-type', 'application/json')
  if (init?.token) headers.set('authorization', `Bearer ${init.token}`)
  return app.request(path, { ...init, headers })
}

async function json<T = any>(res: Response): Promise<T> {
  expect(res.status).toBeLessThan(500)
  return (await res.json()) as T
}

async function createRoom(): Promise<string> {
  return (await json(await api('/api/rooms', { method: 'POST', body: '{}' }))).id
}

async function joinRoom(roomId: string, body: Record<string, unknown>) {
  return json(await api(`/api/rooms/${roomId}/join`, { method: 'POST', body: JSON.stringify(body) }))
}

/** Join as agent with auto-approval via an admin token. */
async function joinAgent(roomId: string, body: Record<string, unknown>, adminToken: string) {
  const res = await api(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    body: JSON.stringify({ type: 'agent', ...body }),
  })
  const data = (await res.json()) as any
  if (res.status === 202 && data.request_id) {
    const approved = await json(
      await api(`/api/rooms/${roomId}/pending-joins/${data.request_id}/approve`, {
        method: 'POST',
        token: adminToken,
        body: JSON.stringify({ action: 'new' }),
      }),
    )
    return { uid: approved.assigned_uid, token: approved.token, nickname: approved.assigned_nickname, rejoined: false }
  }
  return data
}

async function post(roomId: string, token: string, text: string, extra: Record<string, unknown> = {}) {
  return json(
    await api(`/api/rooms/${roomId}/messages`, {
      method: 'POST',
      token,
      body: JSON.stringify({ text, ...extra }),
    }),
  )
}

async function wait(roomId: string, token: string, windowMs = 100) {
  return json(await api(`/api/rooms/${roomId}/wait?window_ms=${windowMs}`, { token }))
}

beforeEach(() => {
  app = createApp({
    store: new Store(openDb(':memory:'), { brakeAfter: 3 }),
    hub: new Hub(),
    llm: new Llm(), // unconfigured → deterministic fallbacks
    pollWindowMs: 100,
  })
})

describe('join & identity', () => {
  it('assigns uid/token, records member_joined, rejects duplicate nicknames', async () => {
    const roomId = await createRoom()
    const a = await joinRoom(roomId, { nickname: 'alice', type: 'human' })
    expect(a.uid).toBeTruthy()
    expect(a.token).toBeTruthy()

    // agent without token gets 202 pending; approving with a taken nickname should fail
    const pendingRes = await api(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      body: JSON.stringify({ nickname: 'alice', type: 'agent' }),
    })
    expect(pendingRes.status).toBe(202)
    const { request_id } = (await pendingRes.json()) as { request_id: string }
    const approveRes = await api(`/api/rooms/${roomId}/pending-joins/${request_id}/approve`, {
      method: 'POST',
      token: a.token,
      body: JSON.stringify({ action: 'new', nickname: 'alice' }),
    })
    expect(approveRes.status).toBe(409)
  })

  it('rejects nicknames containing whitespace or "@" with 400', async () => {
    const roomId = await createRoom()
    // leading/trailing whitespace is trimmed (allowed); internal whitespace/@ is rejected
    for (const nickname of ['two words', 'a@b', 'tab\tname']) {
      const res = await api(`/api/rooms/${roomId}/join`, {
        method: 'POST',
        body: JSON.stringify({ nickname, type: 'human' }),
      })
      expect(res.status).toBe(400)
    }
  })

  it('sanitizes auto-generated nicknames so they pass validation', async () => {
    const roomId = await createRoom()
    const admin = await joinRoom(roomId, { nickname: '_admin', type: 'human' })
    const p = await json(
      await api('/api/personas', {
        method: 'POST',
        body: JSON.stringify({ name: 'Senior Architect', system_prompt: 'x' }),
      }),
    )
    // persona name with space is sanitized via the pending flow
    const a = await joinAgent(roomId, { persona_id: p.id }, admin.token)
    expect(a.nickname).not.toMatch(/[\s@]/)
    expect(a.nickname.length).toBeLessThanOrEqual(32)
  })

  it('rejoin with token reclaims uid and cursor', async () => {
    const roomId = await createRoom()
    const admin = await joinRoom(roomId, { nickname: '_admin', type: 'human' })
    const a = await joinAgent(roomId, { nickname: 'bot' }, admin.token)
    await api(`/api/rooms/${roomId}/ack`, { method: 'POST', token: a.token, body: JSON.stringify({ seq: 1 }) })

    const again = await joinRoom(roomId, { token: a.token })
    expect(again.rejoined).toBe(true)
    expect(again.uid).toBe(a.uid)
    expect(again.last_acked_seq).toBe(1)
  })

  it('generates a fallback nickname when none is given', async () => {
    const roomId = await createRoom()
    const admin = await joinRoom(roomId, { nickname: '_admin', type: 'human' })
    const p = await json(
      await api('/api/personas', {
        method: 'POST',
        body: JSON.stringify({ name: 'architect', system_prompt: 'You are a software architect.' }),
      }),
    )
    const a = await joinAgent(roomId, { persona_id: p.id }, admin.token)
    expect(a.nickname).toMatch(/^architect/)
  })

  it('uses nickname_hint (e.g. agent-model) as the base when no nickname/persona given', async () => {
    const roomId = await createRoom()
    const admin = await joinRoom(roomId, { nickname: '_admin', type: 'human' })
    const a = await joinAgent(roomId, { nickname_hint: 'claude-opus' }, admin.token)
    expect(a.nickname).toBe('claude-opus')
    // a second joiner with the same hint gets a conflict at approval (same nickname_requested)
    const res2 = await api(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      body: JSON.stringify({ type: 'agent', nickname_hint: 'claude-opus' }),
    })
    const { request_id } = (await res2.json()) as { request_id: string }
    const approve2 = await api(`/api/rooms/${roomId}/pending-joins/${request_id}/approve`, {
      method: 'POST',
      token: admin.token,
      body: JSON.stringify({ action: 'new', nickname: 'claude-opus-2' }),
    })
    const b = (await approve2.json()) as any
    expect(b.assigned_nickname).toBe('claude-opus-2')
  })

  it('concurrent agent joins both get pending status', async () => {
    const roomId = await createRoom()
    const [r1, r2] = await Promise.all([
      api(`/api/rooms/${roomId}/join`, {
        method: 'POST',
        body: JSON.stringify({ type: 'agent', nickname: 'twin' }),
      }),
      api(`/api/rooms/${roomId}/join`, {
        method: 'POST',
        body: JSON.stringify({ type: 'agent', nickname: 'twin' }),
      }),
    ])
    expect(r1.status).toBe(202)
    expect(r2.status).toBe(202)
    const d1 = (await r1.json()) as { request_id: string }
    const d2 = (await r2.json()) as { request_id: string }
    expect(d1.request_id).not.toBe(d2.request_id)
  })
})

describe('messages, mentions, seq', () => {
  it('does not false-positive on substring nicknames (e.g. @bo vs @bob)', async () => {
    const roomId = await createRoom()
    const alice = await joinRoom(roomId, { nickname: 'alice', type: 'human' })
    const bo = await joinAgent(roomId, { nickname: 'bo' }, alice.token)
    const bob = await joinAgent(roomId, { nickname: 'bob' }, alice.token)

    const m = await post(roomId, alice.token, 'hey @bob what do you think?')
    expect(m.mentions).toContain(bob.uid)
    expect(m.mentions).not.toContain(bo.uid)

    // but @bo followed by a space should still work
    const m2 = await post(roomId, alice.token, 'hey @bo what about you?')
    expect(m2.mentions).toContain(bo.uid)
    expect(m2.mentions).not.toContain(bob.uid)
  })

  it('does not false-positive on CJK substring nicknames (e.g. @架构 vs @架构师)', async () => {
    const roomId = await createRoom()
    const alice = await joinRoom(roomId, { nickname: 'alice', type: 'human' })
    const short = await joinAgent(roomId, { nickname: '架构' }, alice.token)
    const long = await joinAgent(roomId, { nickname: '架构师' }, alice.token)

    const m = await post(roomId, alice.token, '@架构师 这个方案怎么看？')
    expect(m.mentions).toContain(long.uid)
    expect(m.mentions).not.toContain(short.uid)

    // @架构 followed by space or CJK punctuation should still match
    const m2 = await post(roomId, alice.token, '@架构 你呢？')
    expect(m2.mentions).toContain(short.uid)
    expect(m2.mentions).not.toContain(long.uid)
  })

  it('assigns monotonic seq and resolves @nickname server-side', async () => {
    const roomId = await createRoom()
    const alice = await joinRoom(roomId, { nickname: 'alice', type: 'human' })
    const bot = await joinAgent(roomId, { nickname: '架构师' }, alice.token)

    const m1 = await post(roomId, alice.token, 'hello everyone')
    const m2 = await post(roomId, alice.token, '@架构师 请评审这个方案')
    expect(m2.seq).toBeGreaterThan(m1.seq)
    expect(m2.mentions).toContain(bot.uid)

    const { events } = await json<{ events: AnnotatedEvent[] }>(
      await api(`/api/rooms/${roomId}/events?after=0`, { token: alice.token }),
    )
    const seqs = events.map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y))
  })
})

describe('wait long-poll', () => {
  it('returns immediately with backlog when an unread mention already exists (offline catch-up)', async () => {
    const roomId = await createRoom()
    const alice = await joinRoom(roomId, { nickname: 'alice', type: 'human' })
    const bot = await joinAgent(roomId, { nickname: 'bot' }, alice.token)

    await post(roomId, alice.token, 'context message without mention')
    await post(roomId, alice.token, '@bot are you there?')

    const res = await wait(roomId, bot.token)
    expect(res.woke).toBe(true)
    // backlog contains ALL events since cursor, including the un-mentioned one
    const texts = res.events.filter((e: AnnotatedEvent) => e.kind === 'message').map((e: AnnotatedEvent) => e.text)
    expect(texts).toContain('context message without mention')
    expect(texts).toContain('@bot are you there?')
    expect(res.latest_seq).toBeGreaterThan(0)
  })

  it('times out with empty result when nothing relevant happens', async () => {
    const roomId = await createRoom()
    const admin = await joinRoom(roomId, { nickname: '_admin', type: 'human' })
    const bot = await joinAgent(roomId, { nickname: 'bot' }, admin.token)
    const res = await wait(roomId, bot.token, 50)
    expect(res.woke).toBe(false)
    expect(res.events).toEqual([])
  })

  it('wakes a blocked wait when a mention arrives', async () => {
    const roomId = await createRoom()
    const alice = await joinRoom(roomId, { nickname: 'alice', type: 'human' })
    const bot = await joinAgent(roomId, { nickname: 'bot' }, alice.token)

    const pending = wait(roomId, bot.token, 2000)
    await new Promise((r) => setTimeout(r, 20))
    await post(roomId, alice.token, 'hey @bot wake up')
    const res = await pending
    expect(res.woke).toBe(true)
  })

  it('does not wake on its own messages or after it already replied', async () => {
    const roomId = await createRoom()
    const alice = await joinRoom(roomId, { nickname: 'alice', type: 'human' })
    const bot = await joinAgent(roomId, { nickname: 'bot' }, alice.token)

    const ask = await post(roomId, alice.token, '@bot ping')
    await post(roomId, bot.token, '@alice pong', { in_reply_to: ask.msg_id })

    // bot has replied but not acked: must NOT wake again for the same mention
    const res = await wait(roomId, bot.token)
    expect(res.woke).toBe(false)

    // and the annotation marks the mention as already handled
    const { events } = await json<{ events: AnnotatedEvent[] }>(
      await api(`/api/rooms/${roomId}/events?after=0`, { token: bot.token }),
    )
    const mention = events.find((e) => e.msg_id === ask.msg_id)!
    expect(mention.replied_by_you).toBe(true)
  })
})

describe('ack cursor', () => {
  it('advances monotonically and feeds the wait cursor', async () => {
    const roomId = await createRoom()
    const alice = await joinRoom(roomId, { nickname: 'alice', type: 'human' })
    const bot = await joinAgent(roomId, { nickname: 'bot' }, alice.token)

    const m = await post(roomId, alice.token, '@bot first')
    let r = await json(
      await api(`/api/rooms/${roomId}/ack`, { method: 'POST', token: bot.token, body: JSON.stringify({ seq: m.seq }) }),
    )
    expect(r.last_acked_seq).toBe(m.seq)

    // acking backwards must not regress
    r = await json(
      await api(`/api/rooms/${roomId}/ack`, { method: 'POST', token: bot.token, body: JSON.stringify({ seq: 1 }) }),
    )
    expect(r.last_acked_seq).toBe(m.seq)

    const res = await wait(roomId, bot.token)
    expect(res.woke).toBe(false) // mention is behind the cursor now
  })
})

describe('agent loop brake', () => {
  it('mutes agent-to-agent mentions after N consecutive agent messages and emits one system event', async () => {
    const roomId = await createRoom()
    const alice = await joinRoom(roomId, { nickname: 'alice', type: 'human' })
    const a = await joinAgent(roomId, { nickname: 'agentA' }, alice.token)
    const b = await joinAgent(roomId, { nickname: 'agentB' }, alice.token)

    // follow the real protocol: each reply carries in_reply_to and the agent acks afterwards
    const ack = (token: string, seq: number) =>
      api(`/api/rooms/${roomId}/ack`, { method: 'POST', token, body: JSON.stringify({ seq }) })

    const m0 = await post(roomId, alice.token, 'kick off')
    const m1 = await post(roomId, a.token, '@agentB thought 1', { in_reply_to: m0.msg_id })
    await ack(a.token, m1.seq)
    const m2 = await post(roomId, b.token, '@agentA thought 2', { in_reply_to: m1.msg_id })
    await ack(b.token, m2.seq)
    const m3 = await post(roomId, a.token, '@agentB thought 3', { in_reply_to: m2.msg_id })
    await ack(a.token, m3.seq)
    // 4th consecutive agent message: brake engages
    const m4 = await post(roomId, b.token, '@agentA thought 4', { in_reply_to: m3.msg_id })
    await ack(b.token, m4.seq)
    expect(m4.muted).toBe(true)

    const { events } = await json<{ events: AnnotatedEvent[] }>(
      await api(`/api/rooms/${roomId}/events?after=0&limit=100`, { token: alice.token }),
    )
    expect(events.filter((e) => e.kind === 'system' && (e.payload as any)?.reason === 'brake')).toHaveLength(1)

    // muted mention must not wake agentA
    const res = await wait(roomId, a.token, 50)
    expect(res.woke).toBe(false)

    // a human message releases the brake
    await post(roomId, alice.token, 'back, continue @agentA')
    const res2 = await wait(roomId, a.token)
    expect(res2.woke).toBe(true)
  })
})

describe('room title decoration (LLM disabled fallback)', () => {
  it('names the room at the first message, then refines past a bare URL on reply', async () => {
    const roomId = await createRoom()
    const alice = await joinRoom(roomId, { nickname: 'alice', type: 'human' })
    await post(roomId, alice.token, 'https://example.com/some/very/long/link/that/should/not/be/the/title')
    await new Promise((r) => setTimeout(r, 20)) // decoration is fire-and-forget
    let room = await json(await api(`/api/rooms/${roomId}`))
    expect(room.title).not.toBe('') // milestone 1: named immediately, even from a lone URL

    const bot = await joinAgent(roomId, { nickname: 'bot' }, alice.token)
    await post(roomId, bot.token, 'Summary: we are discussing the event-log schema')
    await new Promise((r) => setTimeout(r, 20))
    room = await json(await api(`/api/rooms/${roomId}`))
    expect(room.title).toContain('Summary') // milestone 2: fallback skips the URL, uses the summary
  })
})

describe('llm provider api', () => {
  it('GET /api/llm reports disabled with no models when unconfigured', async () => {
    const info = await json(await api('/api/llm'))
    expect(info).toEqual({ enabled: false, provider: null, model: null, models: [] })
  })

  it('POST /api/llm/model returns 400 when unconfigured', async () => {
    const res = await api('/api/llm/model', { method: 'POST', body: JSON.stringify({ model: 'x' }) })
    expect(res.status).toBe(400)
  })

  it('POST /api/llm/model switches the model when configured', async () => {
    // enabled-path test stays on POST only: GET /api/llm would fetch the fake base url
    app = createApp({
      store: new Store(openDb(':memory:'), { brakeAfter: 3 }),
      hub: new Hub(),
      llm: new Llm({ baseUrl: 'https://example.com/v1', model: 'm1', provider: 'custom' }),
      pollWindowMs: 100,
    })
    const empty = await api('/api/llm/model', { method: 'POST', body: JSON.stringify({ model: '  ' }) })
    expect(empty.status).toBe(400)

    const info = await json(await api('/api/llm/model', { method: 'POST', body: JSON.stringify({ model: 'm2' }) }))
    expect(info).toEqual({ enabled: true, provider: 'custom', model: 'm2' })
  })
})
