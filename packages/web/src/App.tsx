import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { version } from '../package.json'
import {
  api,
  clearSessionToken,
  isAuthError,
  identityKey,
  initAccessPassword,
  loadIdentity,
  loadLastNickname,
  loadSessionToken,
  saveIdentity,
  saveLastNickname,
  saveSessionToken,
  setAccessPassword,
  type AdminSettings,
  type ChatEvent,
  type Identity,
  type LlmInfo,
  type Member,
  type PendingJoin,
  type Persona,
  type Room,
  type SessionInfo,
} from './api'
import { Markdown } from './markdown'
import { LOCALES, useI18n } from './i18n'

// Initialize access password from localStorage on module load
initAccessPassword()

export default function App() {
  const { t } = useI18n()
  const [rooms, setRooms] = useState<Room[]>([])
  const [roomId, setRoomId] = useState<string | null>(() => location.hash.slice(1) || null)
  const [showAdmin, setShowAdmin] = useState(false)
  const [showAdminLogin, setShowAdminLogin] = useState(false)
  // bumped when the admin panel switches the LLM model, so the read-only main view re-fetches
  const [llmVersion, setLlmVersion] = useState(0)
  // null while loading. password mode = admin login required; local mode = fully trusted (everyone admin).
  const [passwordMode, setPasswordMode] = useState<boolean | null>(null)
  const [hasSession, setHasSession] = useState(() => !!loadSessionToken())
  // Transient "you have been logged out" notice, shown after the admin logs out or revokes their
  // own current session. Auto-dismisses so it never lingers.
  const [loggedOut, setLoggedOut] = useState(false)
  useEffect(() => {
    if (!loggedOut) return
    const timer = setTimeout(() => setLoggedOut(false), 4000)
    return () => clearTimeout(timer)
  }, [loggedOut])

  // Explicit admin gating (replaces relying on silent 403s): in local mode everyone is admin; in
  // password mode the admin is whoever holds a session token. A stale token still falls back to the
  // 401/403 → login flow below.
  const isAdmin = passwordMode === false || hasSession

  useEffect(() => {
    api.authMode().then((m) => {
      setPasswordMode(m.password_mode)
      // Local mode: drop any stale session token (e.g. left over from a prior password-mode run).
      // The functional fix lives in api.ts (it never sends the token in local mode); this just keeps
      // localStorage and hasSession honest instead of carrying dead state around.
      if (!m.password_mode && loadSessionToken()) {
        clearSessionToken()
        setHasSession(false)
      }
    }).catch(() => setPasswordMode(false))
  }, [])

  const refreshRooms = useCallback(() => {
    api.rooms().then(setRooms).catch(console.error)
  }, [])

  useEffect(() => {
    // Try the global SSE stream first. If the server returns 403 (access password enabled),
    // fall back to polling /api/rooms with the x-access-password header.
    let usingSSE = true
    let pollTimer: ReturnType<typeof setInterval> | null = null

    const startPolling = () => {
      if (!usingSSE) return // already polling
      usingSSE = false
      refreshRooms()
      pollTimer = setInterval(refreshRooms, 10_000)
    }

    const es = new EventSource('/api/rooms/stream')
    es.addEventListener('rooms:snapshot', (e) => {
      setRooms(JSON.parse((e as MessageEvent).data))
    })
    es.addEventListener('room:created', (e) => {
      const room = JSON.parse((e as MessageEvent).data) as Room
      // listRooms orders by created_at DESC, so newest rooms belong at the head
      setRooms(prev => prev.some(r => r.id === room.id) ? prev : [room, ...prev])
    })
    es.addEventListener('room:deleted', (e) => {
      const { id } = JSON.parse((e as MessageEvent).data) as Room
      setRooms(prev => prev.filter(r => r.id !== id))
    })
    es.addEventListener('room:updated', (e) => {
      const room = JSON.parse((e as MessageEvent).data) as Room
      setRooms(prev => prev.map(r => r.id === room.id ? room : r))
    })
    let lastErrorPoll = 0
    es.onerror = () => {
      const now = Date.now()
      // If we haven't received a snapshot yet, the stream is likely gated (403) — switch to polling
      if (rooms.length === 0) {
        es.close()
        startPolling()
        return
      }
      if (now - lastErrorPoll > 5_000) {
        lastErrorPoll = now
        refreshRooms()
      }
    }
    // 60s polling fallback for last_seq (message count) freshness
    const freshnessTimer = setInterval(refreshRooms, 60_000)
    return () => {
      es.close()
      if (pollTimer) clearInterval(pollTimer)
      clearInterval(freshnessTimer)
    }
  }, [refreshRooms]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onHash = () => setRoomId(location.hash.slice(1) || null)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // The action that triggered an admin-login prompt, replayed once login succeeds so the user does
  // not have to click twice. Held in a ref so replacing it never causes a re-render.
  const retryAfterLogin = useRef<(() => void) | null>(null)
  const requireAdmin = (retry: () => void) => {
    retryAfterLogin.current = retry
    setShowAdminLogin(true)
  }

  const createRoom = async () => {
    try {
      const room = await api.createRoom()
      setRooms(prev => prev.some(r => r.id === room.id) ? prev : [room, ...prev])
      location.hash = room.id
    } catch (err) {
      if (isAuthError(err)) requireAdmin(createRoom)
      else console.error(err)
    }
  }

  const doDeleteRoom = async (id: string) => {
    try {
      await api.deleteRoom(id)
      localStorage.removeItem(identityKey(id))
      if (roomId === id) location.hash = ''
      setRooms(prev => prev.filter(r => r.id !== id))
    } catch (err) {
      if (isAuthError(err)) requireAdmin(() => doDeleteRoom(id))
      else console.error(err)
    }
  }

  const deleteRoom = (e: React.MouseEvent, id: string) => {
    e.preventDefault()
    e.stopPropagation()
    if (!confirm(t('room.confirmDelete'))) return
    void doDeleteRoom(id)
  }

  return (
    <div className="layout">
      {loggedOut && (
        <div className="logout-notice" role="status" onClick={() => setLoggedOut(false)}>
          {t('admin.loggedOut')}
        </div>
      )}
      {showAdminLogin && (
        <AdminLoginModal
          onSuccess={() => {
            setShowAdminLogin(false)
            setHasSession(true)
            const retry = retryAfterLogin.current
            retryAfterLogin.current = null
            retry?.()
          }}
          onClose={() => { retryAfterLogin.current = null; setShowAdminLogin(false) }}
        />
      )}
      <aside className="sidebar">
        <header>
          <h1>{t('app.title')}</h1>
          {isAdmin && <button onClick={createRoom}>{t('room.new')}</button>}
        </header>
        <nav>
          {rooms.map((r) => (
            <a key={r.id} href={`#${r.id}`} className={r.id === roomId ? 'active' : ''}>
              <span className="room-title" title={r.title || t('room.unnamed')}>
                {r.title || t('room.unnamed')}
              </span>
              <span className="room-meta">
                {t('room.messageCount', { count: r.last_seq })}
                {isAdmin && (
                  <button className="room-delete" onClick={(e) => deleteRoom(e, r.id)} title={t('room.delete')}>×</button>
                )}
              </span>
            </a>
          ))}
        </nav>
        <footer>
          <LlmStatus refreshKey={llmVersion} />
          {isAdmin && (
            <button className="link" onClick={() => setShowAdmin((v) => !v)}>
              {showAdmin ? t('nav.backToChat') : t('nav.admin')}
            </button>
          )}
          {passwordMode && !hasSession && (
            <button className="link" onClick={() => setShowAdminLogin(true)}>{t('admin.login')}</button>
          )}
          <LanguageSwitcher />
          <span className="version">v{version}</span>
        </footer>
      </aside>
      {showAdmin ? (
        <AdminPanel
          passwordMode={!!passwordMode}
          onLoggedOut={() => { setHasSession(false); setShowAdmin(false); setLoggedOut(true) }}
          onLlmChange={() => setLlmVersion((v) => v + 1)}
        />
      ) : roomId ? (
        <ChatRoom key={roomId} roomId={roomId} />
      ) : (
        <main className="empty">{t('empty.selectOrCreate')}</main>
      )}
    </div>
  )
}

/**
 * Modal dialog for admin login.
 * On success, saves the session token to localStorage and calls onSuccess.
 * The token is then automatically picked up by adminCredential() in api.ts.
 */
function AdminLoginModal({ onSuccess, onClose }: { onSuccess: () => void; onClose: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const doLogin = async () => {
    if (!password) return
    setLoading(true)
    setError('')
    try {
      const { session_token } = await api.login(password)
      saveSessionToken(session_token)
      onSuccess()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const doLogout = () => {
    clearSessionToken()
    onClose()
  }

  const hasSession = !!loadSessionToken()

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2>Admin Login</h2>
        {hasSession && (
          <p className="modal-hint">You have an active session. Log out to invalidate it.</p>
        )}
        <input
          ref={inputRef}
          type="password"
          placeholder="Admin password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !loading && doLogin()}
        />
        <div className="modal-actions">
          <button disabled={!password || loading} onClick={doLogin}>
            {loading ? 'Logging in…' : 'Login'}
          </button>
          {hasSession && (
            <button className="link" onClick={doLogout}>
              Logout (clear session)
            </button>
          )}
          <button className="link" onClick={onClose}>Cancel</button>
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  )
}

function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n()
  return (
    <select
      className="lang-select"
      title={t('lang.label')}
      value={locale}
      onChange={(e) => setLocale(e.target.value as typeof locale)}
    >
      {LOCALES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.label}
        </option>
      ))}
    </select>
  )
}

function LlmStatus({ refreshKey }: { refreshKey: number }) {
  const { t } = useI18n()
  const [info, setInfo] = useState<LlmInfo | null>(null)

  useEffect(() => {
    api.llm().then(setInfo).catch(console.error)
  }, [refreshKey])

  if (!info) return null
  if (!info.enabled) return <p className="llm-status off">{t('llm.notConfigured')}</p>

  // Model switching now lives in the admin settings panel; the main view is read-only.
  return (
    <div className="llm-status">
      <span className="llm-label">LLM</span>
      <span className="badge" title={t('llm.providerTitle')}>{info.provider}</span>
      <span className="llm-model" title={t('llm.modelTitle')}>{info.model ?? '—'}</span>
    </div>
  )
}

function ChatRoom({ roomId }: { roomId: string }) {
  const [identity, setIdentity] = useState<Identity | null>(() => loadIdentity(roomId))
  // Guards the async recovery window so the members poll and the SSE onerror handler can't both
  // fire a re-join at once.
  const recovering = useRef(false)
  // Called when a room request rejects our stored participant token (stale — e.g. the row's token
  // was rotated by an approve-bind from another client, leaving this browser behind). In local mode
  // re-joining by nickname reclaims the SAME identity with its current token, healing in place. If
  // that fails (e.g. password mode, where credential-less reclaim is disabled and returns 409), drop
  // the stale identity and fall back to JoinGate so the user can recover manually.
  const handleStaleIdentity = useCallback(async () => {
    if (recovering.current) return
    recovering.current = true
    try {
      const nickname = identity?.nickname ?? loadLastNickname()
      const joined = await api.join(roomId, { nickname, type: 'human' })
      const fresh = { uid: joined.uid, token: joined.token, nickname: joined.nickname }
      saveIdentity(roomId, fresh)
      setIdentity(fresh)
    } catch {
      localStorage.removeItem(identityKey(roomId))
      setIdentity(null)
    } finally {
      recovering.current = false
    }
  }, [roomId, identity?.nickname])
  if (!identity) {
    return <JoinGate roomId={roomId} onJoined={setIdentity} />
  }
  // No remount key: reclaim keeps the same uid and only swaps the token, so updating the identity
  // prop lets ChatView's token-keyed effects re-run (SSE reconnect, refetch) and recover seamlessly
  // while preserving the loaded events and the message draft.
  return <ChatView roomId={roomId} identity={identity} onStaleIdentity={handleStaleIdentity} />
}

function JoinGate({ roomId, onJoined }: { roomId: string; onJoined: (id: Identity) => void }) {
  const { t } = useI18n()
  const [nickname, setNickname] = useState(() => loadLastNickname())
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // Preselect the prefilled nickname so users can edit or confirm it directly.
  useEffect(() => {
    const el = inputRef.current
    if (el && el.value) {
      el.focus()
      el.select()
    }
  }, [])
  const join = async () => {
    try {
      const joined = await api.join(roomId, { nickname: nickname.trim(), type: 'human' })
      const identity = { uid: joined.uid, token: joined.token, nickname: joined.nickname }
      saveIdentity(roomId, identity)
      saveLastNickname(joined.nickname)
      onJoined(identity)
    } catch (err) {
      setError((err as Error).message)
    }
  }
  return (
    <main className="empty">
      <div className="join-card">
        <h2>{t('join.title')}</h2>
        <input
          ref={inputRef}
          placeholder={t('join.nicknamePlaceholder')}
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && nickname.trim() && join()}
        />
        <button disabled={!nickname.trim()} onClick={join}>
          {t('join.submit')}
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </main>
  )
}

function ChatView({
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

// Memoized: typing in the composer re-renders ChatView on every keystroke, but the message list
// props (events/members-derived maps) stay referentially stable across keystrokes, so each line
// skips re-rendering — and crucially skips re-parsing its markdown. Without this, every keystroke
// re-parsed every message's markdown, so typing got linearly slower as the room filled up.
const EventLine = memo(function EventLine({
  ev,
  eventByMsgId,
  memberByUid,
  myUid,
  mentionNames,
}: {
  ev: ChatEvent
  eventByMsgId: Map<string, ChatEvent>
  memberByUid: Map<string, Member>
  myUid: string
  mentionNames: string[]
}) {
  const { t } = useI18n()
  if (ev.kind !== 'message') {
    const label =
      ev.kind === 'room_updated'
        ? t('system.roomRenamed', { title: (ev.payload as { title?: string })?.title ?? '' })
        : ev.text
    return <div className="sysline">{label}</div>
  }
  const sender = ev.sender_uid ? memberByUid.get(ev.sender_uid) : undefined
  const mentioned = ev.mentions.includes(myUid) || ev.mentions.includes('all')
  const replyTarget = ev.in_reply_to ? eventByMsgId.get(ev.in_reply_to) : undefined
  const replyNick = replyTarget?.sender_uid ? (memberByUid.get(replyTarget.sender_uid)?.nickname ?? t('reply.unknownUser')) : undefined
  return (
    <div className={`msg ${sender?.type ?? ''} ${mentioned ? 'mentioned' : ''} ${ev.muted ? 'muted' : ''}`}>
      <div className="msg-head">
        <span className={`nick ${sender?.type ?? ''}`}>{sender?.nickname ?? ev.sender_uid}</span>
        {sender?.persona_name && <span className="badge">{sender.persona_name}</span>}
        {ev.muted && <span className="badge muted-badge">{t('msg.muted')}</span>}
        <time>{new Date(ev.created_at).toLocaleTimeString()}</time>
      </div>
      {replyTarget && (
        <div className="reply-preview">
          <span className="reply-icon">↩</span>
          <span className="reply-nick">{replyNick ?? replyTarget.sender_uid}</span>
          <span className="reply-text">{(replyTarget.text ?? '').slice(0, 80)}{(replyTarget.text?.length ?? 0) > 80 ? '…' : ''}</span>
        </div>
      )}
      <div className="msg-body">
        <Markdown text={ev.text ?? ''} mentionNames={mentionNames} />
      </div>
    </div>
  )
})

function PendingApprovalPanel({
  roomId,
  token,
  requests,
  members,
  onDone,
  onAdminAuthRequired,
}: {
  roomId: string
  token: string
  requests: PendingJoin[]
  members: Member[]
  onDone: () => void
  onAdminAuthRequired?: (retry?: () => void) => void
}) {
  const { t } = useI18n()
  // Per-request local state: nickname input, selected bind uid, reject reason
  const [nicknames, setNicknames] = useState<Record<string, string>>({})
  const [bindUids, setBindUids] = useState<Record<string, string>>({})
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Agent-only members for the bind dropdown
  const agentMembers = members.filter((m) => m.type === 'agent')

  const nickFor = (req: PendingJoin) => nicknames[req.request_id] ?? req.nickname_requested
  const bindFor = (req: PendingJoin) => {
    if (bindUids[req.request_id] !== undefined) return bindUids[req.request_id]
    // auto-select if nickname matches an existing agent member
    const match = agentMembers.find((m) => m.nickname === req.nickname_requested)
    return match?.uid ?? ''
  }

  const handleAdminError = (err: unknown, requestId: string, retry: () => void) => {
    if (isAuthError(err)) {
      onAdminAuthRequired?.(retry)
    } else {
      setErrors((prev) => ({ ...prev, [requestId]: (err as Error).message }))
    }
  }

  const approveNew = async (req: PendingJoin) => {
    try {
      await api.approvePendingJoin(roomId, req.request_id, token, {
        action: 'new',
        nickname: nickFor(req),
      })
      onDone()
    } catch (err) {
      handleAdminError(err, req.request_id, () => approveNew(req))
    }
  }

  const approveBind = async (req: PendingJoin) => {
    const uid = bindFor(req)
    if (!uid) return
    try {
      await api.approvePendingJoin(roomId, req.request_id, token, {
        action: 'bind',
        bind_uid: uid,
      })
      onDone()
    } catch (err) {
      handleAdminError(err, req.request_id, () => approveBind(req))
    }
  }

  const reject = async (req: PendingJoin) => {
    try {
      await api.rejectPendingJoin(roomId, req.request_id, token, reasons[req.request_id])
      onDone()
    } catch (err) {
      handleAdminError(err, req.request_id, () => reject(req))
    }
  }

  return (
    <div className="pending-panel">
      <h4>{t('pending.title')}</h4>
      {requests.map((req) => {
        const hasExisting = members.some((m) => m.nickname === req.nickname_requested)
        return (
          <div key={req.request_id} className="pending-item">
            <div className="pending-info">
              <span className="nick agent">{req.nickname_requested}</span>
              {req.persona_name && <span className="badge">{req.persona_name}</span>}
              <time>{new Date(req.created_at).toLocaleTimeString()}</time>
            </div>
            {!hasExisting && (
              <div className="pending-actions">
                <label>{t('pending.newMember')}</label>
                <input
                  value={nickFor(req)}
                  onChange={(e) =>
                    setNicknames((prev) => ({ ...prev, [req.request_id]: e.target.value }))
                  }
                  size={12}
                />
                <button onClick={() => approveNew(req)}>{t('pending.approveNew')}</button>
              </div>
            )}
            {agentMembers.length > 0 && (
              <div className="pending-actions">
                <label>{t('pending.bindExisting')}</label>
                <select
                  value={bindFor(req)}
                  onChange={(e) =>
                    setBindUids((prev) => ({ ...prev, [req.request_id]: e.target.value }))
                  }
                >
                  <option value="">{t('pending.selectMember')}</option>
                  {agentMembers.map((m) => (
                    <option key={m.uid} value={m.uid}>
                      {m.nickname}
                    </option>
                  ))}
                </select>
                <button disabled={!bindFor(req)} onClick={() => approveBind(req)}>
                  {t('pending.approveBind')}
                </button>
              </div>
            )}
            <div className="pending-actions">
              <input
                placeholder={t('pending.rejectReason')}
                value={reasons[req.request_id] ?? ''}
                onChange={(e) =>
                  setReasons((prev) => ({ ...prev, [req.request_id]: e.target.value }))
                }
                size={16}
              />
              <button className="reject" onClick={() => reject(req)}>
                {t('pending.reject')}
              </button>
            </div>
            {errors[req.request_id] && <p className="error">{errors[req.request_id]}</p>}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Admin panel (P1b). Only mounted when the App considers the viewer an admin. Sections that
 * only make sense in password mode (change password, session list) are hidden in local mode.
 */
function AdminPanel({ passwordMode, onLoggedOut, onLlmChange }: { passwordMode: boolean; onLoggedOut: () => void; onLlmChange: () => void }) {
  const { t } = useI18n()
  const [settings, setSettings] = useState<AdminSettings | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(() => {
    api.adminSettings().then(setSettings).catch((e) => setError((e as Error).message))
  }, [])
  useEffect(refresh, [refresh])

  const logout = async () => {
    await api.logout()
    onLoggedOut()
  }

  return (
    <main className="admin">
      <h2>{t('admin.title')}</h2>
      {error && <p className="error">{error}</p>}
      {passwordMode && <PasswordSection envPinned={settings?.admin_password.env_pinned ?? false} />}
      {passwordMode && <SessionsSection onSelfRevoked={onLoggedOut} />}
      {settings && <SettingsSection settings={settings} onChange={setSettings} onLlmChange={onLlmChange} />}
      <PersonaSection />
      {passwordMode && (
        <section className="admin-section">
          <button className="link" onClick={logout}>{t('admin.logout')}</button>
        </section>
      )}
    </main>
  )
}

function PasswordSection({ envPinned }: { envPinned: boolean }) {
  const { t } = useI18n()
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')

  const submit = async () => {
    setMsg(''); setError('')
    if (newPw !== confirmPw) { setError(t('admin.pw.mismatch')); return }
    try {
      await api.changePassword(oldPw, newPw)
      setMsg(t('admin.pw.success'))
      setOldPw(''); setNewPw(''); setConfirmPw('')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <section className="admin-section">
      <h3 title={t('admin.pw.titleTip')}>{t('admin.pw.title')}</h3>
      {envPinned ? (
        <p className="hint">{t('admin.pw.envPinned')}</p>
      ) : (
        <>
          <input type="password" placeholder={t('admin.pw.old')} value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
          <input type="password" placeholder={t('admin.pw.new')} value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          <input type="password" placeholder={t('admin.pw.confirm')} value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />
          <button disabled={!oldPw || !newPw} onClick={submit}>{t('admin.pw.submit')}</button>
          {msg && <p className="hint">{msg}</p>}
          {error && <p className="error">{error}</p>}
        </>
      )}
    </section>
  )
}

function SessionsSection({ onSelfRevoked }: { onSelfRevoked: () => void }) {
  const { t } = useI18n()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [error, setError] = useState('')

  const refresh = useCallback(() => {
    api.listSessions().then(setSessions).catch((e) => setError((e as Error).message))
  }, [])
  useEffect(refresh, [refresh])

  const revoke = async (id: string) => {
    // Revoking our own current session logs us out: the session token is invalid server-side after
    // this, so don't refresh (it would 401). Clear it locally and let the App show the logged-out notice.
    const isCurrent = sessions.find((s) => s.id === id)?.current ?? false
    try {
      await api.revokeSession(id)
      if (isCurrent) {
        clearSessionToken()
        onSelfRevoked()
        return
      }
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <section className="admin-section">
      <h3 title={t('admin.sessions.titleTip')}>{t('admin.sessions.title')}</h3>
      {sessions.length === 0 ? (
        <p className="hint">{t('admin.sessions.empty')}</p>
      ) : (
        <ul className="session-list">
          {sessions.map((s) => (
            <li key={s.id}>
              <span className="session-meta">
                {t('admin.sessions.created')}: {new Date(s.created_at).toLocaleString()}
                {' · '}
                {t('admin.sessions.lastUsed')}: {new Date(s.last_used_at).toLocaleString()}
                {s.current && <span className="badge me">{t('admin.sessions.current')}</span>}
              </span>
              <button className="reject" onClick={() => revoke(s.id)}>{t('admin.sessions.revoke')}</button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}

function SettingsSection({ settings, onChange, onLlmChange }: { settings: AdminSettings; onChange: (s: AdminSettings) => void; onLlmChange: () => void }) {
  const { t } = useI18n()
  const [brake, setBrake] = useState(String(settings.brake_after))
  const [accessPw, setAccessPw] = useState('')
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')

  const saveBrake = async () => {
    setMsg(''); setError('')
    try {
      const next = await api.updateAdminSettings({ brake_after: Number(brake) })
      onChange(next); setBrake(String(next.brake_after)); setMsg(t('admin.settings.saved'))
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // Toggling the gate changes which requests need the access-password header — including the already
  // open global rooms EventSource, which can't add a header and would then 403 with no clean recovery
  // (its onerror fallback reads a stale mount-time `rooms` closure). A full reload re-establishes the
  // correct SSE-vs-poll strategy and re-reads the stored access password. Persist the credential
  // BEFORE reloading so the reloaded app picks it up via initAccessPassword().
  const enableAccess = async () => {
    setError('')
    try {
      await api.updateAdminSettings({ access_password: accessPw })
      setAccessPassword(accessPw)
      location.reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const disableAccess = async () => {
    setError('')
    try {
      await api.updateAdminSettings({ access_password: null })
      setAccessPassword(null)
      location.reload()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const switchModel = async (model: string) => {
    setMsg(''); setError('')
    try {
      await api.setLlmModel(model)
      onChange(await api.adminSettings())
      onLlmChange()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const llm = settings.llm
  const modelOptions = llm.model && !llm.models.includes(llm.model) ? [llm.model, ...llm.models] : llm.models
  const gate = settings.access_gate

  return (
    <section className="admin-section">
      <h3>{t('admin.settings.title')}</h3>

      {llm.enabled && (
        <div className="setting-row">
          <label title={t('admin.settings.modelTip')}>{t('admin.settings.model')}</label>
          <select value={llm.model ?? ''} onChange={(e) => switchModel(e.target.value)}>
            {modelOptions.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>
      )}

      <div className="setting-row">
        <label title={t('admin.settings.brakeTip')}>{t('admin.settings.brake')}</label>
        <input
          type="number"
          min={1}
          max={100}
          value={brake}
          disabled={settings.brake.env_pinned}
          onChange={(e) => setBrake(e.target.value)}
        />
        <button disabled={settings.brake.env_pinned} onClick={saveBrake}>{t('admin.settings.save')}</button>
        {settings.brake.env_pinned && <span className="hint">{t('admin.settings.envPinned')}</span>}
      </div>
      <p className="hint">{t('admin.settings.brakeHint')}</p>

      <div className="setting-row">
        <label title={t('admin.settings.accessGateTip')}>{t('admin.settings.accessGate')}</label>
        <span className="badge">{gate.enabled ? t('admin.settings.accessOn') : t('admin.settings.accessOff')}</span>
      </div>
      {gate.env_pinned ? (
        <p className="hint">{t('admin.settings.envPinned')}</p>
      ) : gate.enabled ? (
        <div className="setting-row">
          <button className="reject" disabled={!gate.can_disable} onClick={disableAccess}>
            {t('admin.settings.accessDisable')}
          </button>
          {!gate.can_disable && <span className="hint">{t('admin.settings.accessCannotDisable')}</span>}
        </div>
      ) : (
        <div className="setting-row">
          <input
            type="password"
            placeholder={t('admin.settings.accessPlaceholder')}
            value={accessPw}
            onChange={(e) => setAccessPw(e.target.value)}
          />
          <button disabled={!accessPw} onClick={enableAccess}>{t('admin.settings.accessEnable')}</button>
        </div>
      )}

      {msg && <p className="hint">{msg}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  )
}

function PersonaSection() {
  const { t } = useI18n()
  const [personas, setPersonas] = useState<Persona[]>([])
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState('')

  const refresh = useCallback(() => {
    api.personas().then(setPersonas).catch(console.error)
  }, [])
  useEffect(refresh, [refresh])

  const create = async () => {
    try {
      await api.createPersona(name.trim(), prompt.trim())
      setName('')
      setPrompt('')
      setError('')
      refresh()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <section className="admin-section">
      <h3 title={t('persona.titleTip')}>{t('persona.title')}</h3>
      <p className="hint">{t('persona.hint')}</p>
      {personas.map((p) => (
        <div key={p.id} className="persona-card">
          <div className="persona-head">
            <strong>{p.name}</strong>
            <code>{p.id}</code>
          </div>
          <pre>{p.system_prompt}</pre>
        </div>
      ))}
      <div className="persona-card new">
        <input placeholder={t('persona.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
        <textarea
          placeholder={t('persona.promptPlaceholder')}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button disabled={!name.trim() || !prompt.trim()} onClick={create}>
          {t('persona.create')}
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </section>
  )
}
