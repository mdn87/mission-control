import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole, validateSession } from '@/lib/auth'
import { parseMcSessionCookieHeader } from '@/lib/session-cookie'
import { assertRemoteDecisionRequestOrigin, authenticationOptions, consumeStepUpGrant,
  remoteWebAuthnEnabled, verifyPasskeyAuthentication } from '@/lib/webauthn/remote-passkeys'
import { remoteWebAuthnErrorResponse } from '@/lib/webauthn/remote-route'
import { passkeyBinding } from '@/integrations/lugos/field-review'
import { currentFieldReview, publishedRecord, publishOnce } from '@/integrations/lugos/field-review-files'

const headers = { 'Cache-Control': 'private, no-store' }
const inputHash = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const requestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('options'), review_hash: inputHash }).strict(),
  z.object({ operation: z.literal('approve'), review_hash: inputHash,
    challenge_id: z.string().min(1).max(256), response: z.record(z.string(), z.unknown()) }).strict(),
])
const inbox = () => process.env.MC_WEIR_FIELD_STEPUP_DIR || '/run/weir-field-stepups'

function access(request: Request) {
  if (process.env.MC_WEIR_FIELD_REHEARSAL_ENABLED !== 'true' || !remoteWebAuthnEnabled()) {
    return { response: NextResponse.json({ error: 'field_review_disabled' }, { status: 404, headers }) }
  }
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return { response: NextResponse.json({ error: auth.error }, { status: auth.status, headers }) }
  const token = parseMcSessionCookieHeader(request.headers.get('cookie') || '')
  const session = token ? validateSession(token) : null
  if (!session || session.id !== auth.user.id || session.provider !== 'local' || auth.user.provider !== 'local'
      || 'mc:user:' + auth.user.id !== process.env.MC_WEIR_FIELD_OWNER) {
    return { response: NextResponse.json({ error: 'field_review_owner_required' }, { status: 403, headers }) }
  }
  return { user: auth.user }
}

function stamped(hash: string) {
  try {
    const value = publishedRecord(inbox(), hash, process.geteuid!())
    return z.object({ review_hash: z.literal(hash), actor_id: z.literal(process.env.MC_WEIR_FIELD_OWNER || ''),
      step_up_ref: inputHash }).strict().parse(value)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function GET(request: Request) {
  const auth = access(request)
  if (auth.response) return auth.response
  try {
    const review = currentFieldReview()
    return NextResponse.json({ review, state: stamped(review.review_hash) ? 'approved' : 'awaiting_passkey' }, { headers })
  } catch {
    return NextResponse.json({ error: 'field_review_unavailable' }, { status: 409, headers })
  }
}

export async function POST(request: Request) {
  const auth = access(request)
  if (auth.response) return auth.response
  try {
    assertRemoteDecisionRequestOrigin(request)
    const input = requestSchema.parse(await request.json())
    const review = currentFieldReview()
    if (review.review_hash !== input.review_hash) {
      return NextResponse.json({ error: 'field_review_changed' }, { status: 409, headers })
    }
    const binding = passkeyBinding(review)
    if (input.operation === 'options') {
      return NextResponse.json(await authenticationOptions(auth.user!, binding), { headers })
    }
    const grant = await verifyPasskeyAuthentication(auth.user!, input.challenge_id, input.response)
    const proof = consumeStepUpGrant(auth.user!, binding, grant.step_up_token)
    if (currentFieldReview().review_hash !== review.review_hash) {
      return NextResponse.json({ error: 'field_review_changed' }, { status: 409, headers })
    }
    const record = { review_hash: review.review_hash, actor_id: review.actor_id, step_up_ref: proof.step_up_ref }
    if (!publishOnce(inbox(), review.review_hash, record) && !stamped(review.review_hash)) {
      throw new Error('field_review_publication_failed')
    }
    return NextResponse.json({ state: 'approved', review_hash: review.review_hash }, { status: 202, headers })
  } catch (error) {
    return remoteWebAuthnErrorResponse(error)
  }
}
