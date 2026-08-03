'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'
import { useMissionControl } from '@/store'
import {
  OPERATOR_COMMAND_SCHEMA,
  operatorEventSchema,
  operatorReceiptSchema,
  type OperatorReceipt,
  type OperatorSnapshot,
} from './operator-contract'
import {
  EMPTY_LUGOS_OPERATOR_STATE,
  addOperatorReceipt,
  applyOperatorEvent,
  stateFromSnapshot,
  type LugosOperatorState,
} from './operator-state'

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '—'
  return new Date(value).toLocaleString()
}

function statusTone(value: string): string {
  if (['ready', 'active', 'succeeded', 'accepted', 'landed'].includes(value)) {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
  }
  if (['degraded', 'stale', 'warning', 'partial', 'unlanded'].includes(value)) {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-400'
  }
  if (['failed', 'blocked', 'rejected'].includes(value)) {
    return 'border-red-500/30 bg-red-500/10 text-red-400'
  }
  return 'border-border bg-secondary text-muted-foreground'
}

function Badge({ value }: { value: string }) {
  return (
    <span className={`inline-flex rounded border px-2 py-0.5 text-[11px] font-medium ${statusTone(value)}`}>
      {value}
    </span>
  )
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-foreground">{value}</div>
    </div>
  )
}

export function LugosPanel() {
  const currentUser = useMissionControl(state => state.currentUser)
  const [operatorState, setOperatorState] = useState<LugosOperatorState>(
    EMPTY_LUGOS_OPERATOR_STATE,
  )
  const [loading, setLoading] = useState(true)
  const [streamState, setStreamState] = useState<'connecting' | 'live' | 'degraded'>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [subject, setSubject] = useState('week-2-adoption')
  const [summary, setSummary] = useState('Review the Mission Control Lugos boundary receipt.')
  const [submitting, setSubmitting] = useState(false)
  const streamCursor = useRef<string | null>(null)

  const loadSnapshot = useCallback(async () => {
    try {
      const snapshot = await apiFetch<OperatorSnapshot>('/api/lugos/snapshot')
      const next = stateFromSnapshot(snapshot)
      streamCursor.current = next.cursor
      setOperatorState(next)
      setError(null)
    } catch {
      setError('Lugos operator snapshot is unavailable.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSnapshot()
  }, [loadSnapshot])

  useEffect(() => {
    if (loading) return
    const after = streamCursor.current ? `?after=${encodeURIComponent(streamCursor.current)}` : ''
    const source = new EventSource(`/api/lugos/events${after}`)
    const onOperatorEvent = (message: MessageEvent<string>) => {
      try {
        const event = operatorEventSchema.parse(JSON.parse(message.data))
        streamCursor.current = event.cursor
        setOperatorState(current => applyOperatorEvent(current, event))
        setStreamState('live')
        setError(null)
      } catch {
        setStreamState('degraded')
        setError('The Lugos event stream returned an incompatible contract.')
      }
    }
    const onReset = () => {
      source.close()
      setStreamState('connecting')
      setLoading(true)
      void loadSnapshot()
    }
    source.addEventListener('operator', onOperatorEvent as EventListener)
    source.addEventListener('reset', onReset)
    source.onopen = () => setStreamState('live')
    source.onerror = () => setStreamState('degraded')
    return () => source.close()
  }, [loading, loadSnapshot])

  const projection = operatorState.projection
  const canCommand = currentUser?.role === 'operator' || currentUser?.role === 'admin'
  const identities = useMemo(() => projection?.runs ?? [], [projection])

  async function submitApproval(event: React.FormEvent) {
    event.preventDefault()
    if (!canCommand || submitting) return
    setSubmitting(true)
    try {
      const receipt = operatorReceiptSchema.parse(await apiFetch<OperatorReceipt>(
        '/api/lugos/commands',
        {
          method: 'POST',
          body: JSON.stringify({
            schema: OPERATOR_COMMAND_SCHEMA,
            type: 'approval.request',
            idempotency_key: `mc-${crypto.randomUUID()}`,
            payload: { subject: subject.trim(), summary: summary.trim() },
          }),
        },
      ))
      setOperatorState(current => addOperatorReceipt(current, receipt))
      setError(null)
    } catch {
      setError('The approval request was not accepted by Lugos.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="m-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">Lugos Operations</h2>
            <Badge value={streamState} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Mission Control is the disposable session shell. Lugos owns identities, events, and receipts.
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <div>Cursor: <span className="font-mono text-foreground">{operatorState.cursor ?? 'none'}</span></div>
          <div>Snapshot: {formatTimestamp(projection?.generatedAt)}</div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-lg border border-border bg-card py-12 text-center text-sm text-muted-foreground">
          Loading the Lugos operator boundary…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Metric label="Active" value={projection?.summary.active ?? 0} />
            <Metric label="Attention" value={projection?.summary.attention ?? 0} />
            <Metric label="Terminal 24h" value={projection?.summary.terminal24h ?? 0} />
            <Metric label="Accepted 24h" value={projection?.summary.accepted24h ?? 0} />
            <Metric label="Receipts" value={operatorState.receipts.length} />
          </div>

          <section className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Lugos identities</h3>
                <p className="text-xs text-muted-foreground">
                  Source {projection?.source.host ?? 'unavailable'} · {projection?.source.state ?? 'unknown'}
                </p>
              </div>
              <Badge value={projection?.source.state ?? 'unknown'} />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-border text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-medium">Source host</th>
                    <th className="px-4 py-2 font-medium">Agent address</th>
                    <th className="px-4 py-2 font-medium">Run ID</th>
                    <th className="px-4 py-2 font-medium">Route / model</th>
                    <th className="px-4 py-2 font-medium">Phase</th>
                    <th className="px-4 py-2 font-medium">Outcome</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {identities.map(run => (
                    <tr key={run.run_id}>
                      <td className="px-4 py-3 font-mono text-foreground">{run.source_host || '—'}</td>
                      <td className="px-4 py-3 font-mono text-foreground">{run.agent_address || '—'}</td>
                      <td className="px-4 py-3">
                        <div className="font-mono text-foreground">{run.run_id}</div>
                        <div className="text-muted-foreground">{run.repo}</div>
                      </td>
                      <td className="px-4 py-3 text-foreground">
                        {run.route || '—'} / {run.model || '—'}
                      </td>
                      <td className="px-4 py-3"><Badge value={run.current_phase} /></td>
                      <td className="px-4 py-3"><Badge value={run.outcome} /></td>
                    </tr>
                  ))}
                  {identities.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                        No Lugos runs are present in the current projection.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid gap-4 xl:grid-cols-2">
            <section className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-sm font-semibold text-foreground">Request approval receipt</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Requires a Mission Control operator role. The Lugos bearer stays on the server.
              </p>
              {canCommand ? (
                <form className="mt-4 space-y-3" onSubmit={submitApproval}>
                  <label className="block text-xs text-muted-foreground">
                    Subject
                    <input
                      className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                      maxLength={128}
                      required
                      value={subject}
                      onChange={event => setSubject(event.target.value)}
                    />
                  </label>
                  <label className="block text-xs text-muted-foreground">
                    Summary
                    <textarea
                      className="mt-1 min-h-20 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                      maxLength={1000}
                      required
                      value={summary}
                      onChange={event => setSummary(event.target.value)}
                    />
                  </label>
                  <Button type="submit" size="sm" disabled={submitting}>
                    {submitting ? 'Requesting…' : 'Request receipt'}
                  </Button>
                </form>
              ) : (
                <div className="mt-4 rounded-md border border-border bg-background px-3 py-3 text-sm text-muted-foreground">
                  Viewer session: read and replay are available; commands are confined to operators.
                </div>
              )}
            </section>

            <section className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-sm font-semibold text-foreground">Lugos receipts</h3>
              <div className="mt-3 max-h-64 space-y-2 overflow-auto">
                {operatorState.receipts.map(receipt => (
                  <div key={receipt.receipt_id} className="rounded-md border border-border bg-background px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-foreground">{receipt.receipt_id}</span>
                      <Badge value={receipt.status} />
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {receipt.type} · {formatTimestamp(receipt.accepted_at)}
                    </div>
                  </div>
                ))}
                {operatorState.receipts.length === 0 && (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    No command receipts yet.
                  </div>
                )}
              </div>
            </section>
          </div>
        </>
      )}
    </div>
  )
}
