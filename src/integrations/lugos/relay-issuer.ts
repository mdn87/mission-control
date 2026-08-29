import {
  assertParameterFreeRemoteDecision,
  canonicalDigest,
  remoteRelayEnqueueSchema,
  type RemoteDecisionCapsule,
  type RemoteRelayEnqueueInput,
} from './remote-decision-contract'
import { RemoteRelayQueue } from './relay-queue'
import { RemoteRelaySigner } from './relay-signer'

export class RemoteRelayIssuer {
  constructor(
    private readonly signer: RemoteRelaySigner,
    private readonly queue: RemoteRelayQueue,
  ) {}

  enqueue(input: RemoteRelayEnqueueInput): RemoteDecisionCapsule {
    const request = remoteRelayEnqueueSchema.parse(input)
    assertParameterFreeRemoteDecision(request)
    const requestHash = canonicalDigest(request)
    const existing = this.queue.existingCapsule(request.command_id, requestHash)
    if (existing) return existing

    const candidate = this.signer.sign(request)
    this.queue.enqueue(candidate, requestHash)
    const committed = this.queue.existingCapsule(request.command_id, requestHash)
    if (!committed) throw new Error('Remote relay queue lost its committed capsule')
    return committed
  }
}
