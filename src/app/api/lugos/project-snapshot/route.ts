import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { fetchCurrentProjectSnapshot } from '@/integrations/lugos/project-snapshot-client'

export const dynamic = 'force-dynamic'

/** Viewer-only projection; this route deliberately exports no mutation verb. */
export async function GET(request: Request) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  try {
    return NextResponse.json(await fetchCurrentProjectSnapshot(), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    console.error(
      '[torc] project snapshot unavailable:',
      error instanceof Error ? error.message : error,
    )
    return NextResponse.json(
      { error: 'TORC project snapshot view unavailable' },
      { status: 502 },
    )
  }
}
