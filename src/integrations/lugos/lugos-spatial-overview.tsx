'use client'

import { useMemo, useState } from 'react'
import { useMissionControl } from '@/store'
import type { AutoworkRun } from './operator-contract'
import { addOperatorReceipt } from './operator-state'
import {
  buildSpatialLayout,
  type SpatialEntity,
  type SpatialStatus,
} from './spatial-layout'
import { useLugosOperator } from './use-lugos-operator'
import {
  CockpitDrillIn,
  CockpitExceptionDeck,
  CockpitTrustRail,
  type CockpitDetail,
} from './cockpit-overview'
import { DevicesDetail } from './network-devices'

const STATUS_TONE: Record<SpatialStatus, string> = {
  active: 'border-cyan-400/70 bg-cyan-400/10 text-cyan-200 shadow-[0_0_22px_rgba(34,211,238,0.12)]',
  attention: 'border-amber-400/80 bg-amber-400/10 text-amber-200',
  degraded: 'border-rose-500/70 bg-rose-500/10 text-rose-200',
  stale: 'border-orange-400/60 bg-orange-400/10 text-orange-200',
  terminal: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-200',
  idle: 'border-slate-600 bg-slate-800/70 text-slate-300',
}

const STATUS_DOT: Record<SpatialStatus, string> = {
  active: 'bg-cyan-300',
  attention: 'bg-amber-300',
  degraded: 'bg-rose-400',
  stale: 'bg-orange-400',
  terminal: 'bg-emerald-400',
  idle: 'bg-slate-500',
}

function formatDuration(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (value < 1000) return `${value}ms`
  const seconds = Math.round(value / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function AituCard({
  eyebrow,
  title,
  values,
}: {
  eyebrow: string
  title: string
  values: Array<{ label: string; value: string | number; tone?: string }>
}) {
  return (
    <section className="rounded-xl border border-border bg-card/80 p-3 shadow-sm">
      <div className="text-[9px] font-semibold uppercase tracking-[0.24em] text-cyan-400">
        {eyebrow}
      </div>
      <h3 className="mt-1 text-xs font-semibold text-foreground">{title}</h3>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {values.map(item => (
          <div key={item.label} className="rounded-lg border border-border/70 bg-background/60 px-2.5 py-2">
            <div className={`font-mono text-lg font-semibold ${item.tone ?? 'text-foreground'}`}>
              {item.value}
            </div>
            <div className="mt-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
              {item.label}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function EntityNode({
  entity,
  selected,
  onSelect,
}: {
  entity: SpatialEntity
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      aria-label={`${entity.kind} ${entity.label}, ${entity.status}`}
      aria-pressed={selected}
      className={`absolute z-10 w-24 -translate-x-1/2 -translate-y-1/2 rounded-lg border px-2 py-2 text-left transition-[border-color,box-shadow,transform] duration-150 hover:scale-105 focus-visible:scale-105 sm:w-28 ${STATUS_TONE[entity.status]} ${selected ? 'ring-2 ring-white/70 ring-offset-2 ring-offset-background' : ''}`}
      style={{ left: `${entity.x}%`, top: `${entity.y}%` }}
      onClick={onSelect}
    >
      <span className="flex items-center gap-1.5">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[entity.status]} ${entity.status === 'active' ? 'animate-pulse motion-reduce:animate-none' : ''}`}
        />
        <span className="truncate text-[10px] font-semibold uppercase tracking-wider opacity-70">
          {entity.kind}
        </span>
      </span>
      <span className="mt-1 block truncate font-mono text-xs font-semibold">
        {entity.label}
      </span>
      <span className="mt-0.5 block truncate text-[9px] opacity-60">
        {entity.secondary}
      </span>
      <span className="sr-only">Status: {entity.status}.</span>
    </button>
  )
}

function DenseDetail({
  entity,
  runs,
}: {
  entity: SpatialEntity
  runs: AutoworkRun[]
}) {
  const entityRuns = runs.filter(run => entity.runIds.includes(run.run_id))
  return (
    <section className="rounded-xl border border-border bg-card/90">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <div className="text-[9px] font-semibold uppercase tracking-[0.24em] text-violet-400">
            AITU drill-in
          </div>
          <h3 className="mt-1 font-mono text-sm font-semibold text-foreground">{entity.label}</h3>
        </div>
        <div className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-wider ${STATUS_TONE[entity.status]}`}>
          {entity.kind} · {entity.status}
        </div>
      </div>
      <div className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[38rem] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="pb-2 font-medium">Run / repo</th>
                <th className="pb-2 font-medium">Identity</th>
                <th className="pb-2 font-medium">Route / model</th>
                <th className="pb-2 font-medium">Phase</th>
                <th className="pb-2 font-medium">Elapsed</th>
                <th className="pb-2 font-medium">Outcome</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {entityRuns.map(run => (
                <tr key={run.run_id}>
                  <td className="py-2 pr-4">
                    <div className="font-mono text-foreground">{run.run_id}</div>
                    <div className="text-muted-foreground">{run.repo}</div>
                  </td>
                  <td className="py-2 pr-4 font-mono text-foreground">
                    {run.agent_address || run.source_host}
                  </td>
                  <td className="py-2 pr-4 text-foreground">
                    {run.route || '—'} / {run.model || '—'}
                  </td>
                  <td className="py-2 pr-4 text-foreground">{run.current_phase || '—'}</td>
                  <td className="py-2 pr-4 font-mono text-foreground">
                    {formatDuration(run.elapsed_ms)}
                  </td>
                  <td className="py-2 text-foreground">{run.outcome || 'unknown'}</td>
                </tr>
              ))}
              {entityRuns.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-7 text-center text-muted-foreground">
                    No runs are attached to this derived entity.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="space-y-2">
          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Evidence</div>
            <div className="mt-2 space-y-1.5">
              {entityRuns.flatMap(run => run.evidence.map(item => (
                <div key={`${run.run_id}:${item.kind}:${item.label}`} className="text-xs text-foreground">
                  <span className="text-cyan-400">{item.kind}</span> · {item.label}
                </div>
              )))}
              {entityRuns.every(run => run.evidence.length === 0) && (
                <div className="text-xs text-muted-foreground">No evidence labels.</div>
              )}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Attention</div>
            <div className="mt-2 text-xs text-foreground">
              {entityRuns.flatMap(run => run.attention).join(' · ') || 'No active attention codes.'}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

export function LugosSpatialOverview() {
  const {
    operatorState,
    setOperatorState,
    loading,
    streamState,
    error,
    reload,
  } = useLugosOperator()
  const currentUser = useMissionControl(state => state.currentUser)
  const canCommand = currentUser?.role === 'operator' || currentUser?.role === 'admin'
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [cockpitDetail, setCockpitDetail] = useState<CockpitDetail | null>(null)
  const projection = operatorState.projection
  const layout = useMemo(
    () => projection ? buildSpatialLayout(projection) : null,
    [projection],
  )
  const defaultEntity = layout?.entities.find(entity => entity.status === 'attention')
    ?? layout?.entities.find(entity => entity.status === 'active')
    ?? layout?.entities[0]
  const selected = layout?.entities.find(entity => entity.id === selectedId) ?? defaultEntity
  const positions = new Map(layout?.entities.map(entity => [entity.id, entity]) ?? [])
  const analytics = projection?.analytics
  const cockpit = operatorState.fleet && operatorState.diagnostics && operatorState.branReadiness
    ? {
        fleet: operatorState.fleet,
        diagnostics: operatorState.diagnostics,
        branReadiness: operatorState.branReadiness,
        networkDevices: operatorState.networkDevices,
      }
    : null
  const openCockpitDetail = (detail: CockpitDetail) => {
    setCockpitDetail(detail)
    window.requestAnimationFrame(() => {
      document.getElementById('lugos-cockpit-details')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      })
    })
  }

  return (
    <div className="min-h-full bg-[radial-gradient(circle_at_50%_0%,rgba(34,211,238,0.07),transparent_32%)] p-3 sm:p-4">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight text-foreground">Lugos Fleet</h1>
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest ${streamState === 'live' ? 'border-cyan-400/40 bg-cyan-400/10 text-cyan-300' : 'border-amber-400/40 bg-amber-400/10 text-amber-300'}`}>
              {streamState}
            </span>
            <span className="rounded-full border border-violet-400/30 bg-violet-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-violet-300">
              Lugos authoritative
            </span>
          </div>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Automatic semantic layout of machines, route-derived services, and agents. Placement carries no operational meaning.
          </p>
        </div>
        <div className="text-right font-mono text-[10px] text-muted-foreground">
          <div>{projection?.generatedAt ? new Date(projection.generatedAt).toLocaleString() : 'Awaiting snapshot'}</div>
          <div>{operatorState.cursor ?? 'no cursor'} · {operatorState.receipts.length} receipts</div>
        </div>
      </header>

      {error && (
        <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {error}
        </div>
      )}

      {loading || !projection || !layout ? (
        <div className="rounded-xl border border-border bg-card py-24 text-center text-sm text-muted-foreground">
          Loading the Lugos fleet projection…
        </div>
      ) : (
        <div className="space-y-4">
          {cockpit && (
            <CockpitTrustRail
              {...cockpit}
              onOpen={openCockpitDetail}
            />
          )}
          <div className="grid gap-4 xl:grid-cols-[14rem_minmax(36rem,1fr)_16rem]">
            <aside className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              <AituCard
                eyebrow="AITU · Activity"
                title="Fleet work"
                values={[
                  { label: 'active', value: projection.summary.active, tone: 'text-cyan-300' },
                  { label: 'attention', value: projection.summary.attention, tone: 'text-amber-300' },
                  { label: 'terminal 24h', value: projection.summary.terminal24h },
                  { label: 'first pass', value: projection.summary.firstPassVerified24h },
                ]}
              />
              <AituCard
                eyebrow="AITU · Outcomes"
                title={`${analytics?.window_hours ?? 24} hour window`}
                values={[
                  { label: 'accepted', value: analytics?.outcomes.accepted ?? 0, tone: 'text-emerald-300' },
                  { label: 'partial', value: analytics?.outcomes.partial ?? 0, tone: 'text-amber-300' },
                  { label: 'rejected', value: analytics?.outcomes.rejected ?? 0, tone: 'text-rose-300' },
                  { label: 'incomplete', value: analytics?.outcomes.incomplete ?? 0 },
                ]}
              />
              <AituCard
                eyebrow="AITU · Timing"
                title="Median phases"
                values={[
                  { label: 'work', value: formatDuration(analytics?.phase_duration_ms.work) },
                  { label: 'review', value: formatDuration(analytics?.phase_duration_ms.review) },
                  { label: 'verify', value: formatDuration(analytics?.phase_duration_ms.verify) },
                  { label: 'fallbacks', value: analytics?.outcomes.fallback_used ?? 0 },
                ]}
              />
            </aside>

            <main className="overflow-x-auto rounded-xl border border-border bg-card/60">
              <div className="flex min-w-[36rem] items-center justify-between border-b border-border px-3 py-2">
                <div>
                  <div className="text-[9px] font-semibold uppercase tracking-[0.24em] text-cyan-400">
                    Semantic fleet map
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    machine → agent → derived route
                  </div>
                </div>
                <div className="flex flex-wrap justify-end gap-2 text-[9px] uppercase tracking-wider text-muted-foreground">
                  {(['active', 'attention', 'stale', 'terminal', 'idle'] as SpatialStatus[]).map(status => (
                    <span key={status} className="flex items-center gap-1">
                      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]}`} />
                      {status}
                    </span>
                  ))}
                </div>
              </div>
              <div className="relative h-[34rem] min-w-[36rem] overflow-hidden bg-[linear-gradient(rgba(148,163,184,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.04)_1px,transparent_1px)] bg-[size:32px_32px]">
                <div className="absolute inset-y-0 left-[29%] border-l border-dashed border-border/60" />
                <div className="absolute inset-y-0 left-[65%] border-l border-dashed border-border/60" />
                <div className="absolute left-3 top-3 text-[9px] uppercase tracking-[0.2em] text-muted-foreground">Machines</div>
                <div className="absolute left-[42%] top-3 text-[9px] uppercase tracking-[0.2em] text-muted-foreground">Services</div>
                <div className="absolute right-3 top-3 text-[9px] uppercase tracking-[0.2em] text-muted-foreground">Agents</div>
                <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                  {layout.edges.map(edge => {
                    const from = positions.get(edge.from)
                    const to = positions.get(edge.to)
                    if (!from || !to) return null
                    return (
                      <line
                        key={edge.id}
                        x1={from.x}
                        y1={from.y}
                        x2={to.x}
                        y2={to.y}
                        vectorEffect="non-scaling-stroke"
                        className={edge.active ? 'animate-pulse stroke-cyan-400/50 motion-reduce:animate-none' : 'stroke-slate-600/40'}
                        strokeWidth={edge.active ? 1.5 : 1}
                        strokeDasharray={edge.active ? '0' : '3 4'}
                      />
                    )
                  })}
                </svg>
                {layout.entities.map(entity => (
                  <EntityNode
                    key={entity.id}
                    entity={entity}
                    selected={selected?.id === entity.id}
                    onSelect={() => setSelectedId(entity.id)}
                  />
                ))}
              </div>
            </main>

            <aside className="flex min-h-0 flex-col rounded-xl border border-border bg-card/80">
              <div className="border-b border-border px-3 py-3">
                <div className="text-[9px] font-semibold uppercase tracking-[0.24em] text-amber-400">
                  Attention rail
                </div>
                <h2 className="mt-1 text-xs font-semibold text-foreground">
                  {layout.attention.length} ordered signal{layout.attention.length === 1 ? '' : 's'}
                </h2>
              </div>
              <div className="max-h-[25rem] flex-1 space-y-2 overflow-y-auto p-3">
                {layout.attention.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className="w-full rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-left hover:border-amber-300/70"
                    onClick={() => setSelectedId(item.targetEntityId)}
                  >
                    <div className="truncate font-mono text-xs font-semibold text-amber-200">{item.code}</div>
                    <div className="mt-1 truncate text-[10px] text-foreground">{item.runId}</div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {item.agentAddress || item.sourceHost}
                    </div>
                  </button>
                ))}
                {layout.attention.length === 0 && (
                  <div className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
                    No active attention signals.
                  </div>
                )}
              </div>
              <div className="border-t border-border p-3">
                <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Projection health</div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-foreground">{projection.source.host}</span>
                  <span className={projection.source.state === 'ready' ? 'text-xs text-emerald-300' : 'text-xs text-amber-300'}>
                    {projection.source.state}
                  </span>
                </div>
                {projection.source.diagnostics.length > 0 && (
                  <div className="mt-1 text-[10px] text-amber-300">{projection.source.diagnostics.join(' · ')}</div>
                )}
              </div>
            </aside>
          </div>

          {cockpit && (
            <CockpitExceptionDeck
              {...cockpit}
              onOpen={openCockpitDetail}
            />
          )}
          {cockpit && cockpitDetail && (
            <CockpitDrillIn
              {...cockpit}
              detail={cockpitDetail}
              onSelect={setCockpitDetail}
              onClose={() => setCockpitDetail(null)}
              canCommand={canCommand}
              onReceipt={receipt => setOperatorState(current => addOperatorReceipt(current, receipt))}
              onReload={reload}
            />
          )}
          {operatorState.networkDevices && cockpitDetail !== 'devices' && (
            <section
              id="lugos-network-devices"
              className="rounded-xl border border-cyan-400/20 bg-card/90"
              aria-labelledby="lugos-network-devices-heading"
            >
              <div className="border-b border-border px-3 py-3">
                <div className="text-[9px] font-semibold uppercase tracking-[0.24em] text-cyan-400">
                  Network device registry
                </div>
                <h2 id="lugos-network-devices-heading" className="mt-1 text-xs font-semibold text-foreground">
                  Devices observed by the GL-B3000
                </h2>
              </div>
              <div className="p-3 sm:p-4">
                <DevicesDetail
                  networkDevices={operatorState.networkDevices}
                  targetSlugs={operatorState.fleet?.targets.map(target => target.slug) ?? []}
                  canCommand={canCommand}
                  onReceipt={receipt => setOperatorState(current => addOperatorReceipt(current, receipt))}
                  onReload={reload}
                />
              </div>
            </section>
          )}
          {selected && <DenseDetail entity={selected} runs={projection.runs} />}
        </div>
      )}
    </div>
  )
}
