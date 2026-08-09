import { db_helpers, getDatabase, logAuditEvent } from '@/lib/db'
import {
  isApprovedChatModel,
  type ModelBudgetLane,
  type ModelBudgets,
} from '@/integrations/lugos/model-budgets'

const LANE_TARGET_IDS = { deepseek: 1, grok: 2 } as const
const BUDGET_WINDOW_SECONDS = 30 * 24 * 60 * 60

function roundUsd(value: number): number {
  return Number(value.toFixed(8))
}

function parseObservedSpend(detail: unknown): number | null {
  if (typeof detail !== 'string' || !detail) return null
  try {
    const parsed = JSON.parse(detail) as { spendUsd?: unknown }
    return typeof parsed.spendUsd === 'number' && Number.isFinite(parsed.spendUsd)
      ? parsed.spendUsd
      : null
  } catch {
    return null
  }
}

export function buildPaidModelRequestAuditDetail({
  model,
  confirmed,
  outcome,
  lane,
  generatedAt,
  httpStatus,
  reason,
  gatewayDelivered,
  runId,
}: {
  model: unknown
  confirmed: unknown
  outcome: 'denied' | 'gateway_accepted' | 'not_delivered' | 'not_forwarded'
  lane?: ModelBudgetLane | null
  generatedAt?: string | null
  httpStatus?: number
  reason?: string
  gatewayDelivered?: boolean
  runId?: string
}) {
  return {
    model: isApprovedChatModel(model) ? model : 'unapproved',
    confirmed: confirmed === true,
    outcome,
    ...(lane ? {
      laneId: lane.id,
      provider: lane.provider,
      spendUsdBefore: roundUsd(lane.spendUsd),
      remainingUsdBefore: roundUsd(lane.remainingUsd),
      budgetStatus: lane.status,
      maxOutputTokens: lane.maxOutputTokens,
    } : {}),
    ...(generatedAt ? { budgetGeneratedAt: generatedAt } : {}),
    ...(typeof httpStatus === 'number' ? { httpStatus } : {}),
    ...(reason ? { reason: reason.slice(0, 96) } : {}),
    ...(typeof gatewayDelivered === 'boolean' ? { gatewayDelivered } : {}),
    ...(runId ? { runId: runId.slice(0, 128) } : {}),
  }
}

export function observePaidModelBudgets({
  budgets,
  workspaceId,
  recipient,
}: {
  budgets: ModelBudgets
  workspaceId: number
  recipient: string
}) {
  const db = getDatabase()
  const previousObservation = db.prepare(`
    SELECT detail
    FROM audit_log
    WHERE action = 'paid_model.budget_observed'
      AND target_type = 'paid_model'
      AND target_id = ?
      AND workspace_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `)
  const existingNotification = db.prepare(`
    SELECT id
    FROM notifications
    WHERE recipient = ?
      AND type = ?
      AND source_type = 'paid_model_budget'
      AND source_id = ?
      AND workspace_id = ?
      AND created_at >= ?
    LIMIT 1
  `)

  for (const lane of budgets.lanes) {
    const targetId = LANE_TARGET_IDS[lane.id]
    const previous = previousObservation.get(targetId, workspaceId) as { detail?: unknown } | undefined
    const previousSpendUsd = parseObservedSpend(previous?.detail)
    const spendDeltaUsd = previousSpendUsd === null
      ? null
      : roundUsd(Math.max(0, lane.spendUsd - previousSpendUsd))

    if (previousSpendUsd === null || spendDeltaUsd !== 0) {
      logAuditEvent({
        action: 'paid_model.budget_observed',
        actor: 'system:budget-monitor',
        target_type: 'paid_model',
        target_id: targetId,
        workspace_id: workspaceId,
        detail: {
          laneId: lane.id,
          model: lane.model,
          provider: lane.provider,
          generatedAt: budgets.generatedAt,
          spendUsd: roundUsd(lane.spendUsd),
          previousSpendUsd,
          spendDeltaUsd,
          remainingUsd: roundUsd(lane.remainingUsd),
          percentUsed: lane.percentUsed,
          status: lane.status,
          maxOutputTokens: lane.maxOutputTokens,
        },
      })
    }

    if (lane.status === 'healthy') continue
    const type = `paid_model_budget_${lane.status}`
    const resetAtMs = lane.resetAt ? Date.parse(lane.resetAt) : Number.NaN
    const windowStartSeconds = Number.isFinite(resetAtMs)
      ? Math.floor(resetAtMs / 1000) - BUDGET_WINDOW_SECONDS
      : Math.floor(Date.parse(budgets.generatedAt) / 1000) - BUDGET_WINDOW_SECONDS
    const exists = existingNotification.get(
      recipient,
      type,
      targetId,
      workspaceId,
      windowStartSeconds,
    )
    if (exists) continue

    db_helpers.createNotification(
      recipient,
      type,
      `${lane.label} paid budget ${lane.status}`,
      `${lane.percentUsed.toFixed(1)}% used; $${lane.remainingUsd.toFixed(4)} remains of $${lane.maxBudgetUsd.toFixed(2)}. Paid requests are capped at ${lane.maxOutputTokens.toLocaleString('en-US')} output tokens.`,
      'paid_model_budget',
      targetId,
      workspaceId,
    )
  }
}
