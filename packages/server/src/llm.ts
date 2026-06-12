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
  timeoutMs?: number
}

export class Llm {
  constructor(private cfg: LlmConfig = {}) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Llm {
    return new Llm({
      baseUrl: env.CHATROOM_LLM_BASE_URL,
      apiKey: env.CHATROOM_LLM_API_KEY,
      model: env.CHATROOM_LLM_MODEL,
    })
  }

  enabled(): boolean {
    return Boolean(this.cfg.baseUrl && this.cfg.model)
  }

  private async chat(system: string, user: string): Promise<string | null> {
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
          max_tokens: 60,
          temperature: 0.7,
        }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const content = data.choices?.[0]?.message?.content?.trim()
      return content || null
    } catch (err) {
      console.warn('[llm] call failed, falling back:', (err as Error).message)
      return null
    }
  }

  async genTitle(messages: Array<{ nickname: string; text: string }>): Promise<string | null> {
    const transcript = messages.map((m) => `${m.nickname}: ${m.text}`).join('\n')
    const title = await this.chat(
      'Generate a concise topic title (max 20 characters, same language as the conversation). Reply with the title only — no quotes, no punctuation around it.',
      transcript,
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
