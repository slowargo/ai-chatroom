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

    const dup = await api(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      body: JSON.stringify({ nickname: 'alice', type: 'agent' }),
    })
    expect(dup.status).toBe(409)
  })

  it('rejoin with token reclaims uid and cursor', async () => {
    const roomId = await createRoom()
    const a = await joinRoom(roomId, { nickname: 'bot', type: 'agent' })
    await api(`/api/rooms/${roomId}/ack`, { method: 'POST', token: a.token, body: JSON.stringify({ seq: 1 }) })

    const again = await joinRoom(roomId, { token: a.token })
    expect(again.rejoined).toBe(true)
    expect(again.uid).toBe(a.uid)
    expect(again.last_acked_seq).toBe(1)
  })

  it('generates a fallback nickname when none is given', async () => {
    const roomId = await createRoom()
    const p = await json(
      await api('/api/personas', {
        method: 'POST',
        body: JSON.stringify({ name: 'architect', system_prompt: 'You are a software architect.' }),
      }),
    )
    const a = await joinRoom(roomId, { type: 'agent', persona_id: p.id })
    expect(a.nickname).toMatch(/^architect-/)
    expect(a.persona.system_prompt).toContain('architect')
  })
})

describe('messages, mentions, seq', () => {
  it('does not false-positive on substring nicknames (e.g. @bo vs @bob)', async () => {
    const roomId = await createRoom()
    const bo = await joinRoom(roomId, { nickname: 'bo', type: 'agent' })
    const bob = await joinRoom(roomId, { nickname: 'bob', type: 'agent' })
    const alice = await joinRoom(roomId, { nickname: 'alice', type: 'human' })

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
    const short = await joinRoom(roomId, { nickname: '架构', type: 'agent' })
    const long = await joinRoom(roomId, { nickname: '架构师', type: 'agent' })
    const alice = await joinRoom(roomId, { nickname: 'alice', type: 'human' })

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
    const bot = await joinRoom(roomId, { nickname: '架构师', type: 'agent' })

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
    const bot = await joinRoom(roomId, { nickname: 'bot', type: 'agent' })

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
    const bot = await joinRoom(roomId, { nickname: 'bot', type: 'agent' })
    const res = await wait(roomId, bot.token, 50)
    expect(res.woke).toBe(false)
    expect(res.events).toEqual([])
  })

  it('wakes a blocked wait when a mention arrives', async () => {
    const roomId = await createRoom()
    const alice = await joinRoom(roomId, { nickname: 'alice', type: 'human' })
    const bot = await joinRoom(roomId, { nickname: 'bot', type: 'agent' })

    const pending = wait(roomId, bot.token, 2000)
    await new Promise((r) => setTimeout(r, 20))
    await post(roomId, alice.token, 'hey @bot wake up')
    const res = await pending
    expect(res.woke).toBe(true)
  })

  it('does not wake on its own messages or after it already replied', async () => {
    const roomId = await createRoom()
    const alice = await joinRoom(roomId, { nickname: 'alice', type: 'human' })
    const bot = await joinRoom(roomId, { nickname: 'bot', type: 'agent' })

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
    const bot = await joinRoom(roomId, { nickname: 'bot', type: 'agent' })

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
    const a = await joinRoom(roomId, { nickname: 'agentA', type: 'agent' })
    const b = await joinRoom(roomId, { nickname: 'agentB', type: 'agent' })

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
  it('sets a truncated title after the first human message', async () => {
    const roomId = await createRoom()
    const alice = await joinRoom(roomId, { nickname: 'alice', type: 'human' })
    await post(roomId, alice.token, 'let us discuss the new event-log schema design')
    await new Promise((r) => setTimeout(r, 20)) // decoration is fire-and-forget
    const room = await json(await api(`/api/rooms/${roomId}`))
    expect(room.title).toContain('let us discuss')
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
