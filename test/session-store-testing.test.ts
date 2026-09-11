// @vitest-environment node

import type { SessionStore } from '../src'
import { describe, expect, it } from 'vitest'
import { MemorySessionStore } from '../src'
import { assertSessionStoreContract } from './support/session-store-contract'

describe('session store testing utilities', () => {
  it('validates the complete MemorySessionStore persistence contract', async () => {
    const result = await assertSessionStoreContract(new MemorySessionStore(), {
      sessionIdPrefix: 'memory-contract',
      requireCatalog: true,
    })

    expect(result).toEqual({
      scopeId: 'memory-contract:scope',
      sessionIds: [
        'memory-contract:primary',
        'memory-contract:secondary',
        'memory-contract:invalid-batch',
        'memory-contract:serialization',
      ],
      catalogChecked: true,
    })
  })

  it('allows an execution-only Store when catalog support is optional', async () => {
    const memory = new MemorySessionStore()
    const store: SessionStore = {
      append: request => memory.append(request),
      read: request => memory.read(request),
    }

    const result = await assertSessionStoreContract(store, {
      sessionIdPrefix: 'without-catalog',
    })

    expect(result.catalogChecked).toBe(false)
  })

  it('rejects a Store without catalog support when it is required', async () => {
    const memory = new MemorySessionStore()
    const store: SessionStore = {
      append: request => memory.append(request),
      read: request => memory.read(request),
    }

    await expect(assertSessionStoreContract(store, {
      sessionIdPrefix: 'catalog-required',
      requireCatalog: true,
    })).rejects.toThrow('必须实现 list()')
  })
})
