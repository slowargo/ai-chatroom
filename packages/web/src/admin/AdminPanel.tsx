import { useCallback, useEffect, useState } from 'react'
import {
  api,
  clearSessionToken,
  setAccessPassword,
  type AdminSettings,
  type Persona,
  type SessionInfo,
} from '../api'
import { useI18n } from '../i18n'

/**
 * Admin panel (P1b). Only mounted when the App considers the viewer an admin. Sections that
 * only make sense in password mode (change password, session list) are hidden in local mode.
 */
export function AdminPanel({ passwordMode, onLoggedOut, onLlmChange }: { passwordMode: boolean; onLoggedOut: () => void; onLlmChange: () => void }) {
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
          <select value={llm.model ?? ''} disabled={llm.env_pinned} onChange={(e) => switchModel(e.target.value)}>
            {modelOptions.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          {llm.env_pinned && <span className="hint">{t('admin.settings.envPinned')}</span>}
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
