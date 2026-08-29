import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { RemoteDecisionUnavailableError } from '@/integrations/lugos/remote-relay-service'

export function remoteWebAuthnErrorResponse(error: unknown): NextResponse {
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: 'remote_request_invalid' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  if (error instanceof RemoteDecisionUnavailableError) {
    const status = error.code === 'remote_passkey_password_invalid'
      || error.code === 'remote_step_up_identity_unsupported'
      ? 403
      : error.code === 'remote_passkey_not_enrolled'
        || error.code === 'remote_passkey_limit_reached'
        || error.code === 'remote_passkey_registration_conflict'
        ? 409
        : error.code.includes('unconfigured') || error.code.includes('disabled')
          ? 503
          : 400
    return NextResponse.json(
      { error: error.code },
      { status, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  return NextResponse.json(
    { error: 'remote_step_up_unavailable' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  )
}
