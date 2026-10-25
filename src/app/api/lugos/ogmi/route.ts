import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { denyUnscopedResourceForStrictWorkspace } from '@/lib/workspace-isolation'
import { fetchOgmiProjection } from '@/integrations/lugos/ogmi-client'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const denied = denyUnscopedResourceForStrictWorkspace(auth.user, 'ogmi_evidence', '/api/lugos/ogmi')
  if (denied) return denied
  try {
    return NextResponse.json(await fetchOgmiProjection(), { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    // Keep configured filesystem locations and subprocess diagnostics private.
    return NextResponse.json({ error: 'OGMI evidence unavailable or verification failed' }, {
      status: 503, headers: { 'Cache-Control': 'no-store' },
    })
  }
}
