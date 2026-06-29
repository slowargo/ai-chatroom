import { LOCALES, useI18n } from '../i18n'

export function LanguageSwitcher() {
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
