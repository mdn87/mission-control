import type {
  RemoteDecisionCapsule,
} from './remote-decision-contract'
import {
  RemoteDecisionUnavailableError,
  type RemoteRelayEnqueueInput,
} from './remote-relay-service'

export async function enqueueRemoteDecision(
  _input: RemoteRelayEnqueueInput,
): Promise<RemoteDecisionCapsule> {
  throw new RemoteDecisionUnavailableError('remote_relay_issuer_unconfigured')
}
