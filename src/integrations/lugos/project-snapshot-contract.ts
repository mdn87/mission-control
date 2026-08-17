import { z } from 'zod'

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const evidenceRefSchema = z.object({ source_id: z.string() }).passthrough()

const progressSchema = z
  .object({
    kind: z.string(),
    label: z.string(),
    completed: z.number().int().optional(),
    total: z.number().int().optional(),
    percentage: z.number().optional(),
    source_id: z.string().optional(),
  })
  .passthrough()

const projectSchema = z
  .object({
    project_id: z.string(),
    name: z.string(),
    status: z.string(),
    repositories: z.array(z.string()),
    progress: z.array(progressSchema),
  })
  .passthrough()

const claimSchema = z
  .object({
    claim_id: z.string(),
    subject: z.string(),
    predicate: z.string(),
    value: z.unknown(),
    status: z.enum(['verified', 'asserted', 'conflicted', 'unknown']),
    evidence: z.array(evidenceRefSchema),
    observed_at: z.string(),
  })
  .passthrough()

const summaryRecordSchema = z
  .object({
    summary: z.string(),
    status: z.string().optional(),
    evidence: z.array(evidenceRefSchema),
  })
  .passthrough()

const snapshotSchema = z
  .object({
    schema: z.literal('urn:lugos:artifact:project-snapshot:v1alpha1'),
    artifact_id: digestSchema,
    kind: z.literal('project-snapshot'),
    generated_at: z.string(),
    scope: z.object({
      name: z.string(),
      repositories: z.array(
        z.object({ repository: z.string(), commit: z.string() }).passthrough(),
      ),
    }),
    generator: z
      .object({
        implementation: z.string(),
        version: z.string(),
        provider: z.string().optional(),
        model: z.string().optional(),
      })
      .passthrough(),
    evidence_bundle: z.object({ bundle_id: digestSchema }),
    projects: z.array(projectSchema),
    claims: z.array(claimSchema),
    blockers: z.array(summaryRecordSchema),
    pending_decisions: z.array(summaryRecordSchema),
    recent_activity: z.array(
      summaryRecordSchema.extend({ occurred_at: z.string() }).passthrough(),
    ),
    conflicts: z.array(summaryRecordSchema),
    unknowns: z.array(summaryRecordSchema),
    metadata: z.record(z.string(), z.unknown()),
  })
  .passthrough()

const evidenceBundleSchema = z
  .object({
    schema: z.literal('urn:lugos:artifact:evidence-bundle:v1alpha1'),
    bundle_id: digestSchema,
    collected_at: z.string(),
    collector: z.object({ name: z.string(), version: z.string() }).passthrough(),
    scope: z.object({ repositories: z.array(z.unknown()) }).passthrough(),
    sources: z.array(
      z
        .object({
          source_id: z.string(),
          repository: z.string(),
          commit: z.string(),
          path: z.string(),
        })
        .passthrough(),
    ),
    git_state: z.array(z.unknown()),
    warnings: z.array(z.string()),
  })
  .passthrough()

const receiptSchema = z
  .object({
    schema: z.literal('urn:lugos:artifact:acceptance-receipt:v1alpha1'),
    receipt_id: digestSchema,
    artifact_id: digestSchema,
    evidence_bundle_id: digestSchema,
    validated_at: z.string(),
    validator: z.object({ name: z.string(), version: z.string() }).passthrough(),
    status: z.literal('accepted'),
    checks: z.array(
      z
        .object({ name: z.string(), status: z.literal('passed'), detail: z.string() })
        .passthrough(),
    ),
    warnings: z.array(z.string()),
    errors: z.array(z.string()).max(0),
  })
  .passthrough()

/**
 * Fields rendered by Mission Control from TORC's fail-closed derived view.
 * TORC owns content hashing and validation; this consumer checks only its
 * transport contract and cross-record references.
 */
export const projectSnapshotViewSchema = z
  .object({
    report_kind: z.literal('project_snapshot_view'),
    derived: z.literal(true),
    canonical: z.literal(false),
    trusted: z.literal(true),
    artifact: snapshotSchema,
    evidence_bundle: evidenceBundleSchema,
    receipt: receiptSchema,
  })
  .passthrough()
  .superRefine((view, context) => {
    if (view.receipt.artifact_id !== view.artifact.artifact_id) {
      context.addIssue({ code: 'custom', message: 'receipt artifact identity mismatch' })
    }
    if (
      view.receipt.evidence_bundle_id !== view.evidence_bundle.bundle_id ||
      view.artifact.evidence_bundle.bundle_id !== view.evidence_bundle.bundle_id
    ) {
      context.addIssue({ code: 'custom', message: 'Evidence Bundle identity mismatch' })
    }
  })

export type ProjectSnapshotView = z.infer<typeof projectSnapshotViewSchema>
