const hash = `sha256:${'a'.repeat(64)}`
const claim = (name: string, value: unknown, verification = 'deterministic') => ({
  id: `claim-${name}`, claim: name, value, verification, source_type: 'run', source_id: 'run-proof',
})

// UI fixture only; integrity acceptance is exercised against the real OGMI reader.
export const OGMI_VIEW = {
  schema: 'ogmi.verified-projection/v1', verified_at: '2026-10-25T22:00:00Z',
  snapshot: {
    document_type: 'ogmi.projection-snapshot', schema_version: '0.1',
    snapshot_id: `projection-snapshot-${'a'.repeat(64)}`, semantic_digest: hash,
    generated_at: '2026-10-25T21:00:00Z', run_id: 'run-proof', project: 'integration-proof',
    authority_manifest: { identifier: 'integration-proof', hash },
    built_in_claims: [claim('completed-gates', ['implementation']), claim('pending-gates', ['operator-use']), claim('run-status', 'active')],
    project_claims: [claim('estimate', '100% complete', 'reported')],
    source_manifest: [{ record_type: 'run', id: 'run-proof', path: 'run.json', content_hash: hash, semantic_hash: hash }],
    conflicts: [], unknowns: [{ claim_id: 'claim-estimate', verification: 'reported', reason: 'Human acceptance has not been recorded' }],
    provenance: { actor: 'codex', assignment_id: 'assignment-proof' },
  },
  artifact_ref: { id: 'projection-artifact', path: 'projections/run.json', hash },
}
