import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import {
  assertRemoteDecisionRequestOrigin,
  remoteWebAuthnEnabled,
  verifyPasskeyRegistration,
} from '@/lib/webauthn/remote-passkeys'
import { remoteWebAuthnErrorResponse } from '@/lib/webauthn/remote-route'

export async function POST(request: Request) {
  if (!remoteWebAuthnEnabled()) {
    return NextResponse.json(
      { error: 'Remote passkeys are disabled' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  const auth = requireRole(request, 'operator')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  try {
    assertRemoteDecisionRequestOrigin(request)
    const input = await request.json() as {
      challenge_id?: unknown
      response?: unknown
    }
    return NextResponse.json(await verifyPasskeyRegistration(
      auth.user,
      typeof input.challenge_id === 'string' ? input.challenge_id : '',
      input.response,
    ), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return remoteWebAuthnErrorResponse(error)
  }
}
