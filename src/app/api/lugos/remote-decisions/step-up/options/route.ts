import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import {
  configuredRemoteDecisionDeviceId,
  prepareRemoteDecisionBinding,
  remoteDecisionsEnabled,
  RemoteDecisionUnavailableError,
} from '@/integrations/lugos/remote-relay-service'
import {
  assertRemoteDecisionRequestOrigin,
  authenticationOptions,
  remoteWebAuthnEnabled,
} from '@/lib/webauthn/remote-passkeys'
import { remoteWebAuthnErrorResponse } from '@/lib/webauthn/remote-route'

export async function POST(request: Request) {
  if (!remoteDecisionsEnabled() || !remoteWebAuthnEnabled()) {
    return NextResponse.json(
      { error: 'Remote decisions are disabled' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  const auth = requireRole(request, 'operator')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  try {
    assertRemoteDecisionRequestOrigin(request)
    const binding = prepareRemoteDecisionBinding(await request.json(), auth.user)
    if (binding.input.device_id !== configuredRemoteDecisionDeviceId()) {
      throw new RemoteDecisionUnavailableError('remote_device_mismatch')
    }
    return NextResponse.json(await authenticationOptions(
      auth.user,
      binding.binding_digest,
    ), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return remoteWebAuthnErrorResponse(error)
  }
}
