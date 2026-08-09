'use client'

import { useCallback, useEffect, useState } from 'react'
import { ApiError, apiFetch } from '@/lib/api-client'
import {
  lineageExplanationSchema,
  type LineageExplanation,
} from './torc-contract'

/**
 * Read-only rendering of a TORC lineage explanation.
 *
 * This panel renders derived provenance. It offers no control that changes
 * lineage state, and it never fills gaps in an untrusted explanation — when
 * TORC refuses to assert an authority timeline, so does this view.
 */

function changeTone(kind: string): string {
  if (kind.includes('recovery')) return 'border-amber-500/30 bg-amber-500/10 text-amber-400'
  if (kind.includes('branch')) return 'border-sky-500/30 bg-sky-500/10 text-sky-400'
  if (kind.includes('rollback')) return 'border-violet-500/30 bg-violet-500/10 text-violet-400'
  return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
}

function Badge({ value, className }: { value: string; className?: string }) {
  return (
    <span
      className={`inline-flex rounded border px-2 py-0.5 text-[11px] font-medium ${
        className ?? 'border-border bg-secondary text-muted-foreground'
      }`}
    >
      {value}
    </span>
  )
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

function UntrustedNotice({ warnings }: { warnings: string[] }) {
  return (
    <div className="rounded border border-red-500/30 bg-red-500/10 p-3 text-sm">
      <p className="font-medium text-red-400">
        TORC could not verify this lineage, so no authority timeline is asserted.
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        Run <code>torc verify</code> for the detailed integrity diagnostic.
      </p>
    </div>
  )
}

function AuthorityChanges({ explanation }: { explanation: LineageExplanation }) {
  if (explanation.authority_changes.length === 0) {
    return <p className="text-sm text-muted-foreground">No authority changes recorded.</p>
  }
  return (
    <ol className="space-y-2">
      {explanation.authority_changes.map((change) => (
        <li
          key={change.transition_id ?? `${change.sequence}`}
          className="rounded border border-border bg-secondary/40 p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">#{change.sequence}</span>
            <Badge value={change.kind} className={changeTone(change.kind)} />
            <span className="text-xs text-muted-foreground">
              {formatTimestamp(change.occurred_at)}
            </span>
          </div>
          <p className="mt-1 text-sm">{change.summary}</p>
          {change.to_authority?.substrate_label ? (
            <p className="mt-1 text-xs text-muted-foreground">
              bearer: {change.to_authority.substrate_label}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

function Handoffs({ explanation }: { explanation: LineageExplanation }) {
  if (explanation.handoffs.length === 0) return null
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">Handoffs</h3>
      <ul className="space-y-1">
        {explanation.handoffs.map((entry) => (
          <li
            key={entry.handoff_id}
            className="flex flex-wrap items-center gap-2 rounded border border-border px-3 py-2 text-sm"
          >
            <Badge value={entry.state} />
            <code className="text-xs text-muted-foreground">{entry.handoff_id}</code>
            <span className="text-xs text-muted-foreground">
              {entry.authority_effect === 'transferred'
                ? 'transferred authority'
                : 'did not transfer authority'}
            </span>
            {entry.reason_code ? (
              <span className="text-xs text-muted-foreground">({entry.reason_code})</span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

function ContinuityEvents({ explanation }: { explanation: LineageExplanation }) {
  if (explanation.continuity_events.length === 0) return null
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">Continuity events</h3>
      <ul className="space-y-1">
        {explanation.continuity_events.map((event, index) => (
          <li
            key={`${event.event_type}-${index}`}
            className="rounded border border-border px-3 py-2 text-sm"
          >
            <Badge value={event.event_type} className={changeTone(event.event_type)} />
            <span className="ml-2">{event.summary}</span>
            {event.authority_changed === false ? (
              <span className="ml-2 text-xs text-muted-foreground">(no authority change)</span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

export function TorcLineagePanel({
  lineage,
  stateDir,
}: {
  lineage: string
  stateDir: string
}) {
  const [explanation, setExplanation] = useState<LineageExplanation | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ lineage, stateDir })
      const body = await apiFetch(`/api/lugos/lineage?${params.toString()}`)
      const parsed = lineageExplanationSchema.safeParse(body)
      if (!parsed.success) {
        setExplanation(null)
        setError('TORC returned an unrecognized lineage payload')
        return
      }
      setExplanation(parsed.data)
    } catch (caught) {
      setExplanation(null)
      setError(
        caught instanceof ApiError ? caught.message : 'TORC lineage view unavailable',
      )
    } finally {
      setLoading(false)
    }
  }, [lineage, stateDir])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">Lineage {lineage}</h2>
        <Badge value="derived" />
        <Badge value="non-canonical" />
        {explanation ? (
          <Badge
            value={explanation.trusted ? 'trusted' : 'unverified'}
            className={
              explanation.trusted
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                : 'border-red-500/30 bg-red-500/10 text-red-400'
            }
          />
        ) : null}
      </header>

      {loading ? <p className="text-sm text-muted-foreground">Loading lineage…</p> : null}
      {error ? <p className="text-sm text-red-400">{error}</p> : null}

      {explanation && !explanation.trusted ? (
        <UntrustedNotice warnings={explanation.warnings} />
      ) : null}

      {explanation && explanation.trusted ? (
        <>
          <section className="space-y-2">
            <h3 className="text-sm font-medium">Authority changes</h3>
            <AuthorityChanges explanation={explanation} />
          </section>
          <Handoffs explanation={explanation} />
          <ContinuityEvents explanation={explanation} />
        </>
      ) : null}
    </div>
  )
}
