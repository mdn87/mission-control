import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { fetchOperatorSnapshot } from '@/integrations/lugos/operator-client'
import { applyCockpitRuntimeGate } from '@/integrations/lugos/cockpit-mode'

export async function GET(request: Request) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  try {
    return NextResponse.json(applyCockpitRuntimeGate(await fetchOperatorSnapshot()), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch {
    return NextResponse.json(
      { error: 'Lugos operator API unavailable' },
      { status: 502 },
    )
  }
}
