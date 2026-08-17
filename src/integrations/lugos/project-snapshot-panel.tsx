'use client'

import { useEffect, useState } from 'react'
import { ApiError, apiFetch } from '@/lib/api-client'
import {
  projectSnapshotViewSchema,
  type ProjectSnapshotView,
} from './project-snapshot-contract'

function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: string }) {
  const colors =
    tone === 'good'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
      : tone === 'warn'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
        : 'border-border bg-secondary text-muted-foreground'
  return <span className={`inline-flex rounded border px-2 py-0.5 text-[11px] font-medium ${colors}`}>{children}</span>
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function SummarySection({
  title,
  entries,
}: {
  title: string
  entries: Array<{ summary: string; status?: string }>
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      {entries.length ? (
        <ul className="space-y-2">
          {entries.map((entry, index) => (
            <li key={`${title}-${index}`} className="rounded border border-border p-3 text-sm">
              {entry.status ? <Badge>{entry.status}</Badge> : null}
              <span className={entry.status ? 'ml-2' : ''}>{entry.summary}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">None recorded.</p>
      )}
    </section>
  )
}

function SnapshotContent({ view }: { view: ProjectSnapshotView }) {
  const { artifact, evidence_bundle: evidenceBundle, receipt } = view
  const warnings = [...evidenceBundle.warnings, ...receipt.warnings]
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{artifact.scope.name}</h1>
          <Badge tone="good">accepted</Badge>
          <Badge>derived</Badge>
          <Badge>read-only</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Generated {new Date(artifact.generated_at).toLocaleString()} by{' '}
          {artifact.generator.implementation} {artifact.generator.version}
        </p>
        <code className="block break-all text-[11px] text-muted-foreground">
          {artifact.artifact_id}
        </code>
      </header>

      {warnings.length ? (
        <section className="rounded border border-amber-500/30 bg-amber-500/10 p-3">
          <h2 className="text-sm font-semibold text-amber-400">Warnings</h2>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {warnings.map((warning, index) => (
              <li key={`${warning}-${index}`}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Projects</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {artifact.projects.map((project) => (
            <article key={project.project_id} className="rounded border border-border p-3">
              <div className="flex items-center gap-2">
                <h3 className="font-medium">{project.name}</h3>
                <Badge>{project.status}</Badge>
              </div>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                {project.progress.map((progress, index) => (
                  <li key={`${project.project_id}-${index}`}>{progress.label}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Claims</h2>
        <ul className="space-y-2">
          {artifact.claims.map((claim) => (
            <li key={claim.claim_id} className="rounded border border-border p-3 text-sm">
              <Badge tone={claim.status === 'verified' ? 'good' : 'warn'}>{claim.status}</Badge>
              <span className="ml-2 text-muted-foreground">{claim.subject} · {claim.predicate}</span>
              <p className="mt-1">{valueText(claim.value)}</p>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <SummarySection title="Blockers" entries={artifact.blockers} />
        <SummarySection title="Pending decisions" entries={artifact.pending_decisions} />
        <SummarySection title="Recent activity" entries={artifact.recent_activity} />
        <SummarySection title="Conflicts" entries={artifact.conflicts} />
        <SummarySection title="Unknowns" entries={artifact.unknowns} />
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Acceptance receipt</h2>
        <p className="text-xs text-muted-foreground">
          {receipt.validator.name} {receipt.validator.version} · {receipt.validated_at}
        </p>
        <ul className="space-y-1">
          {receipt.checks.map((check) => (
            <li key={check.name} className="flex flex-wrap items-center gap-2 rounded border border-border px-3 py-2 text-sm">
              <Badge tone="good">passed</Badge>
              <code>{check.name}</code>
              <span className="text-muted-foreground">{check.detail}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Evidence sources</h2>
        <ul className="space-y-1 text-sm">
          {evidenceBundle.sources.map((source) => (
            <li key={source.source_id} className="rounded border border-border px-3 py-2">
              <code>{source.source_id}</code>
              <span className="ml-2 text-muted-foreground">{source.repository} · {source.path}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

export function ProjectSnapshotPanel() {
  const [view, setView] = useState<ProjectSnapshotView | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void apiFetch('/api/lugos/project-snapshot')
      .then((body) => {
        if (!active) return
        const parsed = projectSnapshotViewSchema.safeParse(body)
        if (!parsed.success) {
          setError('TORC returned an unrecognized snapshot payload')
          return
        }
        setView(parsed.data)
      })
      .catch((caught) => {
        if (!active) return
        setError(caught instanceof ApiError ? caught.message : 'TORC project snapshot unavailable')
      })
    return () => {
      active = false
    }
  }, [])

  if (error) return <p className="text-sm text-red-400">{error}</p>
  if (!view) return <p className="text-sm text-muted-foreground">Loading project snapshot…</p>
  return <SnapshotContent view={view} />
}
