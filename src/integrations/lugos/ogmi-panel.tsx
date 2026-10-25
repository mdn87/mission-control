'use client'

import { useEffect, useState } from 'react'
import { apiFetch } from '@/lib/api-client'
import { ogmiRunSummary, ogmiViewSchema, type OgmiView } from './ogmi-contract'

function Evidence({ view }: { view: OgmiView }) {
  const { snapshot, artifact_ref: artifact } = view
  const summary = ogmiRunSummary(view)
  return <div className="space-y-5">
    <div className="rounded border border-border bg-card p-4 space-y-2">
      <h2 className="text-lg font-semibold">{snapshot.project}</h2>
      <p>{snapshot.run_id}</p>
      <p>{summary.completed.length} of {summary.completed.length + summary.pending.length} gates complete</p>
      <p>Recorded run status: {summary.status}</p>
      <p>{summary.review}</p>
      <p className="text-xs text-muted-foreground">Generated {snapshot.generated_at} · Verified {view.verified_at}</p>
      <p className="text-xs text-muted-foreground">Snapshot and source records verified against the configured project. This is point-in-time evidence, not live monitoring or an independent acceptance decision.</p>
    </div>
    <div className="grid gap-4 md:grid-cols-2">
      <section><h2 className="font-semibold">Completed gates</h2><ul>{summary.completed.map(gate => <li key={gate}>{gate}</li>)}</ul></section>
      <section><h2 className="font-semibold">Pending gates</h2><ul>{summary.pending.map(gate => <li key={gate}>{gate}</li>)}</ul></section>
    </div>
    <section><h2 className="font-semibold">Project claims</h2>
      <p className="text-xs text-muted-foreground">These retain their reported verification mode and do not determine gate completion.</p>
      {snapshot.project_claims.length === 0 && <p>None recorded.</p>}
      {snapshot.project_claims.map(claim => <article key={claim.id} className="border-b border-border py-2">
        <p>{claim.claim} · <span>{claim.verification}</span></p>
        <p>{typeof claim.value === 'string' ? claim.value : JSON.stringify(claim.value)}</p>
        <p className="text-xs text-muted-foreground">Source: {claim.source_type} / {claim.source_id}</p>
      </article>)}
    </section>
    <section><h2 className="font-semibold">Conflicts and unknowns</h2>
      {!snapshot.conflicts.length && !snapshot.unknowns.length && <p>None recorded.</p>}
      {snapshot.conflicts.map(item => <p key={item.id}>{item.severity}: {item.summary}</p>)}
      {snapshot.unknowns.map(item => <p key={item.claim_id}>{item.reason}</p>)}
    </section>
    <details><summary>Evidence identity and sources</summary>
      <div className="space-y-2 break-all text-xs py-3">
        <p>Producer: {snapshot.provenance.actor} / {snapshot.provenance.assignment_id}</p>
        <p>Authority: {snapshot.authority_manifest.identifier} · {snapshot.authority_manifest.hash}</p>
        <p>Semantic digest: {snapshot.semantic_digest}</p>
        <p>Snapshot artifact: {artifact.path} · {artifact.hash}</p>
        <p>Artifact references identify evidence; verification does not fetch arbitrary external artifact targets.</p>
        {snapshot.source_manifest.map(source => <p key={`${source.record_type}:${source.id}`}>{source.record_type}: {source.id} · {source.path} · {source.content_hash}</p>)}
      </div>
    </details>
  </div>
}

export function OgmiPanel() {
  const [view, setView] = useState<OgmiView | null>(null)
  const [error, setError] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    setView(null); setError(false)
    void apiFetch('/api/lugos/ogmi').then(value => {
      const parsed = ogmiViewSchema.parse(value)
      ogmiRunSummary(parsed)
      if (active) setView(parsed)
    }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [refresh])
  return <div className="mx-auto max-w-5xl p-6 space-y-5">
    <header className="flex items-center justify-between gap-4">
      <div><h1 className="text-xl font-semibold">OGMI evidence</h1><p className="text-sm text-muted-foreground">Read-only run evidence from the durable workgraph.</p></div>
      <button className="rounded border border-border px-3 py-2 text-sm" onClick={() => setRefresh(value => value + 1)}>Refresh evidence</button>
    </header>
    {error ? <p role="alert">Evidence unavailable. Configure the OGMI project and snapshot on the server, or regenerate the snapshot after its source records change. No unverified evidence is displayed.</p>
      : view ? <Evidence view={view} /> : <p role="status">Verifying evidence…</p>}
  </div>
}
