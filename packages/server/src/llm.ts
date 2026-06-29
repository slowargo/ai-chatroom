/**
 * Optional OpenAI-compatible helper, used ONLY for metadata decoration
 * (topic titles, nicknames). Strictly degradable: when unconfigured or on
 * any failure it returns null and callers fall back to deterministic defaults.
 * The core message path has zero LLM dependency.
 */
export interface LlmConfig {
  baseUrl?: string
  apiKey?: string
  model?: string
  provider?: string
  timeoutMs?: number
}

/**
 * Provider presets, auto-activated when their API key env var is present.
 * Explicit CHATROOM_LLM_BASE_URL config always wins over presets.
 */
const PROVIDERS = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
} as const

export class Llm {
  constructor(private cfg: LlmConfig = {}) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env, persistedModel?: string): Llm {
    // `||` (not `??`): empty-string env values must not silently disable a preset.
    // Precedence: env > persisted > provider default.
    if (env.CHATROOM_LLM_BASE_URL) {
      return new Llm({
        baseUrl: env.CHATROOM_LLM_BASE_URL,
        apiKey: env.CHATROOM_LLM_API_KEY || undefined,
        model: env.CHATROOM_LLM_MODEL || persistedModel || undefined,
        provider: 'custom',
      })
    }
    for (const [name, preset] of Object.entries(PROVIDERS)) {
      const apiKey = env[preset.apiKeyEnv]
      if (apiKey) {
        return new Llm({
          baseUrl: preset.baseUrl,
          apiKey,
          model: env.CHATROOM_LLM_MODEL || persistedModel || preset.defaultModel,
          provider: name,
        })
      }
    }
    return new Llm()
  }

  enabled(): boolean {
    return Boolean(this.cfg.baseUrl && this.cfg.model)
  }

  info(): { enabled: boolean; provider: string | null; model: string | null } {
    return {
      enabled: this.enabled(),
      provider: this.cfg.provider ?? null,
      model: this.cfg.model ?? null,
    }
  }

  setModel(model: string): void {
    this.cfg.model = model
  }

  /** List models from the OpenAI-compatible /models endpoint; degrades to the current model on failure. */
  async listModels(): Promise<string[]> {
    if (!this.enabled()) return []
    try {
      const res = await fetch(`${this.cfg.baseUrl!.replace(/\/+$/, '')}/models`, {
        headers: this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {},
        // shorter than chat's timeout: GET /api/llm awaits this and blocks the sidebar's first paint
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 3_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { data?: Array<{ id?: string }> }
      const ids = (data.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id))
      return ids.length > 0 ? ids : [this.cfg.model!]
    } catch (err) {
      console.warn('[llm] list models failed, falling back:', (err as Error).message)
      return [this.cfg.model!]
    }
  }

  private async chat(system: string, user: string, maxTokens = 1024): Promise<string | null> {
    if (!this.enabled()) return null
    try {
      const res = await fetch(`${this.cfg.baseUrl!.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.cfg.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_tokens: maxTokens,
          temperature: 0.7,
          // DeepSeek-specific: disable thinking mode so content is returned normally
          ...(this.cfg.provider === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
        }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const msg = data.choices?.[0]?.message
      const content = msg?.content?.trim()
      if (!content) console.warn(`[llm] empty response: ${JSON.stringify(data).slice(0, 300)}`)
      return content || null
    } catch (err) {
      console.warn('[llm] call failed:', (err as Error).message)
      return null
    }
  }

  async genTitle(messages: Array<{ nickname: string; text: string }>): Promise<string | null> {
    const truncate = (s: string, n: number) => {
      const chars = [...s]
      return chars.length > n ? chars.slice(0, n).join('') : s
    }
    const transcript = messages.map((m) => `${m.nickname}: ${truncate(m.text, 400)}`).join('\n')
    const title = await this.chat(
      'You are naming a chatroom topic.\nGenerate a descriptive topic title (max 40 characters, same language as the conversation) that captures the specific subject being discussed.\nKeep concrete nouns and key terms — prefer "关于PR#123的代码审查" over "审查计划与代码", "PR #123 code review" over "Review and planning".\nThe opening messages usually establish the main topic. Later messages may branch into subtopics — the title should reflect the primary topic, not tangents.\nFocus on the topic or task, not the participants. Reply with the title only — no quotes, no punctuation around it.',
      transcript,
      64,
    )
    return title ? title.split('\n')[0].slice(0, 40) : null
  }

  async genNickname(personaName: string, systemPrompt: string, taken: string[]): Promise<string | null> {
    const name = await this.chat(
      'Generate a short, memorable chat nickname (max 12 characters, same language as the persona description) for an AI participant. Reply with the nickname only — no quotes, no @.',
      `Persona: ${personaName}\nDescription: ${systemPrompt.slice(0, 300)}\nAlready taken: ${taken.join(', ') || '(none)'}`,
    )
    return name ? name.split('\n')[0].replace(/[@\s]/g, '').slice(0, 20) || null : null
  }
}
