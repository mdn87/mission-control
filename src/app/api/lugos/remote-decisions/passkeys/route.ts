import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import {
  assertRemoteDecisionRequestOrigin,
  deletePasskey,
  passkeyStatus,
  remoteWebAuthnEnabled,
} from '@/lib/webauthn/remote-passkeys'
import { remoteWebAuthnErrorResponse } from '@/lib/webauthn/remote-route'

export async function GET(request: Request) {
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
    return NextResponse.json(passkeyStatus(auth.user), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return remoteWebAuthnErrorResponse(error)
  }
}

export async function DELETE(request: Request) {
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
      credential_id?: unknown
      current_password?: unknown
    }
    deletePasskey(
      auth.user,
      typeof input.credential_id === 'string' ? input.credential_id : '',
      typeof input.current_password === 'string' ? input.current_password : '',
    )
    return new NextResponse(null, {
      status: 204,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return remoteWebAuthnErrorResponse(error)
  }
}
