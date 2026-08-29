import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { requireRole } from '@/lib/auth'
import { verifyRemoteDecisionStepUp } from '@/lib/webauthn/remote-step-up'
import { fetchOperatorSnapshot } from '@/integrations/lugos/operator-client'
import { weirSnapshotSchema } from '@/integrations/lugos/operator-contract'
import { enqueueRemoteDecision } from '@/integrations/lugos/remote-relay-client'
import {
  configuredActorIdForUser,
  configuredRemoteDecisionDeviceId,
  remoteDecisionsEnabled,
  RemoteDecisionUnavailableError,
  submitRemoteDecision,
} from '@/integrations/lugos/remote-relay-service'

async function reloadWeirProjection() {
  const snapshot = await fetchOperatorSnapshot()
  const candidate = snapshot.projections.find(item => item.name === 'weir')
  if (!candidate) {
    throw new RemoteDecisionUnavailableError('remote_weir_projection_unavailable')
  }
  return weirSnapshotSchema.parse(candidate.value)
}

export async function POST(request: Request) {
  if (!remoteDecisionsEnabled()) {
    return NextResponse.json(
      { error: 'Remote decisions are disabled' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  const auth = requireRole(request, 'operator')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  let input: unknown
  try {
    input = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid remote decision' }, { status: 400 })
  }

  try {
    const capsule = await submitRemoteDecision(input, request, auth.user, {
      reloadWeirProjection,
      actorIdForUser: configuredActorIdForUser,
      expectedDeviceId: configuredRemoteDecisionDeviceId,
      verifyStepUp: verifyRemoteDecisionStepUp,
      enqueue: enqueueRemoteDecision,
    })
    return NextResponse.json(capsule, {
      status: 202,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    if (error instanceof RemoteDecisionUnavailableError) {
      return NextResponse.json(
        { error: error.code },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      )
    }
    if (error instanceof ZodError) {
      return NextResponse.json({ error: 'Invalid remote decision' }, { status: 400 })
    }
    return NextResponse.json(
      { error: 'Remote decision service unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }
}
