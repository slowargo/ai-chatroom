/** Minimal HTTP client for the chatroom server. Shared by the CLI and the MCP server. */

import { getPasswordForServer } from './config.js'

/**
 * Combine AbortSignals into one without requiring AbortSignal.any (Node 20.3+):
 * keeps the floor at the Node version fetch already needs. Aborts as soon as any
 * input does, propagating its reason.
 *
 * Returns a `cleanup` that MUST be called once the request settles. A long-lived
 * input (the MCP host's `signal`) outlives a single shard, so without cleanup
 * every block-until-woken poll would leave a never-firing abort listener on it
 * and leak (MaxListenersExceededWarning + unbounded growth over a resident wait).
 */
function combineSignals(signals) {
  const ac = new AbortController()
  const cleanups = []
  for (const s of signals) {
    if (s.aborted) {
      ac.abort(s.reason)
      break
    }
    const onAbort = () => ac.abort(s.reason)
    s.addEventListener('abort', onAbort, { once: true })
    cleanups.push(() => s.removeEventListener('abort', onAbort))
  }
  return { signal: ac.signal, cleanup: () => { for (const fn of cleanups) fn() } }
}

export class ChatroomClient {
  /** @param {{server: string, token?: string, room_id?: string, password?: string}} opts */
  constructor(opts) {
    this.server = opts.server.replace(/\/+$/, '')
    this.token = opts.token
    this.roomId = opts.room_id
    this.password = opts.password ?? getPasswordForServer(opts.server)
  }

  async req(method, path, { body, query, timeoutMs, allowStatus, signal } = {}) {
    const url = new URL(this.server + path)
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    }
    // combine the per-request timeout with an optional external abort (e.g. MCP host cancel)
    const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
    let reqSignal = signal ?? timeoutSignal
    let cleanup
    if (timeoutSignal && signal) {
      const combined = combineSignals([timeoutSignal, signal])
      reqSignal = combined.signal
      cleanup = combined.cleanup
    }
    try {
      const res = await fetch(url, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(this.password ? { 'x-access-password': this.password } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: reqSignal,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok && !(allowStatus && allowStatus.includes(res.status))) {
        const err = new Error(data.error ?? `HTTP ${res.status}`)
        err.status = res.status
        throw err
      }
      return { status: res.status, data }
    } finally {
      cleanup?.()
    }
  }

  listRooms() {
    return this.req('GET', '/api/rooms').then((r) => r.data)
  }

  createRoom(title = '', { cwd, machine_id } = {}) {
    return this.req('POST', '/api/rooms', { body: { title, cwd, machine_id } }).then((r) => r.data)
  }

  resolveRoom(cwd, machineId) {
    return this.req('GET', '/api/rooms/resolve', { query: { cwd, machine_id: machineId } }).then((r) => r.data)
  }

  listPersonas() {
    return this.req('GET', '/api/personas').then((r) => r.data)
  }

  async join({ roomId, nickname, type = 'agent', personaId, token, nicknameHint }) {
    const { status, data } = await this.req('POST', `/api/rooms/${roomId}/join`, {
      body: { nickname, type, persona_id: personaId, token, nickname_hint: nicknameHint },
      allowStatus: [202],
    })
    // 202 means pending approval — do NOT set this.token
    if (status === 202) {
      return { status: 'pending', request_id: data.request_id }
    }
    this.token = data.token
    this.roomId = roomId
    return data
  }

  /** Poll for pending join approval; blocks up to 60s on the server side. */
  async pollPendingJoin({ roomId, requestId }) {
    const { data } = await this.req('GET', `/api/rooms/${roomId}/pending-joins/${requestId}/poll`, {
      timeoutMs: 70_000,
    })
    return data
  }

  /** One long-poll request; the server returns within ~windowMs either way. */
  waitOnce(windowMs, signal) {
    return this.req('GET', `/api/rooms/${this.roomId}/wait`, {
      query: { window_ms: windowMs },
      timeoutMs: windowMs + 10_000,
      signal,
    }).then((r) => r.data)
  }

  /**
   * Block until a mention wakes us, retrying through poll timeouts and
   * transient network errors (server restarts). Invisible to the caller.
   * If an external `signal` aborts (e.g. the MCP host cancels the tool call),
   * the in-flight /wait is closed via the same signal and this resolves to null
   * instead of looping — so an abort never leaves an orphaned long-poll behind.
   * A transport drop (signal not aborted) is retried; only an abort exits.
   *
   * `maxConsecutiveRetries` is a backstop for the B+ (signal-bearing) path: if an
   * abort ever reaches us as a bare transport error without aborting `signal`
   * (host misbehaviour), the loop would otherwise retry forever. Capping
   * consecutive failures bounds that worst case. It defaults to Infinity so the
   * resident CLI path keeps reconnecting through long outages. The counter resets
   * on any successful poll, so a healthy listener never trips it.
   */
  async waitForMention({ windowMs = 25_000, onRetry, signal, maxConsecutiveRetries = Infinity } = {}) {
    let backoffMs = 2000
    let consecutiveRetries = 0
    for (;;) {
      if (signal?.aborted) return null
      let res
      try {
        res = await this.waitOnce(windowMs, signal)
        backoffMs = 2000
        consecutiveRetries = 0
      } catch (err) {
        if (signal?.aborted) return null
        if (err.status === 401 || err.status === 403) throw err
        if (++consecutiveRetries > maxConsecutiveRetries) return null
        onRetry?.(err)
        await new Promise((resolve) => {
          let timer
          const onAbort = () => { clearTimeout(timer); resolve() }
          timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
          }, backoffMs)
          signal?.addEventListener('abort', onAbort, { once: true })
        })
        backoffMs = Math.min(backoffMs * 2, 10_000)
        continue
      }
      if (res.woke) return res
    }
  }

  post({ text, replyTo }) {
    return this.req('POST', `/api/rooms/${this.roomId}/messages`, {
      body: { text, in_reply_to: replyTo },
    }).then((r) => r.data)
  }

  ack(seq) {
    return this.req('POST', `/api/rooms/${this.roomId}/ack`, { body: { seq } }).then((r) => r.data)
  }

  setStatus(status) {
    return this.req('POST', `/api/rooms/${this.roomId}/status`, { body: { status } }).then((r) => r.data)
  }

  history({ after = 0, limit = 200 } = {}) {
    return this.req('GET', `/api/rooms/${this.roomId}/events`, { query: { after, limit } }).then((r) => r.data)
  }

  members() {
    return this.req('GET', `/api/rooms/${this.roomId}/members`).then((r) => r.data)
  }
}
