import { z } from 'zod'

/**
 * Read-only contract for the TORC lineage explanation (operator-view.schema.json).
 *
 * TORC owns lineage provenance. Mission Control renders this payload and must
 * never recompute authority, resolve opaque references, or repair an untrusted
 * explanation. Nested detail is intentionally passed through unvalidated so
 * TORC can extend its own record shapes without breaking this consumer; only
 * the fields the panel actually reasons about are pinned here.
 */

const authorityRef = z
  .object({
    activation_id: z.string().nullable().optional(),
    substrate_id: z.string().nullable().optional(),
    substrate_label: z.string().nullable().optional(),
    lease_id: z.string().nullable().optional(),
    activation_current_state: z.string().nullable().optional(),
    lease_current_status: z.string().nullable().optional(),
  })
  .passthrough()

const authorityChange = z
  .object({
    sequence: z.number(),
    kind: z.string(),
    summary: z.string(),
    occurred_at: z.string(),
    transition_id: z.string().nullable().optional(),
    from_authority: authorityRef.nullable().optional(),
    to_authority: authorityRef.nullable().optional(),
  })
  .passthrough()

/**
 * Field names mirror TORC's operator-view records exactly.
 *
 * `state` is the handoff lifecycle (prepared / accepted / rejected / stale) and
 * `authority_effect` is what it actually did ("transferred" or not). They are
 * deliberately separate: a handoff can exist, and even be resolved, without
 * transferring authority.
 */
const handoff = z
  .object({
    handoff_id: z.string(),
    state: z.string(),
    authority_effect: z.string(),
    reason_code: z.string().nullable().optional(),
  })
  .passthrough()

const continuityEvent = z
  .object({
    event_type: z.string(),
    summary: z.string(),
    authority_changed: z.boolean().optional(),
  })
  .passthrough()

export const lineageExplanationSchema = z
  .object({
    report_kind: z.literal('lineage_explanation'),
    derived: z.literal(true),
    canonical: z.literal(false),
    trusted: z.boolean(),
    explanation_complete: z.boolean(),
    warnings: z.array(z.string()),
    lineage: z.object({ lineage_id: z.string() }).passthrough(),
    current_authority: z.unknown().optional(),
    authority_changes: z.array(authorityChange).default([]),
    handoffs: z.array(handoff).default([]),
    continuity_events: z.array(continuityEvent).default([]),
    fit_decisions: z.array(z.unknown()).default([]),
    relationships: z.unknown().optional(),
    verification: z.unknown().optional(),
  })
  .passthrough()

export type LineageExplanation = z.infer<typeof lineageExplanationSchema>

/** A lineage id is an opaque TORC identifier, never a path fragment. */
export const lineageIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._-]+$/, 'Invalid lineage identifier')

export const lineageRequestSchema = z.object({
  lineage: lineageIdSchema,
  stateDir: z.string().min(1).max(4096),
})

export type LineageRequest = z.infer<typeof lineageRequestSchema>

/**
 * Stubbed lineage index.
 *
 * TORC's P4 read contract explains one lineage at a time and has no command to
 * enumerate them. Mission Control must not fill that gap by opening the TORC
 * SQLite store itself — that would make this a second authority surface. Until
 * TORC publishes a real list contract, the index is operator-configured and
 * flagged `stub: true` so the UI can say so plainly.
 */
export const lineageSummarySchema = z.object({
  lineage: lineageIdSchema,
  stateDir: z.string().min(1).max(4096),
  label: z.string().max(120).optional(),
})

export const lineageIndexSchema = z.object({
  stub: z.literal(true),
  lineages: z.array(lineageSummarySchema),
})

export type LineageSummary = z.infer<typeof lineageSummarySchema>
export type LineageIndex = z.infer<typeof lineageIndexSchema>
