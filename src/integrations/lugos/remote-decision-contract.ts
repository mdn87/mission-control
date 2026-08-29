import { createHash } from 'node:crypto'
import { z } from 'zod'

export const REMOTE_DECISION_REQUEST_SCHEMA = 'mc.remote-decision-request/v1'
export const REMOTE_DECISION_CAPSULE_SCHEMA = 'weir.remote-decision-capsule/v1'
export const REMOTE_DECISION_ACK_SCHEMA = 'weir.remote-decision-ack/v1'
export const REMOTE_DECISION_QUEUE_STATE_SCHEMA = 'weir.remote-decision-queue-state/v1'
export const REMOTE_DECISION_REVOCATION_SCHEMA = 'weir.remote-decision-revocation/v1'
export const REMOTE_DECISION_AUDIT_SCHEMA = 'weir.remote-decision-audit/v1'
export const MAX_REMOTE_DECISION_CAPSULE_BYTES = 8 * 1024
export const MAX_REMOTE_DECISION_LIFETIME_SECONDS = 120
export const MAX_REMOTE_DECISION_LIVE_ENTRIES = 1024

const identifier = z.string().min(1).max(128)
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const timestamp = z.string().datetime({ offset: true })
const remoteOutcome = z.enum([
  'completed',
  'failed',
  'blocked',
  'cancelled',
  'outcome_unknown',
  'denied',
  'expired',
  'revoked',
])
const effectOutcomes = new Set([
  'completed',
  'failed',
  'blocked',
  'cancelled',
  'outcome_unknown',
])
export const remoteQueueState = z.enum([
  'queued',
  'claimed',
  'acknowledged',
  'denied',
  'expired',
  'revoked',
])

export const remoteDecisionRequestSchema = z.object({
  schema: z.literal(REMOTE_DECISION_REQUEST_SCHEMA),
  idempotency_key: identifier,
  decision: z.enum(['approve', 'deny']),
  proposal_hash: digest,
  action_id: identifier,
  work_context_hash: digest,
  device_id: identifier,
}).strict()

export const remoteRelayEnqueueSchema = z.object({
  command_id: identifier,
  actor_id: identifier,
  audience: z.literal('fade-weir-remote-decision'),
  device_id: identifier,
  decision: z.enum(['approve', 'deny']),
  proposal_hash: digest,
  action_id: identifier,
  work_context_hash: digest,
  step_up_ref: digest,
}).strict()

export const remoteDecisionCapsuleSchema = z.object({
  schema: z.literal(REMOTE_DECISION_CAPSULE_SCHEMA),
  key_id: identifier,
  issuer_id: identifier,
  capsule_id: identifier,
  command_id: identifier,
  actor_id: identifier,
  audience: identifier,
  device_id: identifier,
  decision: z.enum(['approve', 'deny']),
  proposal_hash: digest,
  action_id: identifier,
  work_context_hash: digest,
  issued_at: timestamp,
  expires_at: timestamp,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  step_up_ref: digest,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict().superRefine((capsule, context) => {
  const issuedAt = Date.parse(capsule.issued_at)
  const expiresAt = Date.parse(capsule.expires_at)
  if (expiresAt <= issuedAt) {
    context.addIssue({ code: 'custom', message: 'Remote capsule expiry is invalid' })
  }
  if (expiresAt - issuedAt > MAX_REMOTE_DECISION_LIFETIME_SECONDS * 1000) {
    context.addIssue({ code: 'custom', message: 'Remote capsule lifetime is too long' })
  }
  if (Buffer.byteLength(canonicalJson(capsule), 'utf8') > MAX_REMOTE_DECISION_CAPSULE_BYTES) {
    context.addIssue({ code: 'custom', message: 'Remote capsule is too large' })
  }
})

export const remoteDecisionAcknowledgementSchema = z.object({
  schema: z.literal(REMOTE_DECISION_ACK_SCHEMA),
  acknowledgement_id: identifier,
  capsule_id: identifier,
  command_id: identifier,
  actor_id: identifier,
  device_id: identifier,
  transport_principal: identifier,
  outcome: remoteOutcome,
  receipt_hash: digest.nullable(),
  acknowledged_at: timestamp,
  acknowledgement_hash: digest,
}).strict().superRefine((acknowledgement, context) => {
  if (acknowledgement.actor_id === acknowledgement.transport_principal) {
    context.addIssue({ code: 'custom', message: 'Remote identities collapsed' })
  }
  if (effectOutcomes.has(acknowledgement.outcome)
    !== (acknowledgement.receipt_hash !== null)) {
    context.addIssue({ code: 'custom', message: 'Remote receipt binding is invalid' })
  }
})

export const remoteDecisionQueueRecordSchema = z.object({
  schema: z.literal(REMOTE_DECISION_QUEUE_STATE_SCHEMA),
  record_id: identifier,
  capsule_id: identifier,
  command_id: identifier,
  state: remoteQueueState,
  revision: z.number().int().positive(),
  claim_device_id: identifier.nullable(),
  claim_expires_at: timestamp.nullable(),
  outcome: remoteOutcome.nullable(),
  recorded_at: timestamp,
  previous_record_hash: digest.nullable(),
  record_hash: digest,
}).strict()

export const remoteDecisionRevocationSchema = z.object({
  schema: z.literal(REMOTE_DECISION_REVOCATION_SCHEMA),
  revocation_id: identifier,
  capsule_id: identifier,
  command_id: identifier,
  actor_id: identifier,
  reason_code: z.enum([
    'operator_withdrew',
    'device_revoked',
    'proposal_superseded',
    'policy_changed',
    'security_response',
  ]),
  revoked_at: timestamp,
  revocation_hash: digest,
}).strict()

export const remoteDecisionAuditSchema = z.object({
  schema: z.literal(REMOTE_DECISION_AUDIT_SCHEMA),
  audit_id: identifier,
  capsule_hash: digest,
  nonce_hash: digest,
  capsule_id: identifier,
  command_id: identifier,
  actor_id: identifier,
  device_id: identifier,
  transport_principal: identifier.nullable(),
  decision: z.enum(['approve', 'deny']),
  queue_state: remoteQueueState,
  outcome: remoteOutcome.nullable(),
  issued_at: timestamp,
  terminal_at: timestamp.nullable(),
  recorded_at: timestamp,
  audit_hash: digest,
}).strict()

export type RemoteDecisionRequest = z.infer<typeof remoteDecisionRequestSchema>
export type RemoteRelayEnqueueInput = z.infer<typeof remoteRelayEnqueueSchema>
export type RemoteDecisionCapsule = z.infer<typeof remoteDecisionCapsuleSchema>
export type UnsignedRemoteDecisionCapsule = Omit<RemoteDecisionCapsule, 'signature'>
export type RemoteDecisionAcknowledgement = z.infer<
  typeof remoteDecisionAcknowledgementSchema
>
export type RemoteDecisionQueueRecord = z.infer<typeof remoteDecisionQueueRecordSchema>
export type RemoteDecisionRevocation = z.infer<typeof remoteDecisionRevocationSchema>
export type RemoteDecisionAudit = z.infer<typeof remoteDecisionAuditSchema>

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new TypeError('Value is not canonical JSON')
    return encoded
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, child]) => (
    `${JSON.stringify(key)}:${canonicalJson(child)}`
  )).join(',')}}`
}

export function canonicalDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`
}

export function capsuleSigningBytes(capsule: RemoteDecisionCapsule): Buffer {
  const parsed = remoteDecisionCapsuleSchema.parse(capsule)
  const { signature: _signature, ...unsigned } = parsed
  return Buffer.from(canonicalJson(unsigned), 'utf8')
}

export function assertParameterFreeRemoteDecision(value: unknown): void {
  const prohibited = new Set([
    'parameters',
    'payload',
    'dom',
    'prompt',
    'credentials',
    'cookies',
    'profile_id',
    'permit',
  ])
  const stack = [value]
  while (stack.length > 0) {
    const current = stack.pop()
    if (Array.isArray(current)) {
      stack.push(...current)
      continue
    }
    if (!current || typeof current !== 'object') continue
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (prohibited.has(key.toLowerCase())) {
        throw new Error(`Remote decision contains prohibited field ${key}`)
      }
      stack.push(child)
    }
  }
}
