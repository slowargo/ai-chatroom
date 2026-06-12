import { afterEach, describe, expect, it, vi } from 'vitest'
import { Llm } from '../src/llm.js'

// Always pass explicit env objects — the dev machine may really have DEEPSEEK_API_KEY set.

describe('Llm.fromEnv provider resolution', () => {
  it('stays disabled with an empty env', () => {
    const llm = Llm.fromEnv({})
    expect(llm.enabled()).toBe(false)
    expect(llm.info()).toEqual({ enabled: false, provider: null, model: null })
  })

  it('auto-activates deepseek when DEEPSEEK_API_KEY is set', () => {
    const llm = Llm.fromEnv({ DEEPSEEK_API_KEY: 'sk-test' })
    expect(llm.enabled()).toBe(true)
    expect(llm.info()).toEqual({ enabled: true, provider: 'deepseek', model: 'deepseek-v4-flash' })
  })

  it('lets CHATROOM_LLM_MODEL override the provider default model', () => {
    const llm = Llm.fromEnv({ DEEPSEEK_API_KEY: 'sk-test', CHATROOM_LLM_MODEL: 'deepseek-reasoner' })
    expect(llm.info().model).toBe('deepseek-reasoner')
    expect(llm.info().provider).toBe('deepseek')
  })

  it('ignores an empty CHATROOM_LLM_MODEL instead of disabling the preset', () => {
    const llm = Llm.fromEnv({ DEEPSEEK_API_KEY: 'sk-test', CHATROOM_LLM_MODEL: '' })
    expect(llm.info()).toEqual({ enabled: true, provider: 'deepseek', model: 'deepseek-v4-flash' })
  })

  it('explicit CHATROOM_LLM_* config wins over provider presets', () => {
    const llm = Llm.fromEnv({
      CHATROOM_LLM_BASE_URL: 'https://example.com/v1',
      CHATROOM_LLM_API_KEY: 'sk-custom',
      CHATROOM_LLM_MODEL: 'my-model',
      DEEPSEEK_API_KEY: 'sk-test',
    })
    expect(llm.info()).toEqual({ enabled: true, provider: 'custom', model: 'my-model' })
  })

  it('explicit base url without model stays disabled', () => {
    const llm = Llm.fromEnv({ CHATROOM_LLM_BASE_URL: 'https://example.com/v1' })
    expect(llm.info()).toEqual({ enabled: false, provider: 'custom', model: null })
  })
})

describe('setModel / listModels', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('setModel switches the active model in memory', () => {
    const llm = Llm.fromEnv({ DEEPSEEK_API_KEY: 'sk-test' })
    llm.setModel('deepseek-reasoner')
    expect(llm.info().model).toBe('deepseek-reasoner')
  })

  it('listModels returns [] when disabled, without any network call', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await new Llm().listModels()).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('listModels parses the OpenAI-compatible /models response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(String(url)).toBe('https://api.deepseek.com/models')
        return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-reasoner' }] }))
      }),
    )
    const llm = Llm.fromEnv({ DEEPSEEK_API_KEY: 'sk-test' })
    expect(await llm.listModels()).toEqual(['deepseek-v4-flash', 'deepseek-reasoner'])
  })

  it('listModels degrades to the current model on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    )
    const llm = Llm.fromEnv({ DEEPSEEK_API_KEY: 'sk-test' })
    expect(await llm.listModels()).toEqual(['deepseek-v4-flash'])
  })
})
