import type { ChatEvent } from './types.js'

type Listener = (ev: ChatEvent) => void
type StatusListener = (uid: string, status: 'idle' | 'thinking' | 'waiting_human') => void
type PresenceListener = (uid: string, online: boolean) => void
type RoomChangeListener = (type: string, data: unknown) => void

/**
 * In-process fan-out for live events plus presence tracking.
 * Durability lives in SQLite; the hub is only a notification channel —
 * a missed notification is recovered by the cursor catch-up on the next poll.
 */
export class Hub {
  private listeners = new Map<string, Set<Listener>>()
  private presence = new Map<string, Map<string, number>>()
  private thinking = new Map<string, Set<string>>()           // roomId → Set of thinking uids
  private waiting = new Map<string, Set<string>>()            // roomId → Set of waiting_human uids
  private statusListeners = new Map<string, Set<StatusListener>>() // roomId → listeners
  private presenceListeners = new Map<string, Set<PresenceListener>>() // roomId → listeners
  private roomChangeListeners = new Set<RoomChangeListener>()

  subscribe(roomId: string, fn: Listener): () => void {
    let set = this.listeners.get(roomId)
    if (!set) this.listeners.set(roomId, (set = new Set()))
    set.add(fn)
    return () => set.delete(fn)
  }

  publish(roomId: string, events: ChatEvent[]): void {
    const set = this.listeners.get(roomId)
    if (!set) return
    for (const ev of events) {
      for (const fn of [...set]) {
        try {
          fn(ev)
        } catch {
          // a broken subscriber must not break fan-out to the others
        }
      }
    }
  }

  /** Wait until an event matching `match` arrives, or the window elapses. */
  waitFor(roomId: string, match: (ev: ChatEvent) => boolean, windowMs: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false
      const finish = (hit: boolean) => {
        if (done) return
        done = true
        clearTimeout(timer)
        unsub()
        signal?.removeEventListener('abort', onAbort)
        resolve(hit)
      }
      const onAbort = () => finish(false)
      const unsub = this.subscribe(roomId, (ev) => {
        if (match(ev)) finish(true)
      })
      const timer = setTimeout(() => finish(false), windowMs)
      if (signal) {
        if (signal.aborted) return finish(false)
        signal.addEventListener('abort', onAbort)
      }
    })
  }

  /** Refcounted presence: a participant is online while it has at least one active wait/stream. */
  track(roomId: string, uid: string): () => void {
    let room = this.presence.get(roomId)
    if (!room) this.presence.set(roomId, (room = new Map()))
    const prev = room.get(uid) ?? 0
    room.set(uid, prev + 1)
    if (prev === 0) this.broadcastPresence(roomId, uid, true)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = room.get(uid) ?? 0
      if (count <= 1) {
        room.delete(uid)
        const wasBusy = this.isBusy(roomId, uid)
        this.clearThinking(roomId, uid)  // clears both thinking and waiting; broadcasts presence offline if needed
        if (!wasBusy) this.broadcastPresence(roomId, uid, false)
      } else room.set(uid, count - 1)
    }
  }

  online(roomId: string): Set<string> {
    return new Set(this.presence.get(roomId)?.keys() ?? [])
  }

  /** Derived status for a uid: waiting_human > thinking > idle. */
  statusOf(roomId: string, uid: string): 'idle' | 'thinking' | 'waiting_human' {
    if (this.waiting.get(roomId)?.has(uid)) return 'waiting_human'
    if (this.thinking.get(roomId)?.has(uid)) return 'thinking'
    return 'idle'
  }

  /** True if the uid is in either the thinking or waiting set (implies online). */
  isBusy(roomId: string, uid: string): boolean {
    return !!(this.thinking.get(roomId)?.has(uid) || this.waiting.get(roomId)?.has(uid))
  }

  /** Returns the unified online set: refcount-tracked presence plus busy (thinking/waiting) agents. */
  onlineWithThinking(roomId: string): Set<string> {
    const result = new Set(this.presence.get(roomId)?.keys() ?? [])
    for (const uid of this.thinking.get(roomId) ?? []) result.add(uid)
    for (const uid of this.waiting.get(roomId) ?? []) result.add(uid)
    return result
  }

  subscribeRoomChanges(fn: RoomChangeListener): () => void {
    this.roomChangeListeners.add(fn)
    return () => this.roomChangeListeners.delete(fn)
  }

  broadcastRoomChange(type: string, data: unknown): void {
    for (const fn of [...this.roomChangeListeners]) {
      try { fn(type, data) } catch { /* broken subscriber must not break fan-out */ }
    }
  }

  subscribePresence(roomId: string, fn: PresenceListener): () => void {
    let set = this.presenceListeners.get(roomId)
    if (!set) this.presenceListeners.set(roomId, (set = new Set()))
    set.add(fn)
    return () => set.delete(fn)
  }

  private broadcastPresence(roomId: string, uid: string, online: boolean): void {
    for (const fn of [...(this.presenceListeners.get(roomId) ?? [])]) {
      try { fn(uid, online) } catch { /* broken subscriber must not break fan-out */ }
    }
  }

  subscribeStatus(roomId: string, fn: StatusListener): () => void {
    let set = this.statusListeners.get(roomId)
    if (!set) this.statusListeners.set(roomId, (set = new Set()))
    set.add(fn)
    return () => set.delete(fn)
  }

  setThinking(roomId: string, uid: string): void {
    let set = this.thinking.get(roomId)
    if (!set) this.thinking.set(roomId, (set = new Set()))
    const wasBusy = this.isBusy(roomId, uid)
    set.add(uid)
    const status = this.statusOf(roomId, uid)
    for (const fn of [...(this.statusListeners.get(roomId) ?? [])]) {
      try { fn(uid, status) } catch { /* broken subscriber must not break fan-out */ }
    }
    // busy agents count as online even without a stream connection
    if (!wasBusy && !(this.presence.get(roomId)?.has(uid))) {
      this.broadcastPresence(roomId, uid, true)
    }
  }

  /** Signal that this agent is paused waiting for its local human operator. */
  setWaiting(roomId: string, uid: string): void {
    let set = this.waiting.get(roomId)
    if (!set) this.waiting.set(roomId, (set = new Set()))
    const wasBusy = this.isBusy(roomId, uid)
    set.add(uid)
    const status = this.statusOf(roomId, uid)
    for (const fn of [...(this.statusListeners.get(roomId) ?? [])]) {
      try { fn(uid, status) } catch { /* broken subscriber must not break fan-out */ }
    }
    // waiting agents count as online even without a stream connection
    if (!wasBusy && !(this.presence.get(roomId)?.has(uid))) {
      this.broadcastPresence(roomId, uid, true)
    }
  }

  /** Clear both thinking and waiting state for a uid (called on /wait entry and untrack refcount→0). */
  clearThinking(roomId: string, uid: string): void {
    const wasThinking = this.thinking.get(roomId)?.has(uid) ?? false
    const wasWaiting = this.waiting.get(roomId)?.has(uid) ?? false
    if (!wasThinking && !wasWaiting) return
    this.thinking.get(roomId)?.delete(uid)
    this.waiting.get(roomId)?.delete(uid)
    // status is now idle
    for (const fn of [...(this.statusListeners.get(roomId) ?? [])]) {
      try { fn(uid, 'idle') } catch { /* broken subscriber must not break fan-out */ }
    }
    // if no stream connection either, the agent has gone fully offline
    if (!(this.presence.get(roomId)?.has(uid))) {
      this.broadcastPresence(roomId, uid, false)
    }
  }
}
