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
    'empty.selectOrCreate': '选择或创建一个话题开始讨论',
    'llm.notConfigured': 'LLM 未配置',
    'llm.providerTitle': 'LLM 服务提供商',
    'llm.modelTitle': '在系统设置中变更',
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
    'persona.hint': 'agent 加入房间时可选择一个人设；人设 id 用于 `chatroom join --persona`。多 agent 评审时，可给不同 agent 指定不同审查镜头（如并发安全 / 接口兼容 / 越权），减少趋同。',
    'persona.namePlaceholder': '人设名，如：架构师',
    'persona.promptPlaceholder': 'system prompt，描述该角色的审查视角，如：只看并发与边界条件，忽略代码风格',
    'persona.create': '新建人设',
    'nav.admin': '系统设置',
    'admin.login': '系统管理员登录',
    'admin.logout': '退出登录',
    'admin.loggedOut': '已登出',
    'admin.title': '系统设置',
    'admin.pw.title': '修改系统管理员密码',
    'admin.pw.old': '当前密码',
    'admin.pw.new': '新密码',
    'admin.pw.confirm': '确认新密码',
    'admin.pw.submit': '修改密码',
    'admin.pw.mismatch': '两次输入的新密码不一致',
    'admin.pw.success': '密码已修改',
    'admin.pw.envPinned': '系统管理员密码由环境变量设定，无法在此修改。',
    'admin.sessions.title': '登录会话',
    'admin.sessions.empty': '没有活动会话',
    'admin.sessions.current': '当前设备',
    'admin.sessions.created': '创建于',
    'admin.sessions.lastUsed': '最近使用',
    'admin.sessions.revoke': '吊销',
    'admin.sessions.logoutAll': '吊销全部会话',
    'admin.sessions.confirmAll': '吊销全部会话？所有设备都将被登出。',
    'admin.settings.title': '服务端设置',
    'admin.settings.brake': '自动熔断阈值',
    'admin.settings.brakeHint': '连续这么多条 agent 消息（其间无人类发言）后，静音 agent 之间的 @ 提及。',
    'admin.settings.save': '保存',
    'admin.settings.saved': '已保存',
    'admin.settings.envPinned': '由环境变量锁定。',
    'admin.settings.accessGate': '访问门禁',
    'admin.settings.accessOn': '已开启',
    'admin.settings.accessOff': '已关闭',
    'admin.settings.accessEnable': '设置访问密码',
    'admin.settings.accessDisable': '关闭门禁',
    'admin.settings.accessCannotDisable': '无法关闭：服务绑定在非本地地址且未设系统管理员密码，关闭将导致公网无认证暴露。',
    'admin.settings.accessPlaceholder': '新的访问密码',
    'admin.settings.model': 'LLM 模型',
    'admin.settings.modelTip': '选择生成话题标题与 agent 昵称所用的模型，立即生效（重启后恢复默认配置）。',
    'admin.settings.brakeTip': '当 agent 连续发言达到此阈值（其间无人类参与）时，自动静音 agent 间的 @ 提及，避免无限对话。',
    'admin.settings.accessGateTip': '开启后，所有访问都需先输入访问密码；适合将聊天室部署到公网时使用。',
    'admin.pw.titleTip': '设置或修改系统管理员登录密码；密码模式下，身份验证与管理操作均依赖该密码。',
    'admin.sessions.titleTip': '管理各设备的系统管理员登录会话，可单独吊销；吊销当前会话将导致本机登出。',
    'persona.titleTip': '管理可供 agent 选用的人设；加入房间时通过 persona id 指定（chatroom join --persona）。',
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
    'empty.selectOrCreate': 'Select or create a topic to start chatting',
    'llm.notConfigured': 'LLM not configured',
    'llm.providerTitle': 'LLM provider',
    'llm.modelTitle': 'Change in System settings',
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
    'persona.hint': 'An agent can pick a persona when joining a room; the persona id is used for `chatroom join --persona`. For multi-agent review, give each agent a different review lens (e.g. concurrency / API compatibility / authorization) to reduce groupthink.',
    'persona.namePlaceholder': 'Persona name, e.g. Architect',
    'persona.promptPlaceholder': "system prompt describing this role's review lens, e.g. only check concurrency and boundary conditions, ignore code style",
    'persona.create': 'Create persona',
    'nav.admin': 'System settings',
    'admin.login': 'Admin login',
    'admin.logout': 'Logout',
    'admin.loggedOut': 'You have been logged out',
    'admin.title': 'System settings',
    'admin.pw.title': 'Change admin password',
    'admin.pw.old': 'Current password',
    'admin.pw.new': 'New password',
    'admin.pw.confirm': 'Confirm new password',
    'admin.pw.submit': 'Change password',
    'admin.pw.mismatch': 'New passwords do not match',
    'admin.pw.success': 'Password changed',
    'admin.pw.envPinned': 'The admin password is set via an environment variable and cannot be changed here.',
    'admin.sessions.title': 'Login sessions',
    'admin.sessions.empty': 'No active sessions',
    'admin.sessions.current': 'this device',
    'admin.sessions.created': 'Created',
    'admin.sessions.lastUsed': 'Last used',
    'admin.sessions.revoke': 'Revoke',
    'admin.sessions.logoutAll': 'Revoke all sessions',
    'admin.sessions.confirmAll': 'Revoke all sessions? You will be logged out on every device.',
    'admin.settings.title': 'Server settings',
    'admin.settings.brake': 'Auto-brake threshold',
    'admin.settings.brakeHint': 'Mute agent-to-agent @mentions after this many consecutive agent messages with no human in between.',
    'admin.settings.save': 'Save',
    'admin.settings.saved': 'Saved',
    'admin.settings.envPinned': 'Pinned by an environment variable.',
    'admin.settings.accessGate': 'Access gate',
    'admin.settings.accessOn': 'Enabled',
    'admin.settings.accessOff': 'Disabled',
    'admin.settings.accessEnable': 'Set access password',
    'admin.settings.accessDisable': 'Disable gate',
    'admin.settings.accessCannotDisable': "Can't disable: the server is bound to a non-loopback address with no admin password, which would leave it publicly unauthenticated.",
    'admin.settings.accessPlaceholder': 'New access password',
    'admin.settings.model': 'LLM model',
    'admin.settings.modelTip': 'Choose the model used to generate topic titles and agent nicknames; takes effect immediately (resets to default on restart).',
    'admin.settings.brakeTip': 'When agents reach this many messages in a row with no human taking part, @-mentions between agents are muted automatically to avoid endless back-and-forth.',
    'admin.settings.accessGateTip': 'Once enabled, every visit must enter the access password first; useful when deploying the chatroom to the public internet.',
    'admin.pw.titleTip': 'Set or change the admin login password; in password mode, authentication and admin actions all rely on it.',
    'admin.sessions.titleTip': 'Manage admin login sessions across devices, revoking any individually; revoking the current session logs out this device.',
    'persona.titleTip': 'Manage the personas agents can choose from; specify one by persona id when joining a room (chatroom join --persona).',
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
    'empty.selectOrCreate': '選擇或建立一個話題開始討論',
    'llm.notConfigured': 'LLM 未設定',
    'llm.providerTitle': 'LLM 服務供應商',
    'llm.modelTitle': '在系統設定中變更',
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
    'persona.hint': 'agent 加入房間時可選擇一個人設；人設 id 用於 `chatroom join --persona`。多 agent 評審時，可給不同 agent 指定不同審查鏡頭（如並發安全 / 介面相容 / 越權），減少趨同。',
    'persona.namePlaceholder': '人設名，如：架構師',
    'persona.promptPlaceholder': 'system prompt，描述該角色的審查視角，如：只看並發與邊界條件，忽略程式碼風格',
    'persona.create': '新建人設',
    'nav.admin': '系統設定',
    'admin.login': '系統管理員登入',
    'admin.logout': '登出',
    'admin.loggedOut': '已登出',
    'admin.title': '系統設定',
    'admin.pw.title': '修改系統管理員密碼',
    'admin.pw.old': '目前密碼',
    'admin.pw.new': '新密碼',
    'admin.pw.confirm': '確認新密碼',
    'admin.pw.submit': '修改密碼',
    'admin.pw.mismatch': '兩次輸入的新密碼不一致',
    'admin.pw.success': '密碼已修改',
    'admin.pw.envPinned': '系統管理員密碼由環境變數設定，無法在此修改。',
    'admin.sessions.title': '登入工作階段',
    'admin.sessions.empty': '沒有作用中的工作階段',
    'admin.sessions.current': '目前裝置',
    'admin.sessions.created': '建立於',
    'admin.sessions.lastUsed': '最近使用',
    'admin.sessions.revoke': '撤銷',
    'admin.sessions.logoutAll': '撤銷全部工作階段',
    'admin.sessions.confirmAll': '撤銷全部工作階段？所有裝置都將被登出。',
    'admin.settings.title': '伺服器設定',
    'admin.settings.brake': '自動熔斷閾值',
    'admin.settings.brakeHint': '連續這麼多則 agent 訊息（其間無人類發言）後，靜音 agent 之間的 @ 提及。',
    'admin.settings.save': '儲存',
    'admin.settings.saved': '已儲存',
    'admin.settings.envPinned': '由環境變數鎖定。',
    'admin.settings.accessGate': '存取門禁',
    'admin.settings.accessOn': '已開啟',
    'admin.settings.accessOff': '已關閉',
    'admin.settings.accessEnable': '設定存取密碼',
    'admin.settings.accessDisable': '關閉門禁',
    'admin.settings.accessCannotDisable': '無法關閉：服務綁定在非本機位址且未設系統管理員密碼，關閉將導致公網無認證暴露。',
    'admin.settings.accessPlaceholder': '新的存取密碼',
    'admin.settings.model': 'LLM 模型',
    'admin.settings.modelTip': '選擇產生話題標題與 agent 暱稱所用的模型，立即生效（重啟後恢復預設設定）。',
    'admin.settings.brakeTip': '當 agent 連續發言達到此閾值（其間無人類參與）時，自動靜音 agent 間的 @ 提及，避免無限對話。',
    'admin.settings.accessGateTip': '開啟後，所有存取都需先輸入存取密碼；適合將聊天室部署到公網時使用。',
    'admin.pw.titleTip': '設定或修改系統管理員登入密碼；密碼模式下，身分驗證與管理操作均依賴該密碼。',
    'admin.sessions.titleTip': '管理各裝置的系統管理員登入工作階段，可單獨撤銷；撤銷目前工作階段將導致本機登出。',
    'persona.titleTip': '管理可供 agent 選用的人設；加入房間時透過 persona id 指定（chatroom join --persona）。',
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
