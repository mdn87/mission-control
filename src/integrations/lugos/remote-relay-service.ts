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

function requireCurrentProposal(
  projection: WeirProjection,
  input: RemoteDecisionRequest,
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
  const input = remoteDecisionRequestSchema.parse(rawInput)
  const projection = await dependencies.reloadWeirProjection()
  requireCurrentProposal(projection, input)
  const actorId = dependencies.actorIdForUser(user)
  const bindingDigest = canonicalDigest({
    schema: input.schema,
    command_id: input.idempotency_key,
    actor_id: actorId,
    decision: input.decision,
    proposal_hash: input.proposal_hash,
    action_id: input.action_id,
    work_context_hash: input.work_context_hash,
    device_id: input.device_id,
  })
  const stepUp = await dependencies.verifyStepUp({
    request,
    user,
    binding_digest: bindingDigest,
  })
  if (!/^sha256:[a-f0-9]{64}$/.test(stepUp.step_up_ref)) {
    throw new RemoteDecisionUnavailableError('remote_step_up_invalid')
  }
  return remoteDecisionCapsuleSchema.parse(await dependencies.enqueue({
    command_id: input.idempotency_key,
    actor_id: actorId,
    audience: 'fade-weir-remote-decision',
    device_id: input.device_id,
    decision: input.decision,
    proposal_hash: input.proposal_hash,
    action_id: input.action_id,
    work_context_hash: input.work_context_hash,
    step_up_ref: stepUp.step_up_ref,
  }))
}
