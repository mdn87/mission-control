import type { User } from '@/lib/auth'
import type { WeirProjection } from './operator-contract'
import {
  canonicalDigest,
  remoteDecisionCapsuleSchema,
  remoteDecisionRequestSchema,
  type RemoteDecisionCapsule,
  type RemoteDecisionRequest,
  type RemoteRelayEnqueueInput,
} from './remote-decision-contract'

export class RemoteDecisionUnavailableError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'RemoteDecisionUnavailableError'
  }
}

export interface RemoteStepUpResult {
  step_up_ref: string
}

export interface RemoteDecisionDependencies {
  reloadWeirProjection(): Promise<WeirProjection>
  actorIdForUser(user: User): string
  expectedDeviceId(): string
  verifyStepUp(input: {
    request: Request
    user: User
    binding_digest: string
  }): Promise<RemoteStepUpResult>
  enqueue(input: RemoteRelayEnqueueInput): Promise<RemoteDecisionCapsule>
}

export type { RemoteRelayEnqueueInput }

export function remoteDecisionsEnabled(): boolean {
  return process.env.MC_REMOTE_DECISIONS_ENABLED === 'true'
}

export function configuredActorIdForUser(user: User): string {
  if (process.env.MC_REMOTE_ACTOR_FORMAT !== 'mc-user-numeric-v1') {
    throw new RemoteDecisionUnavailableError('remote_actor_format_unconfigured')
  }
  if (!Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new RemoteDecisionUnavailableError('remote_actor_identity_invalid')
  }
  return `mc:user:${user.id}`
}

export function configuredRemoteDecisionDeviceId(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const value = (env.MC_REMOTE_DEVICE_ID || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value)) {
    throw new RemoteDecisionUnavailableError('remote_device_unconfigured')
  }
  return value
}

function requireCurrentProposal(
  projection: WeirProjection,
  input: RemoteDecisionRequest,
  now = new Date(),
  maximumAgeSeconds = configuredRemoteProposalMaximumAgeSeconds(),
): void {
  const selected = projection.actions.filter(action => (
    action.proposal_hash === input.proposal_hash
  ))
  if (selected.length !== 1) {
    throw new RemoteDecisionUnavailableError('remote_proposal_not_current')
  }
  const [action] = selected
  if (action.state !== 'proposed'
    || action.action_id !== input.action_id
    || action.work_context_hash !== input.work_context_hash) {
    throw new RemoteDecisionUnavailableError('remote_proposal_binding_mismatch')
  }
  const occurredAt = Date.parse(action.occurred_at)
  const ageMs = now.getTime() - occurredAt
  if (!Number.isFinite(occurredAt)
    || ageMs < -5_000
    || ageMs > maximumAgeSeconds * 1_000) {
    throw new RemoteDecisionUnavailableError('remote_proposal_stale')
  }
}

export function configuredRemoteProposalMaximumAgeSeconds(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = (env.MC_REMOTE_PROPOSAL_MAX_AGE_SECONDS || '600').trim()
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 60 || value > 900) {
    throw new RemoteDecisionUnavailableError('remote_proposal_age_unconfigured')
  }
  return value
}

export function prepareRemoteDecisionBinding(
  rawInput: unknown,
  user: User,
  actorIdForUser: (user: User) => string = configuredActorIdForUser,
): {
  input: RemoteDecisionRequest
  actor_id: string
  binding_digest: string
} {
  const input = remoteDecisionRequestSchema.parse(rawInput)
  const actorId = actorIdForUser(user)
  return {
    input,
    actor_id: actorId,
    binding_digest: canonicalDigest({
      schema: input.schema,
      command_id: input.idempotency_key,
      actor_id: actorId,
      decision: input.decision,
      proposal_hash: input.proposal_hash,
      action_id: input.action_id,
      work_context_hash: input.work_context_hash,
      device_id: input.device_id,
    }),
  }
}

export async function submitRemoteDecision(
  rawInput: unknown,
  request: Request,
  user: User,
  dependencies: RemoteDecisionDependencies,
  enabled = remoteDecisionsEnabled(),
): Promise<RemoteDecisionCapsule> {
  if (!enabled) {
    throw new RemoteDecisionUnavailableError('remote_decisions_disabled')
  }
  const binding = prepareRemoteDecisionBinding(
    rawInput,
    user,
    dependencies.actorIdForUser,
  )
  const { input } = binding
  if (input.device_id !== dependencies.expectedDeviceId()) {
    throw new RemoteDecisionUnavailableError('remote_device_mismatch')
  }
  const projection = await dependencies.reloadWeirProjection()
  requireCurrentProposal(projection, input)
  const stepUp = await dependencies.verifyStepUp({
    request,
    user,
    binding_digest: binding.binding_digest,
  })
  if (!/^sha256:[a-f0-9]{64}$/.test(stepUp.step_up_ref)) {
    throw new RemoteDecisionUnavailableError('remote_step_up_invalid')
  }
  return remoteDecisionCapsuleSchema.parse(await dependencies.enqueue({
    command_id: input.idempotency_key,
    actor_id: binding.actor_id,
    audience: 'fade-weir-remote-decision',
    device_id: input.device_id,
    decision: input.decision,
    proposal_hash: input.proposal_hash,
    action_id: input.action_id,
    work_context_hash: input.work_context_hash,
    step_up_ref: stepUp.step_up_ref,
  }))
}
