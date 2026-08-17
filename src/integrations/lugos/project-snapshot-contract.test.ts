import { describe, expect, it } from 'vitest'
import {
  DIGEST_C,
  PROJECT_SNAPSHOT_VIEW,
} from './__tests__/project-snapshot-view.fixture'
import { projectSnapshotViewSchema } from './project-snapshot-contract'

describe('projectSnapshotViewSchema', () => {
  it('accepts the TORC trusted read envelope and preserves rendered collections', () => {
    const parsed = projectSnapshotViewSchema.parse(PROJECT_SNAPSHOT_VIEW)

    expect(parsed.trusted).toBe(true)
    expect(parsed.artifact.projects[0].name).toBe('TORC')
    expect(parsed.receipt.checks[0].status).toBe('passed')
    expect(parsed.evidence_bundle.sources[0].path).toBe('STATUS.md')
  })

  it('rejects an envelope that is untrusted or cross-record inconsistent', () => {
    expect(
      projectSnapshotViewSchema.safeParse({ ...PROJECT_SNAPSHOT_VIEW, trusted: false }).success,
    ).toBe(false)
    expect(
      projectSnapshotViewSchema.safeParse({
        ...PROJECT_SNAPSHOT_VIEW,
        receipt: { ...PROJECT_SNAPSHOT_VIEW.receipt, artifact_id: DIGEST_C },
      }).success,
    ).toBe(false)
  })
})
