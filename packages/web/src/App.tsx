import { useCallback, useEffect, useRef, useState } from 'react'
import { version } from '../package.json'
import {
  api,
  clearSessionToken,
  identityKey,
  initAccessPassword,
  isAuthError,
  loadSessionToken,
  type Room,
} from './api'
import { useI18n } from './i18n'
import { AdminLoginModal } from './admin/AdminLoginModal'
import { AdminPanel } from './admin/AdminPanel'
import { ChatRoom } from './chat/ChatRoom'
import { LanguageSwitcher } from './components/LanguageSwitcher'
import { LlmStatus } from './components/LlmStatus'

// Initialize access password from localStorage on module load
initAccessPassword()

const SIDEBAR_WIDTH_KEY = 'chatroom.sidebarWidth'
const SIDEBAR_MIN_WIDTH = 180
const SIDEBAR_MAX_WIDTH = 480
const SIDEBAR_DEFAULT_WIDTH = 240

function loadSidebarWidth(): number {
  const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
  if (!Number.isFinite(raw) || raw <= 0) return SIDEBAR_DEFAULT_WIDTH
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, raw))
}

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
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth)
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

  // Resize the sidebar to a clamped width and persist it so it survives reloads. Used by the
  // keyboard handler and the double-click reset; the live mouse drag skips per-pixel writes and
  // persists once on release (see the drag effect below).
  const applySidebarWidth = useCallback((raw: number) => {
    const next = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, raw))
    setSidebarWidth(next)
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next))
  }, [])

  // Mouse-drag resize. The listeners live in an effect keyed on `dragging` so they are always torn
  // down on unmount (or when the drag ends), never leaking the global cursor/user-select override.
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef({ x: 0, width: 0 })
  const widthRef = useRef(sidebarWidth)
  widthRef.current = sidebarWidth
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    dragStart.current = { x: e.clientX, width: sidebarWidth }
    setDragging(true)
  }
  useEffect(() => {
    if (!dragging) return
    const onMove = (ev: MouseEvent) => {
      const { x, width } = dragStart.current
      const next = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width + ev.clientX - x))
      setSidebarWidth(next)
    }
    const onUp = () => setDragging(false)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.classList.add('resizing-sidebar')
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.classList.remove('resizing-sidebar')
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(widthRef.current))
    }
  }, [dragging])

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
      <aside className="sidebar" style={{ width: sidebarWidth }}>
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
          {isAdmin && (
            <button className="link" onClick={() => setShowAdmin((v) => !v)}>
              {showAdmin ? t('nav.backToChat') : t('nav.admin')}
            </button>
          )}
          {passwordMode && !hasSession && (
            <button className="link" onClick={() => setShowAdminLogin(true)}>{t('admin.login')}</button>
          )}
          <LlmStatus refreshKey={llmVersion} />
          <div className="footer-row">
            <span className="version">v{version}</span>
            <LanguageSwitcher />
          </div>
        </footer>
      </aside>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('sidebar.resize')}
        aria-valuenow={sidebarWidth}
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        tabIndex={0}
        onMouseDown={startResize}
        onDoubleClick={() => applySidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 32 : 8
          if (e.key === 'ArrowLeft') applySidebarWidth(sidebarWidth - step)
          else if (e.key === 'ArrowRight') applySidebarWidth(sidebarWidth + step)
          else if (e.key === 'Home') applySidebarWidth(SIDEBAR_DEFAULT_WIDTH)
          else return
          e.preventDefault()
        }}
      />
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
