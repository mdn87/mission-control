import { z } from 'zod'

export const OPERATOR_SNAPSHOT_SCHEMA = 'lugos-operator-snapshot/v1'
export const OPERATOR_EVENT_SCHEMA = 'lugos-operator-event/v1'
export const OPERATOR_RECEIPT_SCHEMA = 'lugos-operator-receipt/v1'
export const OPERATOR_COMMAND_SCHEMA = 'lugos-operator-command/v1'
export const AUTOWORK_SNAPSHOT_SCHEMA = 'lugos-hud-autowork/v1'
export const AUTOWORK_DELTA_SCHEMA = 'lugos-hud-autowork-delta/v1'

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/)
const timestamp = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
).refine(value => Number.isFinite(Date.parse(value)), 'Invalid UTC timestamp')
const nonnegativeInteger = z.number().int().nonnegative()
const nullableInteger = nonnegativeInteger.nullable()

const phases = [
  'classify',
  'assign',
  'attest',
  'dispatch',
  'work',
  'review',
  'verify',
  'outcome',
] as const

const phaseState = z.enum([
  'pending',
  'active',
  'succeeded',
  'warning',
  'blocked',
  'failed',
  'skipped',
  'unknown',
])

const phasesSchema = z.object(
  Object.fromEntries(phases.map(phase => [phase, phaseState])) as Record<
    (typeof phases)[number],
    typeof phaseState
  >,
).strict()

const terminalSchema = z.object({
  duration_ms: nullableInteger,
  input_tokens: nullableInteger,
  output_tokens: nullableInteger,
  tool_denials: nullableInteger,
  verification_attempts: nullableInteger,
  first_pass_verified: z.boolean().nullable(),
  fallback_used: z.boolean().nullable(),
}).strict()

export const autoworkRunSchema = z.object({
  run_id: identifier,
  repo: identifier,
  source_host: z.string().max(128),
  agent_address: z.string().max(128),
  route: z.string().max(128),
  model: z.string().max(128),
  effort: z.string().max(128),
  current_phase: z.string().max(32),
  phases: phasesSchema,
  elapsed_ms: nullableInteger,
  liveness: z.object({
    state: z.enum(['active', 'stale', 'unknown']),
    age_secs: nullableInteger,
  }).strict(),
  attention: z.array(z.string().max(64)).max(8),
  evidence: z.array(z.object({
    kind: z.string().min(1).max(64),
    label: z.string().min(1).max(80),
  }).strict()).max(8),
  terminal: terminalSchema,
  outcome: z.string().max(32),
  landing: z.string().max(32),
}).strict()

const outcomeCountsSchema = z.object({
  accepted: nonnegativeInteger,
  partial: nonnegativeInteger,
  rejected: nonnegativeInteger,
  incomplete: nonnegativeInteger,
  fallback_used: nonnegativeInteger,
}).strict()

const phaseDurationsSchema = z.object(
  Object.fromEntries(phases.map(phase => [phase, nullableInteger])) as Record<
    (typeof phases)[number],
    typeof nullableInteger
  >,
).strict()

const autoworkProjectionShape = {
  generatedAt: timestamp,
  cursor: identifier.nullable(),
  source: z.object({
    host: identifier,
    state: z.enum(['ready', 'degraded']),
    lastReceiptAt: timestamp.nullable(),
    diagnostics: z.array(z.string().min(1).max(64)).max(16),
  }).strict(),
  summary: z.object({
    active: nonnegativeInteger,
    attention: nonnegativeInteger,
    terminal24h: nonnegativeInteger,
    accepted24h: nonnegativeInteger,
    firstPassVerified24h: nonnegativeInteger,
  }).strict(),
  analytics: z.object({
    window_hours: nonnegativeInteger,
    bucket_minutes: nonnegativeInteger,
    outcomes: outcomeCountsSchema,
    outcome_buckets: z.array(z.object({
      offset: nonnegativeInteger,
      accepted: nonnegativeInteger,
      partial: nonnegativeInteger,
      rejected: nonnegativeInteger,
    }).strict()).length(12),
    phase_duration_ms: phaseDurationsSchema,
  }).strict(),
  runs: z.array(autoworkRunSchema).max(256),
}

export const autoworkSnapshotSchema = z.object({
  schema: z.literal(AUTOWORK_SNAPSHOT_SCHEMA),
  ...autoworkProjectionShape,
}).strict()

export const autoworkDeltaSchema = z.object({
  schema: z.literal(AUTOWORK_DELTA_SCHEMA),
  ...autoworkProjectionShape,
}).strict()

export const operatorReceiptSchema = z.object({
  schema: z.literal(OPERATOR_RECEIPT_SCHEMA),
  receipt_id: identifier,
  type: z.string().min(1).max(64).regex(/^[a-z][a-z0-9.-]*$/),
  idempotency_key: identifier,
  status: z.literal('accepted'),
  accepted_at: timestamp,
}).strict()

export const operatorSnapshotSchema = z.object({
  schema: z.literal(OPERATOR_SNAPSHOT_SCHEMA),
  generatedAt: timestamp,
  cursor: identifier.nullable(),
  projections: z.array(z.object({
    name: z.literal('autowork'),
    value: autoworkSnapshotSchema,
  }).strict()).max(1),
  receipts: z.array(operatorReceiptSchema).max(1024),
}).strict()

const operatorEventBase = {
  schema: z.literal(OPERATOR_EVENT_SCHEMA),
  cursor: identifier,
}

export const operatorEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...operatorEventBase,
    type: z.literal('projection.snapshot'),
    projection: z.literal('autowork'),
    value: autoworkSnapshotSchema,
    receipt: z.null(),
  }).strict(),
  z.object({
    ...operatorEventBase,
    type: z.literal('projection.delta'),
    projection: z.literal('autowork'),
    value: autoworkDeltaSchema,
    receipt: z.null(),
  }).strict(),
  z.object({
    ...operatorEventBase,
    type: z.literal('command.receipt'),
    projection: z.null(),
    value: z.null(),
    receipt: operatorReceiptSchema,
  }).strict(),
])

export const approvalRequestCommandSchema = z.object({
  schema: z.literal(OPERATOR_COMMAND_SCHEMA),
  type: z.literal('approval.request'),
  idempotency_key: identifier,
  payload: z.object({
    subject: z.string().trim().min(1).max(128),
    summary: z.string().trim().min(1).max(1000),
  }).strict(),
}).strict()

export const operatorCursorSchema = identifier

export type AutoworkProjection = z.infer<typeof autoworkSnapshotSchema>
export type AutoworkDelta = z.infer<typeof autoworkDeltaSchema>
export type AutoworkRun = z.infer<typeof autoworkRunSchema>
export type OperatorSnapshot = z.infer<typeof operatorSnapshotSchema>
export type OperatorEvent = z.infer<typeof operatorEventSchema>
export type OperatorReceipt = z.infer<typeof operatorReceiptSchema>
export type ApprovalRequestCommand = z.infer<typeof approvalRequestCommandSchema>
