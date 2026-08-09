import {
  getPaidModelLane,
  isApprovedChatModel,
  isModelBudgetSnapshotFresh,
  LOCAL_CHAT_MODEL,
  type ModelBudgets,
  type ModelBudgetLane,
} from '@/integrations/lugos/model-budgets'
import { fetchOperatorModelBudgets } from '@/integrations/lugos/operator-client'

export class PaidModelAuthorizationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'PaidModelAuthorizationError'
  }
}

export async function authorizeChatModelRequest({
  model,
  paidModelConfirmed,
  loadBudgets = fetchOperatorModelBudgets,
}: {
  model: unknown
  paidModelConfirmed: unknown
  loadBudgets?: () => Promise<ModelBudgets>
}): Promise<{
  paidModel: string | null
  budget: { generatedAt: string; lane: ModelBudgetLane } | null
}> {
  const requestedModel = typeof model === 'string' ? model.trim() : ''
  if (!requestedModel || requestedModel === LOCAL_CHAT_MODEL) {
    return { paidModel: null, budget: null }
  }
  if (!isApprovedChatModel(requestedModel)) {
    throw new PaidModelAuthorizationError('Requested model is not approved for operator chat', 400)
  }
  if (paidModelConfirmed !== true) {
    throw new PaidModelAuthorizationError('Paid-model confirmation is required', 409)
  }

  let budgets: ModelBudgets
  try {
    budgets = await loadBudgets()
  } catch {
    throw new PaidModelAuthorizationError('Paid-model budget status is unavailable', 503)
  }
  if (!isModelBudgetSnapshotFresh(budgets)) {
    throw new PaidModelAuthorizationError('Paid-model budget status is stale; refresh before sending', 503)
  }
  const lane = getPaidModelLane(budgets, requestedModel)
  if (!lane) {
    throw new PaidModelAuthorizationError('Paid-model route is unavailable', 503)
  }
  if (lane.status === 'blocked' || lane.remainingUsd <= 0) {
    throw new PaidModelAuthorizationError(`${lane.label} budget is exhausted`, 429)
  }
  return {
    paidModel: lane.model,
    budget: { generatedAt: budgets.generatedAt, lane },
  }
}
