import type { User } from '@/lib/auth'
import { RemoteDecisionUnavailableError } from '@/integrations/lugos/remote-relay-service'
import {
  assertRemoteDecisionRequestOrigin,
  consumeStepUpGrant,
} from './remote-passkeys'

export async function verifyRemoteDecisionStepUp(input: {
  request: Request
  user: User
  binding_digest: string
}): Promise<{ step_up_ref: string }> {
  assertRemoteDecisionRequestOrigin(input.request)
  const token = input.request.headers.get('x-mc-remote-step-up') || ''
  if (!token) {
    throw new RemoteDecisionUnavailableError('remote_step_up_required')
  }
  return consumeStepUpGrant(input.user, input.binding_digest, token)
}
