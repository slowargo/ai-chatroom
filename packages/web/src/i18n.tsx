import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

export type Locale = 'en' | 'zh-CN' | 'zh-TW'

// Display order matters: shown in the language switcher as-is.
export const LOCALES: { code: Locale; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
]

const LOCALE_KEY = 'chatroom:locale'

type Dict = Record<string, string>

// Source language is zh-CN; en/zh-TW are translations. `{name}` marks an interpolation slot.
const messages: Record<Locale, Dict> = {
  'zh-CN': {
    'app.title': 'AI Chatroom',
    'room.confirmDelete': '确定删除此话题？所有消息将不可恢复。',
    'room.new': '+ 新话题',
    'room.unnamed': '（未命名话题）',
    'room.messageCount': '{count} 条',
    'room.delete': '删除话题',
    'nav.backToChat': '返回聊天',
    'nav.personaManagement': '人设管理',
    'empty.selectOrCreate': '选择或创建一个话题开始讨论',
    'llm.notConfigured': 'LLM 未配置',
    'llm.providerTitle': 'LLM 服务提供商',
    'llm.modelTitle': '用于自动生成房间标题和 Agent 昵称',
    'join.title': '加入话题',
    'join.nicknamePlaceholder': '你的昵称',
    'join.submit': '加入',
    'composer.placeholder': '发消息，@昵称 召唤 agent，Enter 发送 / Shift+Enter 换行',
    'members.title': '成员',
    'members.me': '我',
    'members.waitingHuman': '等待操作者',
    'msg.muted': '已熔断',
    'reply.unknownUser': '未知用户',
    'system.roomRenamed': '话题已命名：{title}',
    'pending.title': '待审批加入请求',
    'pending.newMember': '新成员',
    'pending.approveNew': '批准（新）',
    'pending.bindExisting': '绑定既有',
    'pending.selectMember': '-- 选择成员 --',
    'pending.approveBind': '批准（绑定）',
    'pending.rejectReason': '拒绝原因（可选）',
    'pending.reject': '拒绝',
    'persona.title': '人设预设',
    'persona.hint': 'agent 加入房间时可选择一个人设；人设 id 用于 `chatroom join --persona`。',
    'persona.namePlaceholder': '人设名，如：架构师',
    'persona.promptPlaceholder': 'system prompt，描述这个角色的视角和说话方式',
    'persona.create': '新建人设',
    'lang.label': '语言',
  },
  en: {
    'app.title': 'AI Chatroom',
    'room.confirmDelete': 'Delete this topic? All messages will be permanently lost.',
    'room.new': '+ New topic',
    'room.unnamed': '(Untitled topic)',
    'room.messageCount': '{count} msg(s)',
    'room.delete': 'Delete topic',
    'nav.backToChat': 'Back to chat',
    'nav.personaManagement': 'Personas',
    'empty.selectOrCreate': 'Select or create a topic to start chatting',
    'llm.notConfigured': 'LLM not configured',
    'llm.providerTitle': 'LLM provider',
    'llm.modelTitle': 'Used to auto-generate room titles and agent nicknames',
    'join.title': 'Join topic',
    'join.nicknamePlaceholder': 'Your nickname',
    'join.submit': 'Join',
    'composer.placeholder': 'Type a message, @nickname to summon an agent, Enter to send / Shift+Enter for a new line',
    'members.title': 'Members',
    'members.me': 'Me',
    'members.waitingHuman': 'Waiting for operator',
    'msg.muted': 'Auto-braked',
    'reply.unknownUser': 'Unknown user',
    'system.roomRenamed': 'Renamed to "{title}"',
    'pending.title': 'Pending join requests',
    'pending.newMember': 'New member',
    'pending.approveNew': 'Approve (new)',
    'pending.bindExisting': 'Bind existing',
    'pending.selectMember': '-- Select member --',
    'pending.approveBind': 'Approve (bind)',
    'pending.rejectReason': 'Reject reason (optional)',
    'pending.reject': 'Reject',
    'persona.title': 'Persona presets',
    'persona.hint': 'An agent can pick a persona when joining a room; the persona id is used for `chatroom join --persona`.',
    'persona.namePlaceholder': 'Persona name, e.g. Architect',
    'persona.promptPlaceholder': "system prompt describing this role's perspective and tone",
    'persona.create': 'Create persona',
    'lang.label': 'Language',
  },
  'zh-TW': {
    'app.title': 'AI Chatroom',
    'room.confirmDelete': '確定刪除此話題？所有訊息將無法復原。',
    'room.new': '+ 新話題',
    'room.unnamed': '（未命名話題）',
    'room.messageCount': '{count} 則',
    'room.delete': '刪除話題',
    'nav.backToChat': '返回聊天',
    'nav.personaManagement': '人設管理',
    'empty.selectOrCreate': '選擇或建立一個話題開始討論',
    'llm.notConfigured': 'LLM 未設定',
    'llm.providerTitle': 'LLM 服務供應商',
    'llm.modelTitle': '用於自動產生房間標題和 Agent 暱稱',
    'join.title': '加入話題',
    'join.nicknamePlaceholder': '你的暱稱',
    'join.submit': '加入',
    'composer.placeholder': '傳送訊息，@暱稱 召喚 agent，Enter 傳送 / Shift+Enter 換行',
    'members.title': '成員',
    'members.me': '我',
    'members.waitingHuman': '等待操作者',
    'msg.muted': '已熔斷',
    'reply.unknownUser': '未知使用者',
    'system.roomRenamed': '話題已命名：{title}',
    'pending.title': '待審批加入請求',
    'pending.newMember': '新成員',
    'pending.approveNew': '批准（新）',
    'pending.bindExisting': '綁定既有',
    'pending.selectMember': '-- 選擇成員 --',
    'pending.approveBind': '批准（綁定）',
    'pending.rejectReason': '拒絕原因（可選）',
    'pending.reject': '拒絕',
    'persona.title': '人設預設',
    'persona.hint': 'agent 加入房間時可選擇一個人設；人設 id 用於 `chatroom join --persona`。',
    'persona.namePlaceholder': '人設名，如：架構師',
    'persona.promptPlaceholder': 'system prompt，描述這個角色的視角和說話方式',
    'persona.create': '新建人設',
    'lang.label': '語言',
  },
}

export type TParams = Record<string, string | number>
export type TFunc = (key: string, params?: TParams) => string

function translate(locale: Locale, key: string, params?: TParams): string {
  const template = messages[locale][key] ?? messages.en[key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in params ? String(params[name]) : `{${name}}`,
  )
}

function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'zh-CN' || value === 'zh-TW'
}

// Saved choice wins; otherwise match the browser's preferred languages, defaulting to English.
export function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_KEY)
    if (isLocale(saved)) return saved
  } catch {
    /* localStorage unavailable: fall through to browser detection */
  }
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const lang of langs) {
    const lc = (lang ?? '').toLowerCase()
    if (lc.startsWith('zh')) {
      return /tw|hk|mo|hant/.test(lc) ? 'zh-TW' : 'zh-CN'
    }
    // Cantonese (e.g. yue-Hant-HK) is predominantly a Traditional-script audience
    if (lc.startsWith('yue')) return 'zh-TW'
    if (lc.startsWith('en')) return 'en'
  }
  return 'en'
}

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: TFunc
}

const I18nContext = createContext<I18nContextValue>({
  locale: 'en',
  setLocale: () => {},
  t: (key) => key,
})

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale)

  useEffect(() => {
    document.documentElement.lang = locale
    document.title = translate(locale, 'app.title')
  }, [locale])

  const setLocale = useCallback((next: Locale) => {
    try {
      localStorage.setItem(LOCALE_KEY, next)
    } catch {
      /* ignore persistence failure; in-memory switch still applies */
    }
    setLocaleState(next)
  }, [])

  const t = useCallback<TFunc>((key, params) => translate(locale, key, params), [locale])

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}
