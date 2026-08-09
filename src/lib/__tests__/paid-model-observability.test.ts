import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildPaidModelRequestAuditDetail,
  observePaidModelBudgets,
} from '@/lib/paid-model-observability'
import {
  DEEPSEEK_CHAT_MODEL,
  GROK_CHAT_MODEL,
  LOCAL_CHAT_MODEL,
  type ModelBudgets,
} from '@/integrations/lugos/model-budgets'

const { createNotificationMock, getDatabaseMock, logAuditEventMock } = vi.hoisted(() => ({
  createNotificationMock: vi.fn(),
  getDatabaseMock: vi.fn(),
  logAuditEventMock: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db_helpers: { createNotification: createNotificationMock },
  getDatabase: getDatabaseMock,
  logAuditEvent: logAuditEventMock,
}))

function snapshot(): ModelBudgets {
  return {
    schema: 'lugos-model-budgets/v1',
    generatedAt: '2026-08-09T02:00:00.000Z',
    staleAfterSeconds: 120,
    defaultModel: LOCAL_CHAT_MODEL,
    lanes: [
      {
        id: 'deepseek', label: 'DeepSeek', model: DEEPSEEK_CHAT_MODEL, provider: 'NVIDIA',
        paid: true, maxBudgetUsd: 2, maxOutputTokens: 2048, spendUsd: 1.25,
        remainingUsd: 0.75, percentUsed: 62.5, budgetDuration: '30d',
        resetAt: '2026-09-01T00:00:00.000Z', status: 'watch',
      },
      {
        id: 'grok', label: 'Grok', model: GROK_CHAT_MODEL, provider: 'xAI',
        paid: true, maxBudgetUsd: 2, maxOutputTokens: 2048, spendUsd: 0.5,
        remainingUsd: 1.5, percentUsed: 25, budgetDuration: '30d',
        resetAt: '2026-09-01T00:00:00.000Z', status: 'healthy',
      },
    ],
  }
}

describe('paid model observability', () => {
  beforeEach(() => {
    createNotificationMock.mockReset()
    getDatabaseMock.mockReset()
    logAuditEventMock.mockReset()
  })

  it('records spend deltas and emits one threshold notification without prompt content', () => {
    const previousObservation = {
      get: vi.fn((targetId: number) => ({
        detail: JSON.stringify({ spendUsd: targetId === 1 ? 1 : 0.5 }),
      })),
    }
    const existingNotification = { get: vi.fn(() => undefined) }
    const prepare = vi.fn()
      .mockReturnValueOnce(previousObservation)
      .mockReturnValueOnce(existingNotification)
    getDatabaseMock.mockReturnValue({ prepare })

    observePaidModelBudgets({ budgets: snapshot(), workspaceId: 7, recipient: 'operator' })

    expect(logAuditEventMock).toHaveBeenCalledOnce()
    expect(logAuditEventMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'paid_model.budget_observed',
      actor: 'system:budget-monitor',
      workspace_id: 7,
      detail: expect.objectContaining({
        laneId: 'deepseek',
        spendDeltaUsd: 0.25,
        maxOutputTokens: 2048,
      }),
    }))
    expect(createNotificationMock).toHaveBeenCalledOnce()
    expect(createNotificationMock).toHaveBeenCalledWith(
      'operator',
      'paid_model_budget_watch',
      'DeepSeek paid budget watch',
      expect.stringContaining('2,048 output tokens'),
      'paid_model_budget',
      1,
      7,
    )
    expect(JSON.stringify(logAuditEventMock.mock.calls)).not.toContain('prompt')
  })

  it('does not duplicate an unchanged observation or existing threshold notification', () => {
    const current = snapshot()
    const previousObservation = {
      get: vi.fn((targetId: number) => ({
        detail: JSON.stringify({ spendUsd: targetId === 1 ? 1.25 : 0.5 }),
      })),
    }
    const existingNotification = { get: vi.fn(() => ({ id: 99 })) }
    getDatabaseMock.mockReturnValue({
      prepare: vi.fn()
        .mockReturnValueOnce(previousObservation)
        .mockReturnValueOnce(existingNotification),
    })

    observePaidModelBudgets({ budgets: current, workspaceId: 1, recipient: 'operator' })

    expect(logAuditEventMock).not.toHaveBeenCalled()
    expect(createNotificationMock).not.toHaveBeenCalled()
  })

  it('builds a bounded request audit record with no message or prompt field', () => {
    const lane = snapshot().lanes[0]
    const detail = buildPaidModelRequestAuditDetail({
      model: 'malicious/unapproved-model',
      confirmed: true,
      outcome: 'denied',
      lane,
      generatedAt: '2026-08-09T02:00:00.000Z',
      httpStatus: 400,
      reason: 'Requested model is not approved for operator chat',
    })

    expect(detail).toMatchObject({
      model: 'unapproved',
      confirmed: true,
      outcome: 'denied',
      laneId: 'deepseek',
      maxOutputTokens: 2048,
      httpStatus: 400,
    })
    expect(detail).not.toHaveProperty('message')
    expect(detail).not.toHaveProperty('prompt')
  })
})
