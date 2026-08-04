import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { loadCockpitDestinations } from '@/integrations/lugos/cockpit-destinations'
import { isLugosCockpitEnabled } from '@/integrations/lugos/cockpit-mode'

export async function GET(request: Request) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  if (!isLugosCockpitEnabled()) {
    return NextResponse.json({ error: 'Lugos cockpit is disabled' }, { status: 404 })
  }
  try {
    return NextResponse.json(loadCockpitDestinations(), {
      headers: { 'Cache-Control': 'private, max-age=300' },
    })
  } catch {
    return NextResponse.json(
      { error: 'Lugos cockpit destination configuration is invalid' },
      { status: 503 },
    )
  }
}
