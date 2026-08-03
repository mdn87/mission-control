'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api-client'
import { useMissionControl } from '@/store'
import {
  OPERATOR_COMMAND_SCHEMA,
  operatorReceiptSchema,
  type OperatorReceipt,
  type TaskLoop,
} from './operator-contract'
import {
  addOperatorReceipt,
} from './operator-state'
import { useLugosOperator } from './use-lugos-operator'

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
  const {
    operatorState,
    setOperatorState,
    loading,
    streamState,
    error,
    setError,
    reload,
  } = useLugosOperator()
  const [subject, setSubject] = useState('week-2-adoption')
  const [summary, setSummary] = useState('Review the Mission Control Lugos boundary receipt.')
  const [handoffSubject, setHandoffSubject] = useState('Week 4 task loop')
  const [handoffBody, setHandoffBody] = useState('Approve one bounded task-loop artifact.')
  const [artifactPath, setArtifactPath] = useState('week4/task-loop.json')
  const [submitting, setSubmitting] = useState<string | null>(null)

  const projection = operatorState.projection
  const canCommand = currentUser?.role === 'operator' || currentUser?.role === 'admin'
  const identities = useMemo(() => projection?.runs ?? [], [projection])
  const taskLoops = operatorState.taskLoop?.loops ?? []

  async function submitApproval(event: React.FormEvent) {
    event.preventDefault()
    if (!canCommand || submitting !== null) return
    setSubmitting('receipt')
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
      setSubmitting(null)
    }
  }

  async function submitHandoff(event: React.FormEvent) {
    event.preventDefault()
    if (!canCommand || submitting !== null) return
    setSubmitting('handoff')
    try {
      const receipt = operatorReceiptSchema.parse(await apiFetch<OperatorReceipt>(
        '/api/lugos/commands',
        {
          method: 'POST',
          body: JSON.stringify({
            schema: OPERATOR_COMMAND_SCHEMA,
            type: 'mail.handoff',
            idempotency_key: `mc-${crypto.randomUUID()}`,
            payload: {
              from_agent: '4070pc/mission-control',
              to_agent: '4070pc/codex',
              subject: handoffSubject.trim(),
              body: handoffBody.trim(),
              artifact: { repo: 'lugos', path: artifactPath.trim() },
            },
          }),
        },
      ))
      setOperatorState(current => addOperatorReceipt(current, receipt))
      await reload()
      setError(null)
    } catch {
      setError('The Agent Mail handoff was not accepted by Lugos.')
    } finally {
      setSubmitting(null)
    }
  }

  async function approveTask(loop: TaskLoop) {
    if (!canCommand || submitting !== null) return
    setSubmitting(loop.loop_id)
    try {
      const receipt = operatorReceiptSchema.parse(await apiFetch<OperatorReceipt>(
        '/api/lugos/commands',
        {
          method: 'POST',
          body: JSON.stringify({
            schema: OPERATOR_COMMAND_SCHEMA,
            type: 'task.approve',
            idempotency_key: `mc-${crypto.randomUUID()}`,
            payload: { loop_id: loop.loop_id, decision: 'approved' },
          }),
        },
      ))
      setOperatorState(current => addOperatorReceipt(current, receipt))
      await reload()
      setError(null)
    } catch {
      setError('Lugos did not accept the task approval or create its artifact.')
    } finally {
      setSubmitting(null)
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

          <section className="rounded-lg border border-border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Week 4 task loop</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Agent Mail owns the handoff; Lugos owns approval, artifact, receipts, and replay.
                </p>
              </div>
              <Badge value={operatorState.taskLoop?.source.state ?? 'unknown'} />
            </div>

            {canCommand ? (
              <form className="mt-4 grid gap-3 lg:grid-cols-2" onSubmit={submitHandoff}>
                <label className="block text-xs text-muted-foreground">
                  Handoff subject
                  <input
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                    maxLength={128}
                    required
                    value={handoffSubject}
                    onChange={event => setHandoffSubject(event.target.value)}
                  />
                </label>
                <label className="block text-xs text-muted-foreground">
                  Artifact path
                  <input
                    className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm text-foreground"
                    maxLength={256}
                    pattern="[A-Za-z0-9][A-Za-z0-9._/-]*\.json"
                    required
                    value={artifactPath}
                    onChange={event => setArtifactPath(event.target.value)}
                  />
                </label>
                <label className="block text-xs text-muted-foreground lg:col-span-2">
                  Handoff body
                  <textarea
                    className="mt-1 min-h-20 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                    maxLength={2000}
                    required
                    value={handoffBody}
                    onChange={event => setHandoffBody(event.target.value)}
                  />
                </label>
                <div className="flex items-center justify-between gap-3 lg:col-span-2">
                  <div className="text-xs text-muted-foreground">
                    4070pc/mission-control → 4070pc/codex · repo lugos
                  </div>
                  <Button type="submit" size="sm" disabled={submitting !== null}>
                    {submitting === 'handoff' ? 'Sending…' : 'Send handoff'}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="mt-4 rounded-md border border-border bg-background px-3 py-3 text-sm text-muted-foreground">
                Viewer session: the replayed loop is visible; handoff and approval require an operator.
              </div>
            )}

            <div className="mt-4 grid gap-3">
              {taskLoops.map(loop => (
                <div key={loop.loop_id} className="rounded-lg border border-border bg-background p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <div className="font-mono text-xs text-foreground">{loop.loop_id}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {loop.handoff.subject} · {loop.handoff.from_agent} → {loop.handoff.to_agent}
                      </div>
                    </div>
                    <Badge value={loop.state} />
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-5">
                    {[
                      ['1 · Handoff', `mail #${loop.handoff.message_id}`, true],
                      ['2 · Approval', loop.approval?.decision ?? 'waiting', loop.approval !== null],
                      ['3 · Artifact', loop.artifact?.path ?? 'waiting', loop.artifact !== null],
                      ['4 · Receipt', `${loop.receipt_ids.length} durable`, loop.receipt_ids.length > 0],
                      ['5 · Replay', operatorState.cursor ?? 'waiting', operatorState.cursor !== null],
                    ].map(([label, detail, complete]) => (
                      <div
                        key={String(label)}
                        className={`rounded border px-2 py-2 text-xs ${
                          complete
                            ? 'border-emerald-500/20 bg-emerald-500/5'
                            : 'border-border bg-card'
                        }`}
                      >
                        <div className="font-medium text-foreground">{label}</div>
                        <div className="mt-1 truncate text-muted-foreground">{detail}</div>
                      </div>
                    ))}
                  </div>
                  {loop.state === 'awaiting_approval' && canCommand && (
                    <div className="mt-3 flex justify-end">
                      <Button
                        type="button"
                        size="sm"
                        disabled={submitting !== null}
                        onClick={() => void approveTask(loop)}
                      >
                        {submitting === loop.loop_id
                          ? 'Creating artifact…'
                          : 'Approve and create artifact'}
                      </Button>
                    </div>
                  )}
                </div>
              ))}
              {taskLoops.length === 0 && (
                <div className="rounded-md border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
                  Send the first handoff to start the replayable loop.
                </div>
              )}
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
                  <Button type="submit" size="sm" disabled={submitting !== null}>
                    {submitting === 'receipt' ? 'Requesting…' : 'Request receipt'}
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
