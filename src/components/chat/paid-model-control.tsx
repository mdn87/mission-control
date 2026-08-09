'use client'

import {
  DEEPSEEK_CHAT_MODEL,
  GROK_CHAT_MODEL,
  isModelBudgetSnapshotFresh,
  LOCAL_CHAT_MODEL,
  type ModelBudgets,
} from '@/integrations/lugos/model-budgets'

const STATUS_STYLES = {
  healthy: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
  watch: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
  warning: 'border-orange-400/30 bg-orange-400/10 text-orange-200',
  blocked: 'border-red-500/30 bg-red-500/10 text-red-300',
} as const

function formatUsd(value: number) {
  if (value >= 1) return `$${value.toFixed(2)}`
  if (value >= 0.01) return `$${value.toFixed(3)}`
  return `$${value.toFixed(4)}`
}

export function PaidModelControl({
  selectedModel,
  onModelChange,
  budgets,
  loading,
  error,
}: {
  selectedModel: string
  onModelChange: (model: string) => void
  budgets: ModelBudgets | null
  loading: boolean
  error: string | null
}) {
  const fresh = budgets ? isModelBudgetSnapshotFresh(budgets) : false
  const laneByModel = new Map(budgets?.lanes.map(lane => [lane.model, lane]) ?? [])
  const deepseek = laneByModel.get(DEEPSEEK_CHAT_MODEL)
  const grok = laneByModel.get(GROK_CHAT_MODEL)
  const paidUnavailable = !fresh || Boolean(error)

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2" data-testid="paid-model-control">
      <label className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Model
        <select
          aria-label="Chat model"
          value={selectedModel}
          onChange={event => onModelChange(event.target.value)}
          className="h-7 rounded-md border border-border/70 bg-surface-1 px-2 text-xs normal-case tracking-normal text-foreground focus:outline-hidden focus:ring-1 focus:ring-primary/50"
        >
          <option value={LOCAL_CHAT_MODEL}>Local · RTX 3060 (default)</option>
          <option
            value={DEEPSEEK_CHAT_MODEL}
            disabled={paidUnavailable || deepseek?.status === 'blocked'}
          >
            DeepSeek · paid
          </option>
          <option
            value={GROK_CHAT_MODEL}
            disabled={paidUnavailable || grok?.status === 'blocked'}
          >
            Grok · paid
          </option>
        </select>
      </label>

      {loading && !budgets && (
        <span className="text-[10px] text-muted-foreground/60">Checking paid budgets…</span>
      )}
      {error && (
        <span className="rounded border border-red-500/25 bg-red-500/10 px-2 py-1 text-[10px] text-red-300">
          Paid routes unavailable
        </span>
      )}
      {fresh && budgets?.lanes.map(lane => (
        <span
          key={lane.id}
          className={`rounded border px-2 py-1 text-[10px] ${STATUS_STYLES[lane.status]}`}
          title={`${lane.percentUsed.toFixed(1)}% of ${formatUsd(lane.maxBudgetUsd)} used · rolling ${lane.budgetDuration}`}
        >
          {lane.label} {formatUsd(lane.remainingUsd)} left
          {lane.status === 'watch' && ' · 50% watch'}
          {lane.status === 'warning' && ' · 80% warning'}
          {lane.status === 'blocked' && ' · blocked'}
        </span>
      ))}
      {budgets && !fresh && !error && (
        <span className="rounded border border-amber-400/25 bg-amber-400/10 px-2 py-1 text-[10px] text-amber-200">
          Budget data stale · paid routes paused
        </span>
      )}
    </div>
  )
}

export { formatUsd }
