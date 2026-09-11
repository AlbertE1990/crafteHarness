// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { readDeepSeekRuntimeConfig } from '../src/server/model-config'

/** 构造包含必需字段的最小部署环境。 */
function createEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_MODEL: 'deepseek-test-model',
    ...overrides,
  }
}

describe('deepSeek runtime config', () => {
  it('fails at startup instead of falling back to a built-in model name', () => {
    expect(() => readDeepSeekRuntimeConfig({})).toThrow('缺少环境变量 DEEPSEEK_API_KEY')
    expect(() => readDeepSeekRuntimeConfig({ DEEPSEEK_API_KEY: 'test-key' }))
      .toThrow('缺少环境变量 DEEPSEEK_MODEL')
    expect(() => readDeepSeekRuntimeConfig(createEnv({ DEEPSEEK_MODEL: '   ' })))
      .toThrow('缺少环境变量 DEEPSEEK_MODEL')
  })

  it('uses documented defaults when optional values are absent', () => {
    const config = readDeepSeekRuntimeConfig(createEnv())

    expect(config).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-test-model',
      baseURL: 'https://api.deepseek.com',
      // null 表示不覆盖：不下发任何推理参数，由供应商或模型自身默认值决定。
      reasoningEffort: null,
      reasoningEfforts: ['off', 'low', 'high', 'max'],
    })
    expect(Object.isFrozen(config)).toBe(true)
  })

  it('reads the reasoning vocabulary from the deployment', () => {
    const config = readDeepSeekRuntimeConfig(createEnv({
      DEEPSEEK_BASE_URL: ' https://example.test/v1 ',
      DEEPSEEK_REASONING_EFFORTS: ' LOW , high ,off, high ',
      DEEPSEEK_REASONING_EFFORT: ' HIGH ',
    }))

    // 归一化为小写、去重，并让保留值稳定排在最前。
    expect(config.baseURL).toBe('https://example.test/v1')
    expect(config.reasoningEfforts).toEqual(['off', 'low', 'high'])
    expect(config.reasoningEffort).toBe('high')
  })

  it('keeps off selectable and allows disabling the candidate list entirely', () => {
    expect(readDeepSeekRuntimeConfig(createEnv({
      DEEPSEEK_REASONING_EFFORTS: 'low,high',
      DEEPSEEK_REASONING_EFFORT: 'off',
    }))).toMatchObject({
      reasoningEfforts: ['off', 'low', 'high'],
      reasoningEffort: 'off',
    })

    // 显式留空表示运维主动关闭下拉候选；前端会退化为自由输入。
    expect(readDeepSeekRuntimeConfig(createEnv({
      DEEPSEEK_REASONING_EFFORTS: '  ',
      DEEPSEEK_REASONING_EFFORT: 'anything',
    }))).toMatchObject({
      reasoningEfforts: [],
      reasoningEffort: 'anything',
    })
  })

  it('rejects a default level that is not in the configured candidates', () => {
    // 只校验部署自己的默认值；请求级等级不经过这份列表，避免过期枚举让合法请求失败。
    expect(() => readDeepSeekRuntimeConfig(createEnv({
      DEEPSEEK_REASONING_EFFORTS: 'off,low',
      DEEPSEEK_REASONING_EFFORT: 'max',
    }))).toThrow('DEEPSEEK_REASONING_EFFORT 取值 max 不在 DEEPSEEK_REASONING_EFFORTS 中')
  })
})
