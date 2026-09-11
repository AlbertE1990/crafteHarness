// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { parseModelCatalog, readDeepSeekRuntimeConfig } from '../src/server/model-config'

/** 一份典型的部署目录：两个模型，各自不同的推理能力。 */
const CATALOG = {
  defaultModel: 'model-pro',
  models: [
    {
      id: 'model-flash',
      label: 'Flash',
      reasoningEfforts: ['off', 'low', 'high'],
      defaultReasoningEffort: 'low',
    },
    { id: 'model-pro', label: 'Pro', reasoningEfforts: ['high', 'max'], defaultReasoningEffort: 'max' },
    // 纯推理模型：不声明等级，因此不支持表达推理强度。
    { id: 'model-reasoner' },
  ],
}

describe('model catalog', () => {
  it('reads per-model reasoning capabilities from the catalog', () => {
    const catalog = parseModelCatalog(JSON.stringify(CATALOG))

    expect(catalog).toEqual({
      defaultModel: 'model-pro',
      models: [
        {
          id: 'model-flash',
          label: 'Flash',
          reasoningEfforts: ['off', 'low', 'high'],
          defaultReasoningEffort: 'low',
        },
        { id: 'model-pro', label: 'Pro', reasoningEfforts: ['high', 'max'], defaultReasoningEffort: 'max' },
        // label 缺省等于 id；没有 reasoningEfforts 表示这个模型不接受等级。
        { id: 'model-reasoner', label: 'model-reasoner', reasoningEfforts: [], defaultReasoningEffort: null },
      ],
    })
  })

  it('defaults the model to the first entry and requires the models array', () => {
    expect(parseModelCatalog(JSON.stringify({ models: [{ id: 'only' }] })).defaultModel).toBe('only')
    expect(() => parseModelCatalog(JSON.stringify({ models: [] }))).toThrow('models 必须是非空数组')
    expect(() => parseModelCatalog(JSON.stringify({}))).toThrow('models 必须是非空数组')
  })

  it('rejects entries without an id and an inconsistent default level', () => {
    expect(() => parseModelCatalog(JSON.stringify({ models: [{ label: '没有 id' }] })))
      .toThrow('都需要非空的 id')
    expect(() => parseModelCatalog(JSON.stringify({
      models: [{ id: 'a', reasoningEfforts: ['low'], defaultReasoningEffort: 'high' }],
    }))).toThrow('defaultReasoningEffort high 不在 reasoningEfforts 中')
    expect(() => parseModelCatalog('{ 不是 JSON'))
      .toThrow()
  })

  it('reads the repository catalog and the connection config', () => {
    // 仓库自带的 sample/config/models.json 必须可用，否则案例启动即失败。
    const config = readDeepSeekRuntimeConfig({ DEEPSEEK_API_KEY: 'test-key' })

    expect(config).toMatchObject({
      provider: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      apiKey: 'test-key',
    })
    expect(config.models.length).toBeGreaterThan(0)
    expect(config.models.some(model => model.id === config.defaultModel)).toBe(true)
    expect(Object.isFrozen(config)).toBe(true)
  })

  it('still requires the API key, which is the only model-related value left in env', () => {
    expect(() => readDeepSeekRuntimeConfig({})).toThrow('缺少环境变量 DEEPSEEK_API_KEY')
  })
})
