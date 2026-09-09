// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { readPostgresRuntimeConfig } from '../src/server/database/postgres'

describe('postgres runtime config', () => {
  it('normalizes the connection string and safe defaults', () => {
    expect(readPostgresRuntimeConfig({
      CRAFT_AGENT_DATABASE_URL: '  postgresql://example  ',
    })).toEqual({
      connectionString: 'postgresql://example',
      maxConnections: 10,
      ssl: false,
    })
  })

  it('accepts explicit pool and TLS settings', () => {
    expect(readPostgresRuntimeConfig({
      CRAFT_AGENT_DATABASE_URL: 'postgresql://example',
      CRAFT_AGENT_DATABASE_POOL_MAX: '4',
      CRAFT_AGENT_DATABASE_SSL: 'true',
    })).toEqual({
      connectionString: 'postgresql://example',
      maxConnections: 4,
      ssl: true,
    })
  })

  it('rejects missing or ambiguous database settings', () => {
    expect(() => readPostgresRuntimeConfig({})).toThrow(
      '缺少环境变量 CRAFT_AGENT_DATABASE_URL',
    )
    expect(() => readPostgresRuntimeConfig({
      CRAFT_AGENT_DATABASE_URL: 'postgresql://example',
      CRAFT_AGENT_DATABASE_POOL_MAX: '0',
    })).toThrow('CRAFT_AGENT_DATABASE_POOL_MAX 必须是正整数')
    expect(() => readPostgresRuntimeConfig({
      CRAFT_AGENT_DATABASE_URL: 'postgresql://example',
      CRAFT_AGENT_DATABASE_SSL: 'yes',
    })).toThrow('CRAFT_AGENT_DATABASE_SSL 必须是 true 或 false')
  })
})
