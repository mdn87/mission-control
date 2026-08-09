import { describe, expect, it } from 'vitest'
import {
  DEEPSEEK_CHAT_MODEL,
  getPaidModelLane,
  GROK_CHAT_MODEL,
  isApprovedChatModel,
  isModelBudgetSnapshotFresh,
  LOCAL_CHAT_MODEL,
  modelBudgetsSchema,
} from './model-budgets'

const fixture = {
  schema: 'lugos-model-budgets/v1',
  generatedAt: '2026-08-08T23:10:00.000Z',
  staleAfterSeconds: 120,
  defaultModel: LOCAL_CHAT_MODEL,
  lanes: [
    { id: 'deepseek', label: 'DeepSeek', model: DEEPSEEK_CHAT_MODEL, provider: 'NVIDIA', paid: true, maxBudgetUsd: 2, maxOutputTokens: 2048, spendUsd: 1, remainingUsd: 1, percentUsed: 50, budgetDuration: '30d', resetAt: null, status: 'watch' },
    { id: 'grok', label: 'Grok', model: GROK_CHAT_MODEL, provider: 'xAI', paid: true, maxBudgetUsd: 2, maxOutputTokens: 2048, spendUsd: 1.6, remainingUsd: 0.4, percentUsed: 80, budgetDuration: '30d', resetAt: null, status: 'warning' },
  ],
}

describe('model budget contract', () => {
  it('accepts only the local default and two approved paid models', () => {
    expect(isApprovedChatModel(LOCAL_CHAT_MODEL)).toBe(true)
    expect(isApprovedChatModel(DEEPSEEK_CHAT_MODEL)).toBe(true)
    expect(isApprovedChatModel(GROK_CHAT_MODEL)).toBe(true)
    expect(isApprovedChatModel('openai/gpt-unknown')).toBe(false)
  })

  it('parses the strict snapshot and maps model to its paid lane', () => {
    const parsed = modelBudgetsSchema.parse(fixture)
    expect(getPaidModelLane(parsed, DEEPSEEK_CHAT_MODEL)?.status).toBe('watch')
    expect(getPaidModelLane(parsed, LOCAL_CHAT_MODEL)).toBeNull()
  })

  it('fails closed for stale, future, duplicate, or secret-bearing snapshots', () => {
    const parsed = modelBudgetsSchema.parse(fixture)
    expect(isModelBudgetSnapshotFresh(parsed, Date.parse('2026-08-08T23:11:00.000Z'))).toBe(true)
    expect(isModelBudgetSnapshotFresh(parsed, Date.parse('2026-08-08T23:13:00.001Z'))).toBe(false)
    expect(isModelBudgetSnapshotFresh(parsed, Date.parse('2026-08-08T23:09:00.000Z'))).toBe(false)

    const duplicate = structuredClone(fixture)
    duplicate.lanes[1] = structuredClone(duplicate.lanes[0])
    expect(() => modelBudgetsSchema.parse(duplicate)).toThrow()

    const secret = structuredClone(fixture) as typeof fixture & { apiKey?: string }
    secret.apiKey = 'must-not-cross'
    expect(() => modelBudgetsSchema.parse(secret)).toThrow()
  })
})
