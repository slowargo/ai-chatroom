/** Minimal HTTP client for the chatroom server. Shared by the CLI and the MCP server. */

export class ChatroomClient {
  /** @param {{server: string, token?: string, room_id?: string}} opts */
  constructor(opts) {
    this.server = opts.server.replace(/\/+$/, '')
    this.token = opts.token
    this.roomId = opts.room_id
  }

  async req(method, path, { body, query, timeoutMs } = {}) {
    const url = new URL(this.server + path)
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    }
    const res = await fetch(url, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const err = new Error(data.error ?? `HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    return data
  }

  listRooms() {
    return this.req('GET', '/api/rooms')
  }

  createRoom(title = '') {
    return this.req('POST', '/api/rooms', { body: { title } })
  }

  listPersonas() {
    return this.req('GET', '/api/personas')
  }

  async join({ roomId, nickname, type = 'agent', personaId, token }) {
    const joined = await this.req('POST', `/api/rooms/${roomId}/join`, {
      body: { nickname, type, persona_id: personaId, token },
    })
    this.token = joined.token
    this.roomId = roomId
    return joined
  }

  /** One long-poll request; the server returns within ~windowMs either way. */
  waitOnce(windowMs) {
    return this.req('GET', `/api/rooms/${this.roomId}/wait`, {
      query: { window_ms: windowMs },
      timeoutMs: windowMs + 10_000,
    })
  }

  /**
   * Block until a mention wakes us, retrying through poll timeouts and
   * transient network errors (server restarts). Invisible to the caller.
   */
  async waitForMention({ windowMs = 25_000, onRetry } = {}) {
    let backoffMs = 2000
    for (;;) {
      let res
      try {
        res = await this.waitOnce(windowMs)
        backoffMs = 2000
      } catch (err) {
        if (err.status === 401 || err.status === 403) throw err
        onRetry?.(err)
        await new Promise((r) => setTimeout(r, backoffMs))
        backoffMs = Math.min(backoffMs * 2, 30_000)
        continue
      }
      if (res.woke) return res
    }
  }

  post({ text, replyTo }) {
    return this.req('POST', `/api/rooms/${this.roomId}/messages`, {
      body: { text, in_reply_to: replyTo },
    })
  }

  ack(seq) {
    return this.req('POST', `/api/rooms/${this.roomId}/ack`, { body: { seq } })
  }

  history({ after = 0, limit = 200 } = {}) {
    return this.req('GET', `/api/rooms/${this.roomId}/events`, { query: { after, limit } })
  }

  members() {
    return this.req('GET', `/api/rooms/${this.roomId}/members`)
  }
}
