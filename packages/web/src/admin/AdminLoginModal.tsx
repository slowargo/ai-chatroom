import { useEffect, useRef, useState } from 'react'
import { api, clearSessionToken, loadSessionToken, saveSessionToken } from '../api'

/**
 * Modal dialog for admin login.
 * On success, saves the session token to localStorage and calls onSuccess.
 * The token is then automatically picked up by adminCredential() in api.ts.
 */
export function AdminLoginModal({ onSuccess, onClose }: { onSuccess: () => void; onClose: () => void }) {
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
