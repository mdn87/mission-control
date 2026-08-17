export const DIGEST_A = `sha256:${'a'.repeat(64)}`
export const DIGEST_B = `sha256:${'b'.repeat(64)}`
export const DIGEST_C = `sha256:${'c'.repeat(64)}`

export const PROJECT_SNAPSHOT_VIEW = {
  report_kind: 'project_snapshot_view',
  derived: true,
  canonical: false,
  trusted: true,
  artifact: {
    schema: 'urn:lugos:artifact:project-snapshot:v1alpha1',
    artifact_id: DIGEST_A,
    kind: 'project-snapshot',
    generated_at: '2026-08-16T12:00:00Z',
    scope: {
      name: 'Lugos snapshot',
      repositories: [{ repository: 'local/torc', commit: '2'.repeat(40) }],
    },
    generator: { implementation: 'scribe-command', version: '1', provider: 'local' },
    evidence_bundle: { bundle_id: DIGEST_B },
    projects: [
      {
        project_id: 'torc',
        name: 'TORC',
        status: 'active',
        repositories: ['local/torc'],
        progress: [{ kind: 'checks', label: 'Snapshot validation passed' }],
      },
    ],
    claims: [
      {
        claim_id: 'ready',
        subject: 'torc',
        predicate: 'status',
        value: 'consumer-ready',
        status: 'verified',
        evidence: [{ source_id: 'status' }],
        observed_at: '2026-08-16T12:00:00Z',
      },
    ],
    blockers: [{ blocker_id: 'b1', summary: 'No open blocker', status: 'resolved', evidence: [] }],
    pending_decisions: [{ decision_id: 'd1', summary: 'Choose refresh cadence', status: 'pending', evidence: [] }],
    recent_activity: [{ activity_id: 'a1', summary: 'Accepted snapshot', occurred_at: '2026-08-16T12:00:00Z', evidence: [] }],
    conflicts: [{ conflict_id: 'c1', summary: 'Status sources disagree', claim_ids: ['ready'], evidence: [] }],
    unknowns: [{ unknown_id: 'u1', summary: 'Windows smoke not run', evidence: [] }],
    metadata: {},
  },
  evidence_bundle: {
    schema: 'urn:lugos:artifact:evidence-bundle:v1alpha1',
    bundle_id: DIGEST_B,
    collected_at: '2026-08-16T12:00:00Z',
    collector: { name: 'torc', version: '0.1.0' },
    scope: { repositories: [{ repository: 'local/torc', commit: '2'.repeat(40), branch: 'main' }] },
    sources: [{ source_id: 'status', repository: 'local/torc', commit: '2'.repeat(40), path: 'STATUS.md' }],
    git_state: [],
    warnings: [],
  },
  receipt: {
    schema: 'urn:lugos:artifact:acceptance-receipt:v1alpha1',
    receipt_id: DIGEST_C,
    artifact_id: DIGEST_A,
    evidence_bundle_id: DIGEST_B,
    validated_at: '2026-08-16T12:00:01Z',
    validator: { name: 'torc', version: '0.1.0' },
    status: 'accepted',
    checks: [{ name: 'schema_validity', status: 'passed', detail: 'valid' }],
    warnings: [],
    errors: [],
  },
} as const
