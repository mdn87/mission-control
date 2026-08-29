import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { passwordChangeLimiter } from '@/lib/rate-limit'
import {
  assertRemoteDecisionRequestOrigin,
  registrationOptions,
  remoteWebAuthnEnabled,
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
  } catch (error) {
    return remoteWebAuthnErrorResponse(error)
  }
  const rateLimit = passwordChangeLimiter(`remote-passkey:${auth.user.id}`)
  if (rateLimit) return rateLimit
  try {
    const input = await request.json() as { current_password?: unknown }
    return NextResponse.json(await registrationOptions(
      auth.user,
      typeof input.current_password === 'string' ? input.current_password : '',
    ), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return remoteWebAuthnErrorResponse(error)
  }
}
