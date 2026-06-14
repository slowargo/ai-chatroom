import type { ChatEvent } from './types.js'

type Listener = (ev: ChatEvent) => void
type StatusListener = (uid: string, thinking: boolean) => void

/**
 * In-process fan-out for live events plus presence tracking.
 * Durability lives in SQLite; the hub is only a notification channel —
 * a missed notification is recovered by the cursor catch-up on the next poll.
 */
export class Hub {
  private listeners = new Map<string, Set<Listener>>()
  private presence = new Map<string, Map<string, number>>()
  private thinking = new Map<string, Set<string>>()           // roomId → Set of thinking uids
  private statusListeners = new Map<string, Set<StatusListener>>() // roomId → listeners

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
    room.set(uid, (room.get(uid) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = room.get(uid) ?? 0
      if (count <= 1) {
        room.delete(uid)
        this.clearThinking(roomId, uid)
      } else room.set(uid, count - 1)
    }
  }

  online(roomId: string): Set<string> {
    return new Set(this.presence.get(roomId)?.keys() ?? [])
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
    set.add(uid)
    for (const fn of [...(this.statusListeners.get(roomId) ?? [])]) {
      try { fn(uid, true) } catch { /* broken subscriber must not break fan-out */ }
    }
  }

  clearThinking(roomId: string, uid: string): void {
    const set = this.thinking.get(roomId)
    if (!set?.has(uid)) return
    set.delete(uid)
    for (const fn of [...(this.statusListeners.get(roomId) ?? [])]) {
      try { fn(uid, false) } catch { /* broken subscriber must not break fan-out */ }
    }
  }

  isThinking(roomId: string, uid: string): boolean {
    return this.thinking.get(roomId)?.has(uid) ?? false
  }
}
