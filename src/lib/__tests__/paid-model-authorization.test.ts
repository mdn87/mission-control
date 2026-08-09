import { describe, expect, it, vi } from 'vitest'
import {
  authorizeChatModelRequest,
} from '@/lib/paid-model-authorization'
import {
  DEEPSEEK_CHAT_MODEL,
  GROK_CHAT_MODEL,
  LOCAL_CHAT_MODEL,
  type ModelBudgets,
} from '@/integrations/lugos/model-budgets'

function budgets(overrides: Partial<ModelBudgets['lanes'][number]> = {}): ModelBudgets {
  const now = new Date().toISOString()
  return {
    schema: 'lugos-model-budgets/v1',
    generatedAt: now,
    staleAfterSeconds: 120,
    defaultModel: LOCAL_CHAT_MODEL,
    lanes: [
      {
        id: 'deepseek', label: 'DeepSeek', model: DEEPSEEK_CHAT_MODEL, provider: 'NVIDIA',
        paid: true, maxBudgetUsd: 2, spendUsd: 0.25, remainingUsd: 1.75,
        percentUsed: 12.5, budgetDuration: '30d', resetAt: null, status: 'healthy',
        ...overrides,
      },
      {
        id: 'grok', label: 'Grok', model: GROK_CHAT_MODEL, provider: 'xAI',
        paid: true, maxBudgetUsd: 2, spendUsd: 0.5, remainingUsd: 1.5,
        percentUsed: 25, budgetDuration: '30d', resetAt: null, status: 'healthy',
      },
    ],
  }
}

describe('paid chat model authorization', () => {
  it('keeps empty and explicit local selections on the default route', async () => {
    const loadBudgets = vi.fn()
    await expect(authorizeChatModelRequest({ model: '', paidModelConfirmed: false, loadBudgets }))
      .resolves.toEqual({ paidModel: null })
    await expect(authorizeChatModelRequest({ model: LOCAL_CHAT_MODEL, paidModelConfirmed: false, loadBudgets }))
      .resolves.toEqual({ paidModel: null })
    expect(loadBudgets).not.toHaveBeenCalled()
  })

  it('requires explicit confirmation before loading paid budget data', async () => {
    const loadBudgets = vi.fn()
    await expect(authorizeChatModelRequest({
      model: DEEPSEEK_CHAT_MODEL,
      paidModelConfirmed: false,
      loadBudgets,
    })).rejects.toMatchObject({ status: 409 })
    expect(loadBudgets).not.toHaveBeenCalled()
  })

  it('authorizes an approved paid lane with a fresh remaining budget', async () => {
    await expect(authorizeChatModelRequest({
      model: DEEPSEEK_CHAT_MODEL,
      paidModelConfirmed: true,
      loadBudgets: async () => budgets(),
    })).resolves.toEqual({ paidModel: DEEPSEEK_CHAT_MODEL })
  })

  it('blocks exhausted, stale, unavailable, and unapproved paid routes', async () => {
    await expect(authorizeChatModelRequest({
      model: DEEPSEEK_CHAT_MODEL,
      paidModelConfirmed: true,
      loadBudgets: async () => budgets({ status: 'blocked', remainingUsd: 0, percentUsed: 100 }),
    })).rejects.toMatchObject({ status: 429 })

    const stale = budgets()
    stale.generatedAt = '2026-01-01T00:00:00.000Z'
    await expect(authorizeChatModelRequest({
      model: GROK_CHAT_MODEL,
      paidModelConfirmed: true,
      loadBudgets: async () => stale,
    })).rejects.toMatchObject({ status: 503 })

    await expect(authorizeChatModelRequest({
      model: 'unapproved/provider',
      paidModelConfirmed: true,
      loadBudgets: async () => budgets(),
    })).rejects.toMatchObject({ status: 400 })

    await expect(authorizeChatModelRequest({
      model: GROK_CHAT_MODEL,
      paidModelConfirmed: true,
      loadBudgets: async () => { throw new Error('offline') },
    })).rejects.toMatchObject({ status: 503 })
  })
})
