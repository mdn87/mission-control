import type { User } from '@/lib/auth'
import { RemoteDecisionUnavailableError } from '@/integrations/lugos/remote-relay-service'

export async function verifyRemoteDecisionStepUp(_input: {
  request: Request
  user: User
  binding_digest: string
}): Promise<{ step_up_ref: string }> {
  throw new RemoteDecisionUnavailableError('remote_step_up_provider_unconfigured')
}
