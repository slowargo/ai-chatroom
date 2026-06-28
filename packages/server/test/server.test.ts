import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { RuntimeConfig, checkSecureBind, hashAdminPassword, loadServerConfig, verifyAdminPassword } from '../src/config.js'
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

  it('human re-join by nickname (no token) keeps the existing token so other browsers stay valid', async () => {
    const roomId = await createRoom()
    const a = await joinRoom(roomId, { nickname: 'alice', type: 'human' })

    // A second browser of the same person re-enters with the same nickname and no token.
    const b = await joinRoom(roomId, { nickname: 'alice', type: 'human' })
    expect(b.rejoined).toBe(true)
    expect(b.uid).toBe(a.uid)
    // Token must NOT be rotated, otherwise the first browser's token would be invalidated.
    expect(b.token).toBe(a.token)

    // The original browser's token still authenticates.
    const meRes = await api(`/api/rooms/${roomId}/members`, { token: a.token })
    expect(meRes.status).toBe(200)
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

// ---- room cwd/machine_id ----

describe('room cwd and machine_id', () => {
  it('stores cwd and machine_id on room creation', async () => {
    const res = await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ title: 'test', cwd: '/home/user/project', machine_id: 'user@host-ab12' }),
    })
    const room = await json(res)
    expect(room.cwd).toBe('/home/user/project')
    expect(room.machine_id).toBe('user@host-ab12')

    const fetched = await json(await api(`/api/rooms/${room.id}`))
    expect(fetched.cwd).toBe('/home/user/project')
    expect(fetched.machine_id).toBe('user@host-ab12')
  })

  it('defaults cwd and machine_id to null', async () => {
    const room = await json(await api('/api/rooms', { method: 'POST', body: '{}' }))
    expect(room.cwd).toBeNull()
    expect(room.machine_id).toBeNull()
  })

  it('includes cwd and machine_id in room listing', async () => {
    await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ cwd: '/tmp/a', machine_id: 'ma' }),
    })
    const rooms = await json<any[]>(await api('/api/rooms'))
    const r = rooms.find((x: any) => x.cwd === '/tmp/a')
    expect(r).toBeTruthy()
    expect(r.machine_id).toBe('ma')
  })
})

// ---- /api/rooms/resolve ----

describe('room resolve by cwd', () => {
  it('resolves a room by cwd', async () => {
    const created = await json(
      await api('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({ cwd: '/project/alpha', machine_id: 'dev@box-1234' }),
      }),
    )
    const resolved = await json(await api('/api/rooms/resolve?cwd=/project/alpha'))
    expect(resolved.id).toBe(created.id)
  })

  it('prefers cwd+machine_id match over cwd-only', async () => {
    const r1 = await json(
      await api('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({ cwd: '/shared', machine_id: 'host-a' }),
      }),
    )
    const r2 = await json(
      await api('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({ cwd: '/shared', machine_id: 'host-b' }),
      }),
    )
    const resolved = await json(await api('/api/rooms/resolve?cwd=/shared&machine_id=host-a'))
    expect(resolved.id).toBe(r1.id)

    const resolvedB = await json(await api('/api/rooms/resolve?cwd=/shared&machine_id=host-b'))
    expect(resolvedB.id).toBe(r2.id)
  })

  it('falls back to cwd-only when machine_id does not match', async () => {
    const created = await json(
      await api('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({ cwd: '/fallback', machine_id: 'host-x' }),
      }),
    )
    const resolved = await json(await api('/api/rooms/resolve?cwd=/fallback&machine_id=host-unknown'))
    expect(resolved.id).toBe(created.id)
  })

  it('returns newest room when multiple share the same cwd', async () => {
    await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ title: 'old', cwd: '/multi' }),
    })
    const newer = await json(
      await api('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({ title: 'new', cwd: '/multi' }),
      }),
    )
    const resolved = await json(await api('/api/rooms/resolve?cwd=/multi'))
    expect(resolved.id).toBe(newer.id)
  })

  it('returns 404 when no room matches', async () => {
    const res = await api('/api/rooms/resolve?cwd=/nonexistent')
    expect(res.status).toBe(404)
  })

  it('returns 400 when cwd is missing', async () => {
    const res = await api('/api/rooms/resolve')
    expect(res.status).toBe(400)
  })
})

// ---- waiting_human status ----

describe('waiting_human status', () => {
  async function ack(roomId: string, token: string, seq: number) {
    return json(
      await api(`/api/rooms/${roomId}/ack`, { method: 'POST', token, body: JSON.stringify({ seq }) }),
    )
  }

  it('(a) agent ack → status "thinking" in /members', async () => {
    const roomId = await createRoom()
    const alice = await joinRoom(roomId, { nickname: 'alice', type: 'human' })
    const bot = await joinAgent(roomId, { nickname: 'bot' }, alice.token)
    const m = await post(roomId, alice.token, '@bot hello')
    await ack(roomId, bot.token, m.seq)
    const members = await json<any[]>(await api(`/api/rooms/${roomId}/members`, { token: bot.token }))
    const botMember = members.find((x: any) => x.uid === bot.uid)
    expect(botMember?.status).toBe('thinking')
  })

  it('(b) POST /status waiting_human → status "waiting_human" in /members', async () => {
    const roomId = await createRoom()
    const alice = await joinRoom(roomId, { nickname: 'alice', type: 'human' })
    const bot = await joinAgent(roomId, { nickname: 'bot' }, alice.token)
    const res = await api(`/api/rooms/${roomId}/status`, {
      method: 'POST',
      token: bot.token,
      body: JSON.stringify({ status: 'waiting_human' }),
    })
    expect(res.status).toBe(200)
    const members = await json<any[]>(await api(`/api/rooms/${roomId}/members`, { token: bot.token }))
    const botMember = members.find((x: any) => x.uid === bot.uid)
    expect(botMember?.status).toBe('waiting_human')
  })

  it('(c) subsequent ack does NOT clobber waiting_human', async () => {
    const roomId = await createRoom()
    const alice = await joinRoom(roomId, { nickname: 'alice', type: 'human' })
    const bot = await joinAgent(roomId, { nickname: 'bot' }, alice.token)
    // first set waiting_human
    await api(`/api/rooms/${roomId}/status`, {
      method: 'POST',
      token: bot.token,
      body: JSON.stringify({ status: 'waiting_human' }),
    })
    // then ack — must not clobber waiting_human
    const m = await post(roomId, alice.token, '@bot ping')
    await ack(roomId, bot.token, m.seq)
    const members = await json<any[]>(await api(`/api/rooms/${roomId}/members`, { token: bot.token }))
    const botMember = members.find((x: any) => x.uid === bot.uid)
    expect(botMember?.status).toBe('waiting_human')
  })

  it('(d) /wait entry resets status to "idle"', async () => {
    const roomId = await createRoom()
    const alice = await joinRoom(roomId, { nickname: 'alice', type: 'human' })
    const bot = await joinAgent(roomId, { nickname: 'bot' }, alice.token)
    await api(`/api/rooms/${roomId}/status`, {
      method: 'POST',
      token: bot.token,
      body: JSON.stringify({ status: 'waiting_human' }),
    })
    // /wait entry clears thinking + waiting
    await wait(roomId, bot.token, 50)
    const members = await json<any[]>(await api(`/api/rooms/${roomId}/members`, { token: bot.token }))
    const botMember = members.find((x: any) => x.uid === bot.uid)
    expect(botMember?.status).toBe('idle')
  })

  it('(e) waiting_human implies online in /members', async () => {
    const roomId = await createRoom()
    const alice = await joinRoom(roomId, { nickname: 'alice', type: 'human' })
    const bot = await joinAgent(roomId, { nickname: 'bot' }, alice.token)
    await api(`/api/rooms/${roomId}/status`, {
      method: 'POST',
      token: bot.token,
      body: JSON.stringify({ status: 'waiting_human' }),
    })
    const members = await json<any[]>(await api(`/api/rooms/${roomId}/members`, { token: bot.token }))
    const botMember = members.find((x: any) => x.uid === bot.uid)
    expect(botMember?.online).toBe(true)
  })

  it('rejects /status from a human member with 403', async () => {
    const roomId = await createRoom()
    const alice = await joinRoom(roomId, { nickname: 'alice', type: 'human' })
    const res = await api(`/api/rooms/${roomId}/status`, {
      method: 'POST',
      token: alice.token,
      body: JSON.stringify({ status: 'waiting_human' }),
    })
    expect(res.status).toBe(403)
  })

  it('rejects unknown status values with 400', async () => {
    const roomId = await createRoom()
    const alice = await joinRoom(roomId, { nickname: 'alice', type: 'human' })
    const bot = await joinAgent(roomId, { nickname: 'bot' }, alice.token)
    const res = await api(`/api/rooms/${roomId}/status`, {
      method: 'POST',
      token: bot.token,
      body: JSON.stringify({ status: 'active' }),
    })
    expect(res.status).toBe(400)
  })
})

// ---- access password ----

describe('access password', () => {
  let protectedApp: App

  beforeEach(() => {
    protectedApp = createApp({
      store: new Store(openDb(':memory:'), { brakeAfter: 3 }),
      hub: new Hub(),
      llm: new Llm(),
      pollWindowMs: 100,
      accessPassword: 'test-secret',
    })
  })

  function papi(path: string, init?: RequestInit & { token?: string; password?: string }) {
    const headers = new Headers(init?.headers)
    if (init?.body) headers.set('content-type', 'application/json')
    if (init?.token) headers.set('authorization', `Bearer ${init.token}`)
    if (init?.password) headers.set('x-access-password', init.password)
    return protectedApp.request(path, { ...init, headers })
  }

  it('rejects API requests without password', async () => {
    const res = await papi('/api/rooms')
    expect(res.status).toBe(401)
    const body = await res.json() as any
    expect(body.error).toContain('access password')
  })

  it('rejects API requests with wrong password', async () => {
    const res = await papi('/api/rooms', { password: 'wrong' })
    expect(res.status).toBe(401)
  })

  it('allows API requests with correct password', async () => {
    const res = await papi('/api/rooms', { password: 'test-secret' })
    expect(res.status).toBe(200)
  })

  it('no longer accepts password via query param (removed per P0a design)', async () => {
    // ?password= query support was removed; only x-access-password header is accepted
    const res = await papi('/api/rooms?password=test-secret')
    expect(res.status).toBe(401)
  })

  it('rejects password via query param when wrong', async () => {
    const res = await papi('/api/rooms?password=wrong')
    expect(res.status).toBe(401)
  })
})

// ---- admin auth: login / logout / adminOnly middleware ----

describe('admin auth — login / logout / adminOnly', () => {
  const ADMIN_PW = 'super-secret-pw'
  let adminStore: Store
  let adminApp: App
  let adminHash: string

  beforeAll(async () => {
    // hash once for the whole suite (scrypt is intentionally slow)
    adminHash = await hashAdminPassword(ADMIN_PW)
  })

  beforeEach(() => {
    adminStore = new Store(openDb(':memory:'), { brakeAfter: 3 })
    adminApp = createApp({
      store: adminStore,
      hub: new Hub(),
      llm: new Llm(),
      pollWindowMs: 100,
      adminPasswordHash: adminHash,
    })
  })

  async function oapi(path: string, init?: RequestInit & { token?: string }): Promise<Response> {
    const headers = new Headers(init?.headers)
    if (init?.body) headers.set('content-type', 'application/json')
    if (init?.token) headers.set('authorization', `Bearer ${init.token}`)
    return adminApp.request(path, { ...init, headers })
  }

  async function login(password: string) {
    return oapi('/api/auth/login', { method: 'POST', body: JSON.stringify({ password }) })
  }

  // ---- login ----

  it('login with correct password returns session_token', async () => {
    const res = await login(ADMIN_PW)
    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(typeof body.session_token).toBe('string')
    expect(body.session_token.length).toBeGreaterThan(10)
  })

  it('login with wrong password returns 401', async () => {
    const res = await login('wrong-password')
    expect(res.status).toBe(401)
  })

  it('login returns 400 when admin password is not configured', async () => {
    const localApp = createApp({
      store: new Store(openDb(':memory:'), { brakeAfter: 3 }),
      hub: new Hub(),
      llm: new Llm(),
      pollWindowMs: 100,
      // adminPasswordHash intentionally omitted → local mode
    })
    const res = await localApp.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'anything' }),
    })
    expect(res.status).toBe(400)
  })

  // ---- adminOnly with password set: only session tokens pass ----

  it('adminOnly with password set: valid session token passes POST /api/rooms', async () => {
    const { session_token } = await login(ADMIN_PW).then((r) => r.json()) as any
    const res = await oapi('/api/rooms', { method: 'POST', body: '{}', token: session_token })
    expect(res.status).toBe(201)
  })

  it('adminOnly with password set: participant token is rejected (red-line)', async () => {
    // Get a session token to create a room, then join to get a participant token
    const { session_token } = await login(ADMIN_PW).then((r) => r.json()) as any
    const room = await oapi('/api/rooms', { method: 'POST', body: '{}', token: session_token })
      .then((r) => r.json()) as any
    const joined = await oapi(`/api/rooms/${room.id}/join`, {
      method: 'POST',
      body: JSON.stringify({ nickname: 'alice', type: 'human' }),
    }).then((r) => r.json()) as any

    // participant token must NOT pass adminOnly when password is set
    const res = await oapi('/api/rooms', { method: 'POST', body: '{}', token: joined.token })
    expect(res.status).toBe(403)
  })

  it('adminOnly with password set: no token returns 401', async () => {
    const res = await oapi('/api/rooms', { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
  })

  // ---- logout ----

  it('logout invalidates the session token', async () => {
    const { session_token } = await login(ADMIN_PW).then((r) => r.json()) as any

    // Token works before logout
    const before = await oapi('/api/rooms', { method: 'POST', body: '{}', token: session_token })
    expect(before.status).toBe(201)

    // Logout
    const logoutRes = await oapi('/api/auth/logout', { method: 'POST', token: session_token })
    expect(logoutRes.status).toBe(200)

    // Token rejected after logout
    const after = await oapi('/api/rooms', { method: 'POST', body: '{}', token: session_token })
    expect(after.status).toBe(403)
  })

  // ---- logout-all ----

  it('logout-all invalidates all sessions', async () => {
    const { session_token: t1 } = await login(ADMIN_PW).then((r) => r.json()) as any
    const { session_token: t2 } = await login(ADMIN_PW).then((r) => r.json()) as any

    // Both tokens work
    expect((await oapi('/api/rooms', { method: 'POST', body: '{}', token: t1 })).status).toBe(201)
    expect((await oapi('/api/rooms', { method: 'POST', body: '{}', token: t2 })).status).toBe(201)

    // logout-all using t1
    const logoutAllRes = await oapi('/api/auth/logout-all', { method: 'POST', token: t1 })
    expect(logoutAllRes.status).toBe(200)

    // Both tokens are now invalid
    expect((await oapi('/api/rooms', { method: 'POST', body: '{}', token: t1 })).status).toBe(403)
    expect((await oapi('/api/rooms', { method: 'POST', body: '{}', token: t2 })).status).toBe(403)
  })

  // ---- local mode (no password) ----

  it('local mode: no token still allowed on management routes (zero-config backward compat)', async () => {
    const localApp = createApp({
      store: new Store(openDb(':memory:'), { brakeAfter: 3 }),
      hub: new Hub(),
      llm: new Llm(),
      pollWindowMs: 100,
    })
    const res = await localApp.request('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(201)
  })

  it('local mode: human participant token passes adminOnly', async () => {
    const localApp = createApp({
      store: new Store(openDb(':memory:'), { brakeAfter: 3 }),
      hub: new Hub(),
      llm: new Llm(),
      pollWindowMs: 100,
    })
    // Create a room (no token, local mode)
    const room = await (await localApp.request('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })).json() as any

    // Join as human to get a participant token
    const joined = await (await localApp.request(`/api/rooms/${room.id}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nickname: 'alice', type: 'human' }),
    })).json() as any

    // Human participant token passes adminOnly in local mode (approve pending join)
    const pendingRes = await localApp.request(`/api/rooms/${room.id}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'agent', nickname: 'bot' }),
    })
    const { request_id } = await pendingRes.json() as any

    const approveRes = await localApp.request(`/api/rooms/${room.id}/pending-joins/${request_id}/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${joined.token}`,
      },
      body: JSON.stringify({ action: 'new' }),
    })
    expect(approveRes.status).toBe(200)
  })

  it('local mode: agent participant token is rejected by adminOnly', async () => {
    const localApp = createApp({
      store: new Store(openDb(':memory:'), { brakeAfter: 3 }),
      hub: new Hub(),
      llm: new Llm(),
      pollWindowMs: 100,
    })
    const room = await (await localApp.request('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })).json() as any

    // Join as human to approve an agent
    const human = await (await localApp.request(`/api/rooms/${room.id}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nickname: 'alice', type: 'human' }),
    })).json() as any

    // Get an agent token via approval
    const pending = await (await localApp.request(`/api/rooms/${room.id}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'agent', nickname: 'bot' }),
    })).json() as any

    const approved = await (await localApp.request(`/api/rooms/${room.id}/pending-joins/${pending.request_id}/approve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${human.token}`,
      },
      body: JSON.stringify({ action: 'new' }),
    })).json() as any

    // Agent token must NOT pass adminOnly even in local mode
    const res = await localApp.request('/api/rooms', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${approved.token}`,
      },
      body: '{}',
    })
    expect(res.status).toBe(403)
  })

  // ---- access password + adminOnly: x-access-password header, not query ----

  it('access password gate: header works, ?password= query does not', async () => {
    const gatedApp = createApp({
      store: new Store(openDb(':memory:'), { brakeAfter: 3 }),
      hub: new Hub(),
      llm: new Llm(),
      pollWindowMs: 100,
      accessPassword: 'gate-pw',
    })
    // header path works
    const okRes = await gatedApp.request('/api/rooms', {
      headers: { 'x-access-password': 'gate-pw' },
    })
    expect(okRes.status).toBe(200)

    // ?password= query is no longer accepted
    const qRes = await gatedApp.request('/api/rooms?password=gate-pw')
    expect(qRes.status).toBe(401)
  })

  // ---- global rooms/stream is gated when access password is set ----

  it('global /api/rooms/stream is disabled when access password is set', async () => {
    const gatedApp = createApp({
      store: new Store(openDb(':memory:'), { brakeAfter: 3 }),
      hub: new Hub(),
      llm: new Llm(),
      pollWindowMs: 100,
      accessPassword: 'gate-pw',
    })
    const res = await gatedApp.request('/api/rooms/stream', {
      headers: { 'x-access-password': 'gate-pw' },
    })
    expect(res.status).toBe(403)
  })
})

// ---- P0b · hardening ----

describe('P0b — admin password hashing (async)', () => {
  it('hashAdminPassword + verifyAdminPassword round-trips correctly', async () => {
    const hash = await hashAdminPassword('correct horse battery staple')
    expect(hash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/)
    expect(await verifyAdminPassword('correct horse battery staple', hash)).toBe(true)
    expect(await verifyAdminPassword('wrong password', hash)).toBe(false)
  })

  it('verifyAdminPassword returns false for malformed stored hashes', async () => {
    expect(await verifyAdminPassword('x', '')).toBe(false)
    expect(await verifyAdminPassword('x', 'no-colon-here')).toBe(false)
    expect(await verifyAdminPassword('x', 'salt:')).toBe(false)
  })

  it('a config-stored (pre-computed) hash can authenticate login', async () => {
    // Simulate the "pre-stored hash" path: hash is computed offline and passed as adminPasswordHash.
    const preStored = await hashAdminPassword('stored-pw')
    const app = createApp({
      store: new Store(openDb(':memory:'), { brakeAfter: 3 }),
      hub: new Hub(),
      llm: new Llm(),
      pollWindowMs: 100,
      adminPasswordHash: preStored,
    })
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'stored-pw' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(typeof body.session_token).toBe('string')
  })
})

describe('P0b — default-deny secure bind (checkSecureBind)', () => {
  it('allows loopback host with no auth', () => {
    expect(checkSecureBind({ host: '127.0.0.1', accessPassword: null, adminPasswordHash: null })).toBeNull()
    expect(checkSecureBind({ host: 'localhost', accessPassword: null, adminPasswordHash: null })).toBeNull()
    expect(checkSecureBind({ host: '::1', accessPassword: null, adminPasswordHash: null })).toBeNull()
  })

  it('refuses non-loopback host with no auth', () => {
    const err = checkSecureBind({ host: '0.0.0.0', accessPassword: null, adminPasswordHash: null })
    expect(err).toBeTruthy()
    expect(err).toContain('Refusing to start')
  })

  it('allows non-loopback host when an access password is set', () => {
    expect(checkSecureBind({ host: '0.0.0.0', accessPassword: 'pw', adminPasswordHash: null })).toBeNull()
  })

  it('allows non-loopback host when an admin password is set', () => {
    expect(checkSecureBind({ host: '0.0.0.0', accessPassword: null, adminPasswordHash: 'salt:hash' })).toBeNull()
  })

  it('allows non-loopback host with no auth when explicitly overridden', () => {
    expect(
      checkSecureBind({ host: '0.0.0.0', accessPassword: null, adminPasswordHash: null, allowInsecure: true }),
    ).toBeNull()
  })

  it('refuses a concrete public-looking address with no auth', () => {
    const err = checkSecureBind({ host: '192.168.1.50', accessPassword: null, adminPasswordHash: null })
    expect(err).toBeTruthy()
  })
})

// ---- P1a · owner in-room identity (role column + session-aware join) ----

describe('P1a — participants.role migration backfill', () => {
  it('backfills role: human → owner, agent → agent on an old DB', () => {
    // A :memory: DB cannot be reopened across connections, so use a real temp file.
    const dir = mkdtempSync(pathJoin(tmpdir(), 'chatroom-mig-'))
    const dbPath = pathJoin(dir, 'old.db')
    try {
      // Build a pre-P1a participants table (no `role` column) and insert legacy rows.
      const db = new Database(dbPath)
      db.exec(`
        CREATE TABLE rooms (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
        CREATE TABLE participants (
          uid TEXT PRIMARY KEY, room_id TEXT NOT NULL, persona_id TEXT, nickname TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('human','agent')), token TEXT NOT NULL UNIQUE,
          last_acked_seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
          UNIQUE (room_id, nickname)
        );
        INSERT INTO rooms (id, title, created_at) VALUES ('r1', '', '2020-01-01');
        INSERT INTO participants (uid, room_id, nickname, type, token, created_at)
          VALUES ('u-human', 'r1', 'alice', 'human', 'tok-human', '2020-01-01');
        INSERT INTO participants (uid, room_id, nickname, type, token, created_at)
          VALUES ('u-agent', 'r1', 'bot', 'agent', 'tok-agent', '2020-01-01');
      `)
      db.close()

      // Re-open via openDb → runs the idempotent migration + backfill.
      const migrated = openDb(dbPath)
      const rows = migrated.prepare('SELECT uid, type, role FROM participants ORDER BY uid').all() as Array<{ uid: string; type: string; role: string }>
      const byUid = Object.fromEntries(rows.map((r) => [r.uid, r.role]))
      expect(byUid['u-human']).toBe('owner')
      expect(byUid['u-agent']).toBe('agent')
      migrated.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('P1a — owner in-room identity (session-aware join)', () => {
  const ADMIN_PW = 'p1a-owner-pw'
  let adminHash: string

  beforeAll(async () => {
    adminHash = await hashAdminPassword(ADMIN_PW)
  })

  function pwApp() {
    return createApp({
      store: new Store(openDb(':memory:'), { brakeAfter: 3 }),
      hub: new Hub(),
      llm: new Llm(),
      pollWindowMs: 100,
      adminPasswordHash: adminHash,
    })
  }
  function localApp() {
    return createApp({
      store: new Store(openDb(':memory:'), { brakeAfter: 3 }),
      hub: new Hub(),
      llm: new Llm(),
      pollWindowMs: 100,
    })
  }
  async function jpost(app: App, path: string, body: unknown, token?: string) {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) })
  }
  async function getSession(app: App) {
    const res = await jpost(app, '/api/auth/login', { password: ADMIN_PW })
    return (await res.json() as { session_token: string }).session_token
  }
  async function createRoomViaSession(app: App, session: string) {
    const res = await jpost(app, '/api/rooms', {}, session)
    return (await res.json() as { id: string }).id
  }

  it('owner join (with session) creates a role=owner participant', async () => {
    const app = pwApp()
    const session = await getSession(app)
    const roomId = await createRoomViaSession(app, session)

    const res = await jpost(app, `/api/rooms/${roomId}/join`, { nickname: 'boss', type: 'human' }, session)
    expect(res.status).toBe(201)
    const me = await res.json() as any
    expect(me.role).toBe('owner')
    expect(me.token).toBeTruthy()
  })

  it('a second session join returns the SAME owner participant (shared token, not rotated)', async () => {
    const app = pwApp()
    const s1 = await getSession(app)
    const roomId = await createRoomViaSession(app, s1)

    const first = await (await jpost(app, `/api/rooms/${roomId}/join`, { nickname: 'boss', type: 'human' }, s1)).json() as any

    // A second, independent browser logs in (separate session) and joins the same room.
    const s2 = await getSession(app)
    expect(s2).not.toBe(s1)
    const second = await jpost(app, `/api/rooms/${roomId}/join`, { nickname: 'whatever', type: 'human' }, s2)
    expect(second.status).toBe(200) // rejoined → 200
    const secondBody = await second.json() as any

    expect(secondBody.uid).toBe(first.uid)
    expect(secondBody.token).toBe(first.token) // token must NOT be rotated
    expect(secondBody.role).toBe('owner')
  })

  it('password mode: a human join WITHOUT a session is role=member', async () => {
    const app = pwApp()
    const session = await getSession(app)
    const roomId = await createRoomViaSession(app, session)

    // No Authorization header → ordinary human join.
    const res = await jpost(app, `/api/rooms/${roomId}/join`, { nickname: 'guest', type: 'human' })
    expect(res.status).toBe(201)
    const me = await res.json() as any
    expect(me.role).toBe('member')
  })

  it('owner first-join with a nickname taken by a member returns a clean 409 (not 500)', async () => {
    const app = pwApp()
    const session = await getSession(app)
    const roomId = await createRoomViaSession(app, session)
    // a non-owner human takes the nickname "taken"
    const member = await jpost(app, `/api/rooms/${roomId}/join`, { nickname: 'taken', type: 'human' })
    expect(member.status).toBe(201)
    // owner first-join (no owner participant yet) picks the same nickname → ConflictError → 409
    const res = await jpost(app, `/api/rooms/${roomId}/join`, { nickname: 'taken', type: 'human' }, session)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error?: string }).error).toContain('taken')
  })

  it('password mode: a tokenless join with the owner nickname is rejected, not given the owner token', async () => {
    const app = pwApp()
    const session = await getSession(app)
    const roomId = await createRoomViaSession(app, session)
    // owner establishes its role=owner in-room identity "boss"
    const owner = await (await jpost(app, `/api/rooms/${roomId}/join`, { nickname: 'boss', type: 'human' }, session)).json() as any
    expect(owner.role).toBe('owner')
    // attacker: no session, no token, picks the owner's nickname → must NOT reclaim the owner identity
    const res = await jpost(app, `/api/rooms/${roomId}/join`, { nickname: 'boss', type: 'human' })
    expect(res.status).toBe(409)
    expect((await res.json() as { token?: string }).token).toBeUndefined()
  })

  it('password mode: credential-less nickname reclaim is closed (member collision → 409)', async () => {
    const app = pwApp()
    const session = await getSession(app)
    const roomId = await createRoomViaSession(app, session)
    const first = await (await jpost(app, `/api/rooms/${roomId}/join`, { nickname: 'guest', type: 'human' })).json() as any
    expect(first.role).toBe('member')
    // a second tokenless join with the same nickname must not silently reclaim the first identity
    const res = await jpost(app, `/api/rooms/${roomId}/join`, { nickname: 'guest', type: 'human' })
    expect(res.status).toBe(409)
  })

  it('local mode: tokenless nickname reclaim still returns the same identity (regression guard)', async () => {
    const app = localApp()
    const room = await (await jpost(app, '/api/rooms', {})).json() as any
    const first = await (await jpost(app, `/api/rooms/${room.id}/join`, { nickname: 'alice', type: 'human' })).json() as any
    expect(first.role).toBe('owner')
    // same nickname, no token → reclaim the existing identity (shared token), NOT a 409
    const res = await jpost(app, `/api/rooms/${room.id}/join`, { nickname: 'alice', type: 'human' })
    expect(res.status).toBe(200)
    const second = await res.json() as any
    expect(second.uid).toBe(first.uid)
    expect(second.token).toBe(first.token)
  })

  it('local mode: a human join is role=owner', async () => {
    const app = localApp()
    const room = await (await jpost(app, '/api/rooms', {})).json() as any
    const res = await jpost(app, `/api/rooms/${room.id}/join`, { nickname: 'alice', type: 'human' })
    expect(res.status).toBe(201)
    const me = await res.json() as any
    expect(me.role).toBe('owner')
  })

  it('agent join is role=agent (via approval)', async () => {
    const app = localApp()
    const room = await (await jpost(app, '/api/rooms', {})).json() as any
    const human = await (await jpost(app, `/api/rooms/${room.id}/join`, { nickname: 'alice', type: 'human' })).json() as any

    const pending = await (await jpost(app, `/api/rooms/${room.id}/join`, { type: 'agent', nickname: 'bot' })).json() as any
    await jpost(app, `/api/rooms/${room.id}/pending-joins/${pending.request_id}/approve`, { action: 'new' }, human.token)

    const members = await (await app.request(`/api/rooms/${room.id}/members?token=${human.token}`)).json() as any[]
    const bot = members.find((m) => m.nickname === 'bot')
    expect(bot?.role).toBe('agent')
  })

  it('members listing exposes role', async () => {
    const app = localApp()
    const room = await (await jpost(app, '/api/rooms', {})).json() as any
    const human = await (await jpost(app, `/api/rooms/${room.id}/join`, { nickname: 'alice', type: 'human' })).json() as any
    const members = await (await app.request(`/api/rooms/${room.id}/members?token=${human.token}`)).json() as any[]
    expect(members[0].role).toBe('owner')
  })

  it('red-line still holds: a session token is never accepted as a participant token on room routes', async () => {
    const app = pwApp()
    const session = await getSession(app)
    const roomId = await createRoomViaSession(app, session)
    // Using the session token directly on an auth-protected room route (messages) must fail:
    // the session token is not a participant token.
    const res = await app.request(`/api/rooms/${roomId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` },
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(res.status).toBe(401)
  })
})

// ---- P1b · admin settings + session management ----

describe('P1b — admin (sessions / password / settings)', () => {
  const ADMIN_PW = 'p1b-owner-pw'
  let adminHash: string

  beforeAll(async () => {
    adminHash = await hashAdminPassword(ADMIN_PW)
  })

  /** Build an app with an explicit RuntimeConfig (no-op persist so tests never touch config.json). */
  function adminApp(opts: {
    adminHash?: string | null
    accessPassword?: string | null
    brakeAfter?: number
    host?: string
    allowInsecure?: boolean
    envPinned?: Partial<RuntimeConfig['envPinned']>
  } = {}) {
    const store = new Store(openDb(':memory:'), { brakeAfter: opts.brakeAfter ?? 3 })
    const config = new RuntimeConfig(
      {
        accessPassword: opts.accessPassword ?? null,
        adminPasswordHash: opts.adminHash === undefined ? adminHash : opts.adminHash,
        brakeAfter: opts.brakeAfter ?? 3,
        port: 0,
        host: opts.host ?? '127.0.0.1',
        envPinned: {
          adminPasswordHash: false,
          accessPassword: false,
          brakeAfter: false,
          ...opts.envPinned,
        },
      },
      { allowInsecure: opts.allowInsecure ?? false, persist: () => {} },
    )
    const app = createApp({ store, hub: new Hub(), llm: new Llm(), pollWindowMs: 100, config })
    return { app, store, config }
  }

  function req(app: App, path: string, init?: RequestInit & { token?: string; accessPw?: string }) {
    const headers = new Headers(init?.headers)
    if (init?.body) headers.set('content-type', 'application/json')
    if (init?.token) headers.set('authorization', `Bearer ${init.token}`)
    if (init?.accessPw) headers.set('x-access-password', init.accessPw)
    return app.request(path, { ...init, headers })
  }

  async function loginSession(app: App) {
    const res = await req(app, '/api/auth/login', { method: 'POST', body: JSON.stringify({ password: ADMIN_PW }) })
    return (await res.json() as { session_token: string }).session_token
  }

  // ---- /api/auth/mode ----

  it('GET /api/auth/mode reports password mode', async () => {
    expect((await (await req(adminApp().app, '/api/auth/mode')).json() as any).password_mode).toBe(true)
    expect((await (await req(adminApp({ adminHash: null }).app, '/api/auth/mode')).json() as any).password_mode).toBe(false)
  })

  // ---- session management ----

  it('GET /api/auth/sessions lists sessions and marks the caller current', async () => {
    const { app } = adminApp()
    const s1 = await loginSession(app)
    await loginSession(app) // a second device
    const list = await (await req(app, '/api/auth/sessions', { token: s1 })).json() as any[]
    expect(list.length).toBe(2)
    expect(list.every((s) => typeof s.token === 'undefined')).toBe(true) // never expose tokens
    expect(list.filter((s) => s.current).length).toBe(1)
  })

  it('DELETE /api/auth/sessions/:id revokes only that session', async () => {
    const { app } = adminApp()
    const s1 = await loginSession(app)
    const s2 = await loginSession(app)
    const list = await (await req(app, '/api/auth/sessions', { token: s1 })).json() as any[]
    const other = list.find((s) => !s.current)!
    const del = await req(app, `/api/auth/sessions/${other.id}`, { method: 'DELETE', token: s1 })
    expect(del.status).toBe(204)
    // s1 still valid, s2 (the revoked one) now rejected on an adminOnly route
    expect((await req(app, '/api/rooms', { method: 'POST', body: '{}', token: s1 })).status).toBe(201)
    expect((await req(app, '/api/rooms', { method: 'POST', body: '{}', token: s2 })).status).toBe(403)
  })

  it('owner join refreshes the session last_used_at (regression for P1a leftover)', async () => {
    const { app, store } = adminApp()
    const session = await loginSession(app)
    const before = store.listSessions()[0]!.last_used_at
    const roomId = (await (await req(app, '/api/rooms', { method: 'POST', body: '{}', token: session })).json() as any).id
    await new Promise((r) => setTimeout(r, 5))
    await req(app, `/api/rooms/${roomId}/join`, { method: 'POST', body: JSON.stringify({ nickname: 'boss', type: 'human' }), token: session })
    const after = store.listSessions()[0]!.last_used_at
    expect(after >= before).toBe(true)
  })

  // ---- change admin password ----

  it('change password: correct old password rotates the credential', async () => {
    const { app } = adminApp()
    const session = await loginSession(app)
    const res = await req(app, '/api/auth/password', {
      method: 'POST', token: session,
      body: JSON.stringify({ old_password: ADMIN_PW, new_password: 'brand-new-pw' }),
    })
    expect(res.status).toBe(200)
    // old password no longer logs in, new one does
    expect((await req(app, '/api/auth/login', { method: 'POST', body: JSON.stringify({ password: ADMIN_PW }) })).status).toBe(401)
    expect((await req(app, '/api/auth/login', { method: 'POST', body: JSON.stringify({ password: 'brand-new-pw' }) })).status).toBe(201)
  })

  it('change password: wrong old password is rejected even with a valid session', async () => {
    const { app } = adminApp()
    const session = await loginSession(app)
    const res = await req(app, '/api/auth/password', {
      method: 'POST', token: session,
      body: JSON.stringify({ old_password: 'not-the-password', new_password: 'whatever' }),
    })
    expect(res.status).toBe(401)
  })

  it('change password: empty new password is rejected (never clears → would flip to local mode)', async () => {
    const { app } = adminApp()
    const session = await loginSession(app)
    const res = await req(app, '/api/auth/password', {
      method: 'POST', token: session,
      body: JSON.stringify({ old_password: ADMIN_PW, new_password: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('change password: rejected (409) when the admin password is env-pinned', async () => {
    const { app } = adminApp({ envPinned: { adminPasswordHash: true } })
    const session = await loginSession(app)
    const res = await req(app, '/api/auth/password', {
      method: 'POST', token: session,
      body: JSON.stringify({ old_password: ADMIN_PW, new_password: 'brand-new-pw' }),
    })
    expect(res.status).toBe(409)
  })

  it('change password: requires admin (no session → 401)', async () => {
    const { app } = adminApp()
    const res = await req(app, '/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ old_password: ADMIN_PW, new_password: 'x' }),
    })
    expect(res.status).toBe(401)
  })

  // ---- settings ----

  it('GET /api/admin/settings requires admin and returns the runtime knobs', async () => {
    const { app } = adminApp({ brakeAfter: 7 })
    expect((await req(app, '/api/admin/settings')).status).toBe(401) // no session
    const session = await loginSession(app)
    const s = await (await req(app, '/api/admin/settings', { token: session })).json() as any
    expect(s.brake_after).toBe(7)
    expect(s.access_gate.enabled).toBe(false)
    expect(s.password_mode).toBe(true)
  })

  it('PATCH brake_after updates the setting; env-pinned is rejected', async () => {
    const { app, config } = adminApp()
    const session = await loginSession(app)
    const ok = await req(app, '/api/admin/settings', { method: 'PATCH', token: session, body: JSON.stringify({ brake_after: 9 }) })
    expect((await ok.json() as any).brake_after).toBe(9)
    expect(config.brakeAfter).toBe(9)
    // invalid values
    expect((await req(app, '/api/admin/settings', { method: 'PATCH', token: session, body: JSON.stringify({ brake_after: 0 }) })).status).toBe(400)

    const pinned = adminApp({ envPinned: { brakeAfter: true } })
    const ps = await loginSession(pinned.app)
    expect((await req(pinned.app, '/api/admin/settings', { method: 'PATCH', token: ps, body: JSON.stringify({ brake_after: 5 }) })).status).toBe(409)
  })

  it('PATCH access_password enables and disables the gate at runtime', async () => {
    const { app } = adminApp()
    const session = await loginSession(app)
    // before: gate off, plain GET works
    expect((await req(app, '/api/rooms')).status).toBe(200)
    // a whitespace-only password is treated as disable intent, never installs a blank gate
    await req(app, '/api/admin/settings', { method: 'PATCH', token: session, body: JSON.stringify({ access_password: '   ' }) })
    expect((await req(app, '/api/rooms')).status).toBe(200) // still no gate
    // enable
    await req(app, '/api/admin/settings', { method: 'PATCH', token: session, body: JSON.stringify({ access_password: 'gate-pw' }) })
    expect((await req(app, '/api/rooms')).status).toBe(401) // no header now
    expect((await req(app, '/api/rooms', { accessPw: 'gate-pw' })).status).toBe(200)
    // disable (loopback host + admin password → allowed)
    await req(app, '/api/admin/settings', { method: 'PATCH', token: session, accessPw: 'gate-pw', body: JSON.stringify({ access_password: null }) })
    expect((await req(app, '/api/rooms')).status).toBe(200)
  })

  it('PATCH cannot disable the access gate when that would expose a public, unauthenticated server', async () => {
    // local mode (no admin password) + non-loopback bind + access gate on. Disabling would bypass
    // the startup checkSecureBind guard, so it must be refused.
    const { app } = adminApp({ adminHash: null, accessPassword: 'gate-pw', host: '0.0.0.0' })
    const res = await req(app, '/api/admin/settings', {
      method: 'PATCH', accessPw: 'gate-pw',
      body: JSON.stringify({ access_password: null }),
    })
    expect(res.status).toBe(409)
    // still gated
    expect((await req(app, '/api/rooms')).status).toBe(401)
  })

  // empty-string env vars must be treated as "unset", not as a pinned degenerate value
  it('loadServerConfig treats empty-string env vars as unset (no pin, no brake=0)', async () => {
    const saved = { a: process.env.CHATROOM_ACCESS_PASSWORD, b: process.env.CHATROOM_BRAKE_AFTER }
    process.env.CHATROOM_ACCESS_PASSWORD = ''
    process.env.CHATROOM_BRAKE_AFTER = ''
    try {
      const cfg = await loadServerConfig()
      expect(cfg.envPinned.accessPassword).toBe(false)
      expect(cfg.envPinned.brakeAfter).toBe(false)
      expect(cfg.brakeAfter).toBeGreaterThanOrEqual(1)
    } finally {
      if (saved.a === undefined) delete process.env.CHATROOM_ACCESS_PASSWORD
      else process.env.CHATROOM_ACCESS_PASSWORD = saved.a
      if (saved.b === undefined) delete process.env.CHATROOM_BRAKE_AFTER
      else process.env.CHATROOM_BRAKE_AFTER = saved.b
    }
  })
})
