import { useEffect, useState } from 'react'
import { api, type LlmInfo } from '../api'
import { useI18n } from '../i18n'

export function LlmStatus({ refreshKey }: { refreshKey: number }) {
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
