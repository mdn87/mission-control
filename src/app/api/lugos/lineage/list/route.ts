import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { listLineages } from '@/integrations/lugos/torc-client'

export const dynamic = 'force-dynamic'

/**
 * Stubbed lineage index.
 *
 * TORC has no enumerate-lineages command, so this returns the operator-supplied
 * list from LUGOS_TORC_LINEAGES and always reports `stub: true`. Replace it with
 * a real TORC read contract rather than by querying the store from here.
 */
export async function GET(request: Request) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  try {
    return NextResponse.json(listLineages(), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch {
    return NextResponse.json({ error: 'TORC lineage index failed' }, { status: 500 })
  }
}
