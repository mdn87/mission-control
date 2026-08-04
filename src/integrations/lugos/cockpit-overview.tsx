'use client'

import { useMemo } from 'react'
import type {
  BranReadinessProjection,
  CockpitSource,
  CockpitState,
  DiagnosticsProjection,
  FleetProjection,
} from './cockpit-contract'

export type CockpitDetail = 'fleet' | 'diagnostics' | 'bran'

const STATE_PRIORITY: Record<CockpitState, number> = {
  blocked: 0,
  unavailable: 1,
  attention: 2,
  degraded: 3,
  stale: 4,
  unknown: 5,
  active: 6,
  ready: 7,
  healthy: 8,
  idle: 9,
}

const STATE_TONE: Record<CockpitState, string> = {
  ready: 'border-emerald-500/25 bg-emerald-500/5 text-emerald-300',
  healthy: 'border-border bg-card/70 text-slate-300',
  idle: 'border-border bg-card/70 text-slate-400',
  active: 'border-cyan-400/40 bg-cyan-400/8 text-cyan-300',
  attention: 'border-amber-400/40 bg-amber-400/8 text-amber-300',
  stale: 'border-orange-400/40 bg-orange-400/8 text-orange-300',
  degraded: 'border-amber-400/40 bg-amber-400/8 text-amber-300',
  blocked: 'border-rose-500/45 bg-rose-500/8 text-rose-300',
  unavailable: 'border-rose-500/45 bg-rose-500/8 text-rose-300',
  unknown: 'border-slate-500/40 bg-slate-500/8 text-slate-300',
}

function worstState(states: CockpitState[]): CockpitState {
  if (states.length === 0) return 'unknown'
  return [...states].sort(
    (left, right) => STATE_PRIORITY[left] - STATE_PRIORITY[right],
  )[0]
}

function sourceState(source: CockpitSource | null | undefined): CockpitState {
  return source?.state ?? 'unknown'
}

function formatAge(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'age unknown'
  if (value < 60) return `${value}s ago`
  if (value < 3_600) return `${Math.floor(value / 60)}m ago`
  if (value < 86_400) return `${Math.floor(value / 3_600)}h ago`
  return `${Math.floor(value / 86_400)}d ago`
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'unknown'
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : 'unknown'
}

function StateBadge({ state }: { state: CockpitState }) {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${STATE_TONE[state]}`}
    >
      {state}
    </span>
  )
}

interface CockpitProps {
  fleet: FleetProjection
  diagnostics: DiagnosticsProjection
  branReadiness: BranReadinessProjection
}

interface TrustSignal {
  id: string
  label: string
  value: string
  state: CockpitState
  evidence: string
  target: CockpitDetail
}

function buildTrustSignals({
  fleet,
  diagnostics,
  branReadiness,
}: CockpitProps): TrustSignal[] {
  const allSources = [
    ...Object.values(fleet.sources),
    ...Object.values(diagnostics.sources),
    branReadiness.source,
  ]
  const projectionState = worstState(allSources.map(sourceState))
  const routeStates: CockpitState[] = [
    diagnostics.models.gateway.state,
    diagnostics.models.ollama.state,
    diagnostics.models.gemini.state,
    ...diagnostics.models.aliases.map(alias => alias.state),
  ]
  return [{
    id: 'projection',
    label: 'Projection',
    value: projectionState === 'healthy' ? 'Current' : projectionState,
    state: projectionState,
    evidence: `${allSources.filter(source => source.state === 'healthy').length}/${allSources.length} sources healthy`,
    target: 'fleet',
  }, {
    id: 'autosync',
    label: 'Autosync',
    value: diagnostics.autosync.state,
    state: diagnostics.autosync.state,
    evidence: formatAge(diagnostics.autosync.ageSecs),
    target: 'diagnostics',
  }, {
    id: 'monitors',
    label: 'Monitors',
    value: `${diagnostics.monitors.summary.directState} / ${diagnostics.monitors.summary.publicState}`,
    state: worstState([
      diagnostics.monitors.summary.directState,
      diagnostics.monitors.summary.publicState,
    ]),
    evidence: `${diagnostics.monitors.summary.healthy}/${diagnostics.monitors.summary.total} healthy`,
    target: 'diagnostics',
  }, {
    id: 'repositories',
    label: 'Repositories',
    value: diagnostics.repositories.summary.attention > 0
      ? `${diagnostics.repositories.summary.attention} exceptions`
      : 'Safe',
    state: diagnostics.repositories.summary.attention > 0
      ? 'attention'
      : sourceState(diagnostics.sources.repositories),
    evidence: `${diagnostics.repositories.summary.ready}/${diagnostics.repositories.summary.total} ready`,
    target: 'diagnostics',
  }, {
    id: 'models',
    label: 'Model routes',
    value: diagnostics.models.gateway.state,
    state: worstState(routeStates),
    evidence: `${diagnostics.models.aliases.filter(alias => alias.listed).length}/${diagnostics.models.aliases.length} aliases listed`,
    target: 'diagnostics',
  }]
}

export function CockpitTrustRail({
  fleet,
  diagnostics,
  branReadiness,
  onOpen,
}: CockpitProps & { onOpen: (detail: CockpitDetail) => void }) {
  const signals = useMemo(
    () => buildTrustSignals({ fleet, diagnostics, branReadiness }),
    [fleet, diagnostics, branReadiness],
  )
  return (
    <section aria-labelledby="cockpit-trust-heading">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <div className="text-[9px] font-semibold uppercase tracking-[0.24em] text-cyan-400">
            Operator trust
          </div>
          <h2 id="cockpit-trust-heading" className="text-xs font-semibold text-foreground">
            Freshness and readiness
          </h2>
        </div>
        <div className="text-[10px] text-muted-foreground">
          Select a signal for bounded evidence
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {signals.map(signal => (
          <button
            key={signal.id}
            type="button"
            className={`rounded-lg border px-3 py-2 text-left transition-colors hover:border-cyan-400/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${STATE_TONE[signal.state]}`}
            aria-label={`${signal.label}: ${signal.value}, ${signal.evidence}. Open evidence.`}
            onClick={() => onOpen(signal.target)}
          >
            <span className="block text-[9px] font-semibold uppercase tracking-wider opacity-70">
              {signal.label}
            </span>
            <span className="mt-1 block truncate text-xs font-semibold capitalize">
              {signal.value}
            </span>
            <span className="mt-0.5 block truncate text-[10px] opacity-70">
              {signal.evidence}
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

type ExceptionSeverity = 'blocked' | 'unavailable' | 'attention' | 'degraded' | 'stale' | 'unknown'

interface CockpitException {
  id: string
  severity: ExceptionSeverity
  title: string
  detail: string
  ageSecs: number | null
  scope: number
  target: CockpitDetail
}

const EXCEPTION_PRIORITY: Record<ExceptionSeverity, number> = {
  blocked: 0,
  unavailable: 1,
  attention: 2,
  degraded: 3,
  stale: 4,
  unknown: 5,
}

function asExceptionSeverity(state: CockpitState): ExceptionSeverity | null {
  if (['ready', 'healthy', 'idle', 'active'].includes(state)) return null
  return state as ExceptionSeverity
}

function buildExceptions({
  fleet,
  diagnostics,
  branReadiness,
}: CockpitProps): CockpitException[] {
  const exceptions: CockpitException[] = []
  const referenceMs = Math.max(
    Date.parse(fleet.generatedAt),
    Date.parse(diagnostics.generatedAt),
    Date.parse(branReadiness.generatedAt),
  )
  for (const handoff of fleet.handoffs) {
    exceptions.push({
      id: `handoff:${handoff.messageId}`,
      severity: handoff.responseRequested ? 'attention' : 'unknown',
      title: handoff.responseRequested ? 'Response requested' : 'Unacknowledged handoff',
      detail: `${handoff.fromAgent} → ${handoff.toAgent} · ${handoff.preview}`,
      ageSecs: handoff.ageSecs,
      scope: 1,
      target: 'fleet',
    })
  }
  for (const repository of diagnostics.repositories.exceptions) {
    const severity: ExceptionSeverity = repository.checkState === 'failing'
      ? 'blocked'
      : repository.signals.includes('pointer_drift') || repository.dirty
        ? 'attention'
        : repository.checkState === 'pending'
          ? 'degraded'
          : 'unknown'
    exceptions.push({
      id: `repo:${repository.repoId}`,
      severity,
      title: `${repository.name} is not ready`,
      detail: repository.signals.join(' · ').replaceAll('_', ' ') || repository.checkState,
      ageSecs: Math.max(0, Math.floor(
        (referenceMs - Date.parse(repository.observedAt)) / 1_000,
      )),
      scope: repository.kind === 'parent' ? 3 : 2,
      target: 'diagnostics',
    })
  }
  for (const exception of diagnostics.governance.activeExceptions) {
    const severity = asExceptionSeverity(exception.state)
    if (!severity) continue
    exceptions.push({
      id: `governance:${exception.code}:${exception.assignmentId ?? exception.runId ?? 'active'}`,
      severity,
      title: `Governance exception: ${exception.code.replaceAll('_', ' ')}`,
      detail: exception.assignmentId ?? exception.runId ?? 'Current assignment envelope',
      ageSecs: Math.max(0, Math.floor(
        (referenceMs - Date.parse(exception.observedAt)) / 1_000,
      )),
      scope: 3,
      target: 'diagnostics',
    })
  }
  const autosyncSeverity = asExceptionSeverity(diagnostics.autosync.state)
  if (autosyncSeverity) {
    exceptions.push({
      id: 'autosync',
      severity: autosyncSeverity,
      title: `Autosync is ${diagnostics.autosync.state}`,
      detail: diagnostics.autosync.diagnosticCodes.join(' · ').replaceAll('_', ' ') || 'No current tick evidence',
      ageSecs: diagnostics.autosync.ageSecs,
      scope: 3,
      target: 'diagnostics',
    })
  }
  for (const monitor of diagnostics.monitors.monitors) {
    const severity = asExceptionSeverity(monitor.state)
    if (!severity) continue
    exceptions.push({
      id: `monitor:${monitor.monitorId}`,
      severity,
      title: `${monitor.name} is ${monitor.state}`,
      detail: `${monitor.plane} monitor · ${monitor.diagnosticCodes.join(' · ').replaceAll('_', ' ') || 'evidence incomplete'}`,
      ageSecs: monitor.ageSecs,
      scope: monitor.plane === 'public' ? 3 : 2,
      target: 'diagnostics',
    })
  }
  for (const alias of diagnostics.models.aliases) {
    const severity = asExceptionSeverity(alias.state)
    if (!severity) continue
    exceptions.push({
      id: `model:${alias.alias}`,
      severity,
      title: `${alias.alias} is ${alias.state}`,
      detail: `${alias.provider}/${alias.backendModel} · ${alias.diagnosticCodes.join(' · ').replaceAll('_', ' ') || 'backend evidence incomplete'}`,
      ageSecs: diagnostics.models.gateway.ageSecs,
      scope: 2,
      target: 'diagnostics',
    })
  }
  for (const pack of branReadiness.packs) {
    if (!['blocked', 'stale', 'unknown'].includes(pack.status)) continue
    exceptions.push({
      id: `bran:${pack.latestRef}`,
      severity: pack.status as ExceptionSeverity,
      title: `${pack.title} is ${pack.status}`,
      detail: pack.blockingCodes.join(' · ').replaceAll('_', ' ') || `${pack.latestRef} needs evidence`,
      ageSecs: pack.ageSecs,
      scope: 2,
      target: 'bran',
    })
  }
  for (const target of fleet.targets) {
    const severity = asExceptionSeverity(target.state)
    if (!severity) continue
    exceptions.push({
      id: `target:${target.slug}`,
      severity,
      title: `${target.label} is ${target.state}`,
      detail: target.diagnosticCodes.join(' · ').replaceAll('_', ' ') || 'Observed runtime incomplete',
      ageSecs: null,
      scope: 2,
      target: 'fleet',
    })
  }
  return exceptions.sort((left, right) =>
    EXCEPTION_PRIORITY[left.severity] - EXCEPTION_PRIORITY[right.severity]
    || right.scope - left.scope
    || (right.ageSecs ?? -1) - (left.ageSecs ?? -1)
    || left.title.localeCompare(right.title))
}

export function CockpitExceptionDeck({
  fleet,
  diagnostics,
  branReadiness,
  onOpen,
}: CockpitProps & { onOpen: (detail: CockpitDetail) => void }) {
  const exceptions = useMemo(
    () => buildExceptions({ fleet, diagnostics, branReadiness }),
    [fleet, diagnostics, branReadiness],
  )
  return (
    <section
      className="rounded-xl border border-border bg-card/70"
      aria-labelledby="cockpit-exception-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-3">
        <div>
          <div className="text-[9px] font-semibold uppercase tracking-[0.24em] text-amber-400">
            Exception deck
          </div>
          <h2 id="cockpit-exception-heading" className="mt-1 text-xs font-semibold text-foreground">
            {exceptions.length} ordered exception{exceptions.length === 1 ? '' : 's'}
          </h2>
        </div>
        <div className="text-[10px] text-muted-foreground">
          Severity → scope → age
        </div>
      </div>
      {exceptions.length === 0 ? (
        <div className="px-4 py-7 text-center text-xs text-muted-foreground">
          No actionable cockpit exceptions.
        </div>
      ) : (
        <div className="grid gap-2 p-3 lg:grid-cols-2 2xl:grid-cols-3">
          {exceptions.slice(0, 30).map(exception => (
            <button
              key={exception.id}
              type="button"
              className={`rounded-lg border px-3 py-2 text-left transition-colors hover:border-cyan-400/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 ${STATE_TONE[exception.severity]}`}
              onClick={() => onOpen(exception.target)}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-semibold">{exception.title}</span>
                <StateBadge state={exception.severity} />
              </span>
              <span className="mt-1 block line-clamp-2 text-[10px] opacity-75">
                {exception.detail}
              </span>
              <span className="mt-1 block text-[9px] uppercase tracking-wider opacity-60">
                {formatAge(exception.ageSecs)}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function SourceEvidence({
  label,
  source,
}: {
  label: string
  source: CockpitSource
}) {
  return (
    <div className={`rounded-lg border p-3 ${STATE_TONE[source.state]}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider">{label}</span>
        <StateBadge state={source.state} />
      </div>
      <div className="mt-2 text-[10px] opacity-75">
        Last success {formatTimestamp(source.lastSuccessAt)} · {formatAge(source.ageSecs)}
      </div>
      {source.diagnosticCodes.length > 0 && (
        <div className="mt-1 text-[10px] opacity-75">
          {source.diagnosticCodes.join(' · ').replaceAll('_', ' ')}
        </div>
      )}
    </div>
  )
}

function FleetDetail({ fleet }: { fleet: FleetProjection }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3">
        {Object.entries(fleet.sources).map(([name, source]) => (
          <SourceEvidence key={name} label={name} source={source} />
        ))}
      </div>
      <section>
        <h3 className="text-xs font-semibold text-foreground">Connected agents</h3>
        <div className="mt-2 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[48rem] text-left text-xs">
            <thead className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Agent</th>
                <th className="px-3 py-2 font-medium">Presence</th>
                <th className="px-3 py-2 font-medium">Host / session</th>
                <th className="px-3 py-2 font-medium">Repo / branch</th>
                <th className="px-3 py-2 font-medium">Current task</th>
                <th className="px-3 py-2 font-medium">Freshness</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {fleet.agents.map(agent => (
                <tr key={agent.sessionId}>
                  <td className="px-3 py-2 font-mono text-foreground">{agent.agentAddress}</td>
                  <td className="px-3 py-2"><StateBadge state={agent.presence} /></td>
                  <td className="px-3 py-2 text-foreground">
                    {agent.host}<div className="font-mono text-[10px] text-muted-foreground">{agent.sessionId}</div>
                  </td>
                  <td className="px-3 py-2 text-foreground">{agent.repo ?? '—'} / {agent.branch ?? '—'}</td>
                  <td className="max-w-64 truncate px-3 py-2 text-foreground">{agent.task ?? '—'}</td>
                  <td className="px-3 py-2 text-muted-foreground">{formatAge(agent.ageSecs)}</td>
                </tr>
              ))}
              {fleet.agents.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-7 text-center text-muted-foreground">No connected agent sessions.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="text-xs font-semibold text-foreground">Actionable Agent Mail</h3>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              Current unacknowledged inbox only · {fleet.handoffScope.horizonHours ?? 'unknown'}h horizon · no history mutation
            </p>
          </div>
          {fleet.handoffScope.truncated && <StateBadge state="attention" />}
        </div>
        <div className="mt-2 grid gap-2 lg:grid-cols-2">
          {fleet.handoffs.map(handoff => (
            <article key={handoff.messageId} className="rounded-lg border border-border bg-background/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-foreground">mail #{handoff.messageId}</span>
                {handoff.responseRequested && <StateBadge state="attention" />}
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground">
                {handoff.fromAgent} → {handoff.toAgent} · {formatAge(handoff.ageSecs)}
              </div>
              <p className="mt-2 text-xs text-foreground">{handoff.preview}</p>
            </article>
          ))}
          {fleet.handoffs.length === 0 && (
            <div className="rounded-lg border border-dashed border-border px-3 py-7 text-center text-xs text-muted-foreground lg:col-span-2">
              No unacknowledged handoffs in configured mailboxes.
            </div>
          )}
        </div>
      </section>
      <section>
        <h3 className="text-xs font-semibold text-foreground">Lugos target inventory</h3>
        <div className="mt-2 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[48rem] text-left text-xs">
            <thead className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">State</th>
                <th className="px-3 py-2 font-medium">Roles</th>
                <th className="px-3 py-2 font-medium">Expected services</th>
                <th className="px-3 py-2 font-medium">Observed runtime</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {fleet.targets.map(target => (
                <tr key={target.slug}>
                  <td className="px-3 py-2 text-foreground">
                    <div className="font-semibold">{target.label}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">{target.slug} · {target.lanAddress ?? 'address unavailable'}</div>
                  </td>
                  <td className="px-3 py-2"><StateBadge state={target.state} /></td>
                  <td className="px-3 py-2 text-foreground">{target.roles.join(' · ') || '—'}</td>
                  <td className="px-3 py-2 text-foreground">
                    {target.expectedServices.map(service => `${service.name}: ${service.expectedState}`).join(' · ') || '—'}
                  </td>
                  <td className="px-3 py-2 text-foreground">
                    {target.observedServices.map(service => `${service.name}: ${service.state}`).join(' · ') || 'Not observed'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function DiagnosticsDetail({ diagnostics }: { diagnostics: DiagnosticsProjection }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {Object.entries(diagnostics.sources).map(([name, source]) => (
          <SourceEvidence key={name} label={name} source={source} />
        ))}
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <section className="rounded-lg border border-border bg-background/50 p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-foreground">Active governance envelope</h3>
            <StateBadge state={diagnostics.governance.status === 'active' ? 'active' : 'unknown'} />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div><dt className="text-muted-foreground">Release</dt><dd className="font-mono text-foreground">{diagnostics.governance.governanceId ?? 'unknown'} · {diagnostics.governance.policyVersion ?? 'unknown'}</dd></div>
            <div><dt className="text-muted-foreground">Scope approver</dt><dd className="text-foreground">{diagnostics.governance.scopeChangeApprover ?? 'unknown'}</dd></div>
            <div><dt className="text-muted-foreground">Warning / stop</dt><dd className="text-foreground">{diagnostics.governance.warningMultiplier ?? '—'}× / {diagnostics.governance.stopMultiplier ?? '—'}×</dd></div>
            <div><dt className="text-muted-foreground">Vertical slice</dt><dd className="text-foreground">{diagnostics.governance.verticalSliceBudgetFraction === null ? '—' : `${diagnostics.governance.verticalSliceBudgetFraction * 100}%`}</dd></div>
            <div><dt className="text-muted-foreground">Review ceiling</dt><dd className="text-foreground">{diagnostics.governance.maxDesignReviewRounds ?? '—'} rounds</dd></div>
            <div><dt className="text-muted-foreground">Output ceiling</dt><dd className="text-foreground">{diagnostics.governance.routingPolicy.outputCharacterLimit?.toLocaleString() ?? '—'} chars</dd></div>
          </dl>
          <div className="mt-3 text-[10px] text-muted-foreground">
            Triggers: {diagnostics.governance.scopeChangeTriggers.join(' · ').replaceAll('_', ' ') || 'none declared'}
          </div>
        </section>
        <section className="rounded-lg border border-border bg-background/50 p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-foreground">Autosync</h3>
            <StateBadge state={diagnostics.autosync.state} />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div><dt className="text-muted-foreground">Last tick</dt><dd className="text-foreground">{formatTimestamp(diagnostics.autosync.lastTickAt)}</dd></div>
            <div><dt className="text-muted-foreground">Last success</dt><dd className="text-foreground">{formatTimestamp(diagnostics.autosync.lastSuccessAt)}</dd></div>
            <div><dt className="text-muted-foreground">Last advance</dt><dd className="text-foreground">{formatTimestamp(diagnostics.autosync.lastAdvanceAt)}</dd></div>
            <div><dt className="text-muted-foreground">Next expected</dt><dd className="text-foreground">{formatTimestamp(diagnostics.autosync.nextExpectedAt)}</dd></div>
          </dl>
        </section>
      </div>
      <section>
        <h3 className="text-xs font-semibold text-foreground">Routing policy</h3>
        <div className="mt-2 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[38rem] text-left text-xs">
            <thead className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr><th className="px-3 py-2">Task</th><th className="px-3 py-2">Risk</th><th className="px-3 py-2">Route</th><th className="px-3 py-2">Tier</th></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {diagnostics.governance.routingPolicy.routes.map(route => (
                <tr key={`${route.taskClass}:${route.riskTier}`}>
                  <td className="px-3 py-2 text-foreground">{route.taskClass}</td>
                  <td className="px-3 py-2 text-foreground">{route.riskTier}</td>
                  <td className="px-3 py-2 font-mono text-foreground">{route.route}</td>
                  <td className="px-3 py-2 text-foreground">{route.serviceTier}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h3 className="text-xs font-semibold text-foreground">Repository exceptions</h3>
        <div className="mt-2 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[46rem] text-left text-xs">
            <thead className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr><th className="px-3 py-2">Repository</th><th className="px-3 py-2">Branch</th><th className="px-3 py-2">Ahead / behind</th><th className="px-3 py-2">Pointer</th><th className="px-3 py-2">Checks</th><th className="px-3 py-2">Signals</th></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {diagnostics.repositories.exceptions.map(repository => (
                <tr key={repository.repoId}>
                  <td className="px-3 py-2 text-foreground">{repository.name}<div className="text-[10px] text-muted-foreground">{repository.kind}</div></td>
                  <td className="px-3 py-2 font-mono text-foreground">{repository.branch ?? 'detached'}</td>
                  <td className="px-3 py-2 text-foreground">+{repository.ahead} / -{repository.behind}</td>
                  <td className="px-3 py-2"><StateBadge state={repository.pointerState === 'drift' ? 'attention' : repository.pointerState === 'unknown' ? 'unknown' : 'healthy'} /></td>
                  <td className="px-3 py-2"><StateBadge state={repository.checkState === 'failing' ? 'blocked' : repository.checkState === 'pending' ? 'attention' : repository.checkState === 'passing' ? 'healthy' : 'unknown'} /></td>
                  <td className="px-3 py-2 text-foreground">{repository.signals.join(' · ').replaceAll('_', ' ') || '—'}</td>
                </tr>
              ))}
              {diagnostics.repositories.exceptions.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-7 text-center text-muted-foreground">No repository exceptions.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h3 className="text-xs font-semibold text-foreground">Direct and public monitors</h3>
        <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {diagnostics.monitors.monitors.map(monitor => (
            <article key={monitor.monitorId} className={`rounded-lg border p-3 ${STATE_TONE[monitor.state]}`}>
              <div className="flex items-center justify-between gap-2"><span className="truncate text-xs font-semibold">{monitor.name}</span><StateBadge state={monitor.state} /></div>
              <div className="mt-1 text-[10px] opacity-70">{monitor.plane} · {formatAge(monitor.ageSecs)} · uptime {monitor.uptime24h === null ? 'unknown' : `${(monitor.uptime24h * 100).toFixed(2)}%`}</div>
            </article>
          ))}
        </div>
      </section>
      <section>
        <h3 className="text-xs font-semibold text-foreground">Model gateways and aliases</h3>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {Object.entries({
            Gateway: diagnostics.models.gateway,
            Ollama: diagnostics.models.ollama,
            Gemini: diagnostics.models.gemini,
          }).map(([label, model]) => (
            <div key={label} className={`rounded-lg border p-3 ${STATE_TONE[model.state]}`}>
              <div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold">{label}</span><StateBadge state={model.state} /></div>
              <div className="mt-1 text-[10px] opacity-70">{model.configured ? 'configured' : 'not configured'} · {model.listed ? 'listed' : 'not listed'}</div>
            </div>
          ))}
        </div>
        <div className="mt-2 overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[44rem] text-left text-xs">
            <thead className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr><th className="px-3 py-2">Alias</th><th className="px-3 py-2">Backend</th><th className="px-3 py-2">Host</th><th className="px-3 py-2">State</th><th className="px-3 py-2">Fallbacks</th></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {diagnostics.models.aliases.map(alias => (
                <tr key={alias.alias}>
                  <td className="px-3 py-2 font-mono text-foreground">{alias.alias}</td>
                  <td className="px-3 py-2 text-foreground">{alias.provider}/{alias.backendModel}</td>
                  <td className="px-3 py-2 font-mono text-foreground">{alias.hostRef}</td>
                  <td className="px-3 py-2"><StateBadge state={alias.state} /></td>
                  <td className="px-3 py-2 text-foreground">{alias.fallbackAliases.join(' → ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="rounded-lg border border-border bg-background/50 p-3">
        <h3 className="text-xs font-semibold text-foreground">Specialist custody</h3>
        <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2 xl:grid-cols-3">
          {[
            ['Memory', 'Sulis and Atlas remain authoritative.'],
            ['Traces', 'Use Jaeger for spans and waterfalls.'],
            ['File operations', 'Use Codelink for shares and transfers.'],
            ['Vision', 'Use Remotedesk for screen and vision operations.'],
            ['Media', 'Use the media generation tools.'],
            ['Workflows', 'Use the composed workflow tooling.'],
          ].map(([label, detail]) => (
            <div key={label} className="rounded border border-border px-3 py-2">
              <div className="font-semibold text-foreground">{label}</div>
              <div className="mt-0.5 text-muted-foreground">{detail}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function BranDetail({ branReadiness }: { branReadiness: BranReadinessProjection }) {
  return (
    <div className="space-y-4">
      <SourceEvidence label="Bran custody" source={branReadiness.source} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {Object.entries(branReadiness.summary).filter(([key]) => key !== 'total').map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border bg-background/50 px-3 py-2">
            <div className="font-mono text-lg font-semibold text-foreground">{value}</div>
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-cyan-400/20 bg-cyan-400/5 px-3 py-2 text-xs text-cyan-100">
        Read-only readiness only. Bran owns source-pack custody; Codex owns checkout execution. Mission Control cannot checkout, assign, or mutate a pack.
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[58rem] text-left text-xs">
          <thead className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr><th className="px-3 py-2">Pack</th><th className="px-3 py-2">Ready ref</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Custody</th><th className="px-3 py-2">Freshness</th><th className="px-3 py-2">Digest</th><th className="px-3 py-2">Last checkout</th><th className="px-3 py-2">Blocker</th></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {branReadiness.packs.map(pack => (
              <tr key={pack.latestRef}>
                <td className="px-3 py-2 text-foreground"><div className="font-semibold">{pack.title}</div><div className="font-mono text-[10px] text-muted-foreground">{pack.latestRef} · {pack.versionCount} versions</div></td>
                <td className="px-3 py-2 font-mono text-foreground">{pack.readyRef ?? '—'}</td>
                <td className="px-3 py-2">
                  <StateBadge state={pack.status === 'assigned' ? 'active' : pack.status} />
                </td>
                <td className="px-3 py-2 text-foreground">{pack.custodyState}</td>
                <td className="px-3 py-2 text-foreground">{pack.freshnessPolicy ?? 'unknown'} · {formatAge(pack.ageSecs)}</td>
                <td className="px-3 py-2 font-mono text-foreground">{pack.contentDigest ? `${pack.contentDigest.slice(0, 15)}…` : '—'}</td>
                <td className="px-3 py-2 text-foreground">{formatTimestamp(pack.lastCheckoutAt)}{pack.lastCheckoutAgent ? ` · ${pack.lastCheckoutAgent}` : ''}</td>
                <td className="px-3 py-2 text-foreground">{pack.blockingCodes.join(' · ').replaceAll('_', ' ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function CockpitDrillIn({
  fleet,
  diagnostics,
  branReadiness,
  detail,
  onSelect,
  onClose,
}: CockpitProps & {
  detail: CockpitDetail
  onSelect: (detail: CockpitDetail) => void
  onClose: () => void
}) {
  return (
    <section
      id="lugos-cockpit-details"
      className="scroll-mt-4 rounded-xl border border-cyan-400/20 bg-card/90"
      aria-labelledby="cockpit-detail-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-3">
        <div>
          <div className="text-[9px] font-semibold uppercase tracking-[0.24em] text-cyan-400">
            Bounded evidence
          </div>
          <h2 id="cockpit-detail-heading" className="mt-1 text-xs font-semibold text-foreground">
            {detail === 'fleet' ? 'Fleet and handoffs' : detail === 'diagnostics' ? 'Diagnostics' : 'Bran source packs'}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Cockpit details">
          {([
            ['fleet', 'Fleet'],
            ['diagnostics', 'Diagnostics'],
            ['bran', 'Source packs'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={detail === id}
              className={`rounded-md border px-2.5 py-1 text-[10px] font-medium ${detail === id ? 'border-cyan-400/50 bg-cyan-400/10 text-cyan-200' : 'border-border text-muted-foreground hover:text-foreground'}`}
              onClick={() => onSelect(id)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            className="ml-1 rounded-md border border-border px-2.5 py-1 text-[10px] text-muted-foreground hover:text-foreground"
            aria-label="Close cockpit details"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
      <div className="p-3 sm:p-4">
        {detail === 'fleet' && <FleetDetail fleet={fleet} />}
        {detail === 'diagnostics' && <DiagnosticsDetail diagnostics={diagnostics} />}
        {detail === 'bran' && <BranDetail branReadiness={branReadiness} />}
      </div>
    </section>
  )
}
