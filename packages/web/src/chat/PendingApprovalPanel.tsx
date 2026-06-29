import { useState } from 'react'
import { api, isAuthError, type Member, type PendingJoin } from '../api'
import { useI18n } from '../i18n'

export function PendingApprovalPanel({
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
