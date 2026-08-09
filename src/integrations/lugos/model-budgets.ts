import { z } from 'zod'

export const MODEL_BUDGET_SCHEMA = 'lugos-model-budgets/v1'
export const LOCAL_CHAT_MODEL = 'omniroute/ollama-3060'
export const DEEPSEEK_CHAT_MODEL = 'omniroute-deepseek/deepseek-v4-flash'
export const GROK_CHAT_MODEL = 'omniroute-grok/grok-4.3'
export const APPROVED_CHAT_MODELS = [
  LOCAL_CHAT_MODEL,
  DEEPSEEK_CHAT_MODEL,
  GROK_CHAT_MODEL,
] as const

export const modelBudgetLaneSchema = z.object({
  id: z.enum(['deepseek', 'grok']),
  label: z.string().min(1).max(32),
  model: z.enum([DEEPSEEK_CHAT_MODEL, GROK_CHAT_MODEL]),
  provider: z.string().min(1).max(32),
  paid: z.literal(true),
  maxBudgetUsd: z.literal(2),
  spendUsd: z.number().finite().nonnegative(),
  remainingUsd: z.number().finite().nonnegative(),
  percentUsed: z.number().finite().nonnegative(),
  budgetDuration: z.literal('30d'),
  resetAt: z.string().datetime().nullable(),
  status: z.enum(['healthy', 'watch', 'warning', 'blocked']),
}).strict()

export const modelBudgetsSchema = z.object({
  schema: z.literal(MODEL_BUDGET_SCHEMA),
  generatedAt: z.string().datetime(),
  staleAfterSeconds: z.number().int().min(30).max(600),
  defaultModel: z.literal(LOCAL_CHAT_MODEL),
  lanes: z.array(modelBudgetLaneSchema).length(2),
}).strict().superRefine((value, context) => {
  const ids = value.lanes.map(lane => lane.id)
  if (new Set(ids).size !== 2) {
    context.addIssue({ code: 'custom', message: 'Paid model lanes must be unique' })
  }
  for (const lane of value.lanes) {
    const expected = lane.id === 'deepseek' ? DEEPSEEK_CHAT_MODEL : GROK_CHAT_MODEL
    if (lane.model !== expected) {
      context.addIssue({ code: 'custom', message: `Unexpected model for ${lane.id}` })
    }
  }
})

export type ModelBudgetLane = z.infer<typeof modelBudgetLaneSchema>
export type ModelBudgets = z.infer<typeof modelBudgetsSchema>
export type ApprovedChatModel = (typeof APPROVED_CHAT_MODELS)[number]

export function isApprovedChatModel(value: unknown): value is ApprovedChatModel {
  return typeof value === 'string' && (APPROVED_CHAT_MODELS as readonly string[]).includes(value)
}

export function getPaidModelLane(
  budgets: ModelBudgets,
  model: string,
): ModelBudgetLane | null {
  return budgets.lanes.find(lane => lane.model === model) ?? null
}

export function isModelBudgetSnapshotFresh(
  budgets: ModelBudgets,
  now = Date.now(),
): boolean {
  const generatedAt = Date.parse(budgets.generatedAt)
  return Number.isFinite(generatedAt)
    && now - generatedAt <= budgets.staleAfterSeconds * 1000
    && generatedAt <= now + 30_000
}
