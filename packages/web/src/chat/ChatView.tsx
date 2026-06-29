import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, isAuthError, type ChatEvent, type Identity, type Member, type PendingJoin } from '../api'
import { useI18n } from '../i18n'
import { AdminLoginModal } from '../admin/AdminLoginModal'
import { EventLine } from './EventLine'
import { PendingApprovalPanel } from './PendingApprovalPanel'

export function ChatView({
  roomId,
  identity,
  onStaleIdentity,
}: {
  roomId: string
  identity: Identity
  onStaleIdentity: () => void
}) {
  const { t } = useI18n()
  const [events, setEvents] = useState<ChatEvent[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [pendingJoins, setPendingJoins] = useState<PendingJoin[]>([])
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [showAdminLogin, setShowAdminLogin] = useState(false)
  // approval action to replay after a successful admin login (avoids a second click)
  const retryAfterLogin = useRef<(() => void) | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // caret position to restore after a controlled-value rewrite (mention complete / dismiss)
  const pendingCaret = useRef<number | null>(null)
  const offlineTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const prevOnlineRef = useRef<Map<string, boolean>>(new Map())
  const [graceUids, setGraceUids] = useState<Set<string>>(new Set())

  const memberByUid = useMemo(() => new Map(members.map((m) => [m.uid, m])), [members])
  const mentionNames = useMemo(() => members.map((m) => m.nickname), [members])
  const eventByMsgId = useMemo(() => new Map(events.map((e) => [e.msg_id, e])), [events])

  const refreshMembers = useCallback(() => {
    api.members(roomId, identity.token).then(setMembers).catch((err) => {
      // A token-level 401/403 means our stored participant token is stale → trigger recovery.
      // Exclude the access-gate 401 ('access password required'), which is not an identity problem
      // and must not trigger a re-join.
      if (isAuthError(err) && (err as Error).message !== 'access password required') onStaleIdentity()
      else console.error(err)
    })
  }, [roomId, identity.token, onStaleIdentity])

  useEffect(() => {
    refreshMembers()
    // SSE handles the fast path; fall back to 30s poll for resilience
    const timer = setInterval(refreshMembers, 30_000)
    return () => clearInterval(timer)
  }, [refreshMembers])

  useEffect(() => {
    const prev = prevOnlineRef.current
    for (const m of members) {
      const wasOnline = prev.get(m.uid) ?? false
      // treat busy (thinking/waiting) as online for grace-period purposes
      const effectiveOnline = m.online || m.status !== 'idle'
      if (wasOnline && !effectiveOnline && !offlineTimers.current.has(m.uid)) {
        setGraceUids(s => new Set(s).add(m.uid))
        offlineTimers.current.set(m.uid, setTimeout(() => {
          offlineTimers.current.delete(m.uid)
          setGraceUids(s => { const n = new Set(s); n.delete(m.uid); return n })
        }, 10_000))
      } else if (effectiveOnline && offlineTimers.current.has(m.uid)) {
        clearTimeout(offlineTimers.current.get(m.uid)!)
        offlineTimers.current.delete(m.uid)
        setGraceUids(s => { const n = new Set(s); n.delete(m.uid); return n })
      }
      prev.set(m.uid, effectiveOnline)
    }
  }, [members])

  useEffect(() => {
    return () => { for (const t of offlineTimers.current.values()) clearTimeout(t) }
  }, [])

  // Poll pending joins every 5s (human/admin users only)
  const refreshPendingJoins = useCallback(() => {
    api.pendingJoins(roomId, identity.token).then(setPendingJoins).catch(() => {/* non-admin: ignore */})
  }, [roomId, identity.token])

  useEffect(() => {
    refreshPendingJoins()
    const timer = setInterval(refreshPendingJoins, 5_000)
    return () => clearInterval(timer)
  }, [refreshPendingJoins])

  useEffect(() => {
    const es = new EventSource(`/api/rooms/${roomId}/stream?token=${identity.token}`)
    es.addEventListener('chat', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as ChatEvent
      setEvents((prev) => (prev.some((p) => p.seq === ev.seq) ? prev : [...prev, ev]))
      if (ev.kind === 'room_deleted') { location.hash = ''; return }
      if (ev.kind === 'member_joined' || ev.kind === 'member_left' || ev.kind === 'nickname_changed') refreshMembers()
    })
    es.addEventListener('status', (e) => {
      const { uid, status } = JSON.parse((e as MessageEvent).data) as { uid: string; status: 'idle' | 'thinking' | 'waiting_human' }
      setMembers((prev) => prev.map((m) => m.uid === uid ? { ...m, status, online: m.online || status !== 'idle' } : m))
    })
    es.addEventListener('presence:snapshot', (e) => {
      const { online } = JSON.parse((e as MessageEvent).data) as { online: string[] }
      const onlineSet = new Set(online)
      setMembers((prev) => prev.map((m) => ({ ...m, online: onlineSet.has(m.uid) || m.status !== 'idle' })))
    })
    es.addEventListener('presence', (e) => {
      const { uid, online } = JSON.parse((e as MessageEvent).data) as { uid: string; online: boolean }
      setMembers((prev) => prev.map((m) => m.uid === uid ? { ...m, online: online || m.status !== 'idle' } : m))
    })
    let lastErrorPoll = 0
    es.onerror = () => {
      const now = Date.now()
      if (now - lastErrorPoll > 5_000) {
        lastErrorPoll = now
        refreshMembers()
      }
    }
    return () => es.close()
  }, [roomId, identity.token, refreshMembers])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events.length])

  const send = async () => {
    const t = text.trim()
    if (!t) return
    try {
      await api.sendMessage(roomId, identity.token, t)
      setText('')
      setError('')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  // bumped on caret movement so the mention match below re-reads the live caret position
  const [, bumpCaret] = useState(0)
  // mention autocomplete on the "@partial" ending at the caret (not just the end of text),
  // so earlier mentions in "@foo @bar" can be completed too.
  // NOTE: reading the live DOM caret during render is impure; safe here because we don't use
  // concurrent rendering / StrictMode double-render, and typing/onSelect always re-render.
  const caret = inputRef.current?.selectionStart ?? text.length
  const mentionMatch = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, caret))
  const suggestions = mentionMatch
    ? members.filter((m) => m.uid !== identity.uid && m.nickname.startsWith(mentionMatch[1]))
    : []
  const [mentionIdx, setMentionIdx] = useState(0)
  const clampedIdx = Math.min(mentionIdx, Math.max(0, suggestions.length - 1))
  // restore the caret after a controlled rewrite, before paint, to avoid it jumping to the end
  useLayoutEffect(() => {
    if (pendingCaret.current != null) {
      const pos = pendingCaret.current
      pendingCaret.current = null
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(pos, pos)
    }
  })
  const completeMention = (nickname: string) => {
    // keep the leading "@" and prefix; replace only the partial nickname ending at the caret
    const partialStart = caret - mentionMatch![1].length
    setText(text.slice(0, partialStart) + nickname + ' ' + text.slice(caret))
    pendingCaret.current = partialStart + nickname.length + 1
    setMentionIdx(0)
  }

  return (
    <>
      {showAdminLogin && (
        <AdminLoginModal
          onSuccess={() => {
            setShowAdminLogin(false)
            const retry = retryAfterLogin.current
            retryAfterLogin.current = null
            retry?.()
          }}
          onClose={() => { retryAfterLogin.current = null; setShowAdminLogin(false) }}
        />
      )}
      <main className="chat">
        <div className="messages">
          {events.map((ev) => (
            <EventLine
              key={ev.seq}
              ev={ev}
              eventByMsgId={eventByMsgId}
              memberByUid={memberByUid}
              myUid={identity.uid}
              mentionNames={mentionNames}
            />
          ))}
          <div ref={bottomRef} />
        </div>
        <div className="composer">
          {suggestions.length > 0 && (
            <div className="mention-pop">
              {suggestions.map((m, i) => (
                <button key={m.uid} className={i === clampedIdx ? 'active' : ''} onClick={() => completeMention(m.nickname)}>
                  @{m.nickname} <small>{m.type === 'agent' ? m.persona_name ?? 'agent' : 'human'}</small>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={text}
            placeholder={t('composer.placeholder')}
            onChange={(e) => setText(e.target.value)}
            onSelect={() => bumpCaret((n) => n + 1)}
            onKeyDown={(e) => {
              if (suggestions.length > 0) {
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                  e.preventDefault()
                  completeMention(suggestions[clampedIdx].nickname)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setMentionIdx((clampedIdx - 1 + suggestions.length) % suggestions.length)
                  return
                }
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setMentionIdx((clampedIdx + 1) % suggestions.length)
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  // drop the matched "@partial" (incl. its leading prefix) at the caret
                  setText(text.slice(0, mentionMatch!.index) + text.slice(caret))
                  pendingCaret.current = mentionMatch!.index
                  setMentionIdx(0)
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          {error && <p className="error">{error}</p>}
        </div>
      </main>
      <aside className="members">
        {pendingJoins.length > 0 && (
          <PendingApprovalPanel
            roomId={roomId}
            token={identity.token}
            requests={pendingJoins}
            members={members}
            onDone={() => { refreshPendingJoins(); refreshMembers() }}
            onAdminAuthRequired={(retry) => { retryAfterLogin.current = retry ?? null; setShowAdminLogin(true) }}
          />
        )}
        <h3>{t('members.title')}</h3>
        {members.map((m) => (
          <div key={m.uid} className="member">
            <span className={`dot ${m.online ? 'online' : graceUids.has(m.uid) ? 'grace' : ''}`} />
            <span className={`nick ${m.type}`}>{m.nickname}</span>
            {m.status === 'thinking' && <span className="thinking-dots"><span /><span /><span /></span>}
            {m.status === 'waiting_human' && <span className="waiting-badge">⏸ {t('members.waitingHuman')}</span>}
            {m.persona_name && <span className="badge">{m.persona_name}</span>}
            {m.uid === identity.uid && <span className="badge me">{t('members.me')}</span>}
          </div>
        ))}
      </aside>
    </>
  )
}
