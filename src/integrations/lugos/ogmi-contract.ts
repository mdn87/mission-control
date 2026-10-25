import { z } from 'zod'

const text = z.string().min(1).max(4096)
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const timestamp = z.string().datetime({ offset: true })
const claim = z.object({
  id: text, claim: text, value: z.json(),
  verification: z.enum(['deterministic', 'attested', 'reported']),
  source_type: text, source_id: text,
})

// A bounded display subset of the canonical OGMI document. The server invokes
// OGMI's full verifier first; parsing this subset alone is NOT verification.
export const ogmiViewSchema = z.object({
  schema: z.literal('ogmi.verified-projection/v1'), verified_at: timestamp,
  snapshot: z.object({
    document_type: z.literal('ogmi.projection-snapshot'), schema_version: z.literal('0.1'),
    snapshot_id: z.string().regex(/^projection-snapshot-[a-f0-9]{64}$/),
    semantic_digest: hash, generated_at: timestamp, project: text, run_id: text,
    authority_manifest: z.object({ identifier: text, hash }),
    built_in_claims: z.array(claim).max(2048), project_claims: z.array(claim).max(2048),
    source_manifest: z.array(z.object({
      record_type: text, id: text, path: text, content_hash: hash, semantic_hash: hash,
    })).max(4096),
    conflicts: z.array(z.object({ id: text, severity: text, summary: text })).max(1024),
    unknowns: z.array(z.object({ claim_id: text, verification: text, reason: text })).max(2048),
    provenance: z.object({ actor: text, assignment_id: text }),
  }),
  artifact_ref: z.object({ id: text, path: text, hash }),
}).strict()

export type OgmiView = z.infer<typeof ogmiViewSchema>

export function ogmiRunSummary(view: OgmiView) {
  const claims = view.snapshot.built_in_claims
  const value = (name: string) => claims.find(item => item.claim === name)?.value
  const completed = z.array(z.string()).parse(value('completed-gates'))
  const pending = z.array(z.string()).parse(value('pending-gates'))
  const reviews = claims.filter(item => item.claim === 'independent-review-passed')
  return {
    completed, pending, status: z.string().parse(value('run-status')),
    review: reviews.length === 0 ? 'No review verdict recorded'
      : reviews.every(item => item.value === true) ? 'Recorded review gates passed' : 'Recorded review gate not satisfied',
  }
}
