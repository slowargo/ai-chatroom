import { useCallback, useEffect, useRef, useState } from 'react'
import {
  api,
  identityKey,
  loadIdentity,
  loadLastNickname,
  saveIdentity,
  saveLastNickname,
  type Identity,
} from '../api'
import { useI18n } from '../i18n'
import { ChatView } from './ChatView'

export function ChatRoom({ roomId }: { roomId: string }) {
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
