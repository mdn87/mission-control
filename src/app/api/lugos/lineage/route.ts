import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { lineageRequestSchema } from '@/integrations/lugos/torc-contract'
import {
  fetchLineageExplanation,
  TorcStateDirError,
  TorcUnavailableError,
} from '@/integrations/lugos/torc-client'

export const dynamic = 'force-dynamic'

/**
 * Read-only TORC lineage explanation.
 *
 * GET only. TORC's authority-changing commands are deliberately not reachable
 * from Mission Control; this surface renders derived provenance and nothing
 * else.
 */
export async function GET(request: Request) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const url = new URL(request.url)
  const parsed = lineageRequestSchema.safeParse({
    lineage: url.searchParams.get('lineage') ?? '',
    stateDir: url.searchParams.get('stateDir') ?? '',
  })
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid lineage request' }, { status: 400 })
  }

  try {
    const explanation = await fetchLineageExplanation(parsed.data)
    // A trusted:false explanation is a valid 200 response. The panel shows the
    // refusal and its warnings rather than an empty or invented timeline.
    return NextResponse.json(explanation, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    if (error instanceof TorcStateDirError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    if (error instanceof TorcUnavailableError) {
      // Keep the cause in the server log; the client gets a generic message.
      console.error('[torc] lineage explain unavailable:', error.message)
      return NextResponse.json({ error: 'TORC lineage view unavailable' }, { status: 502 })
    }
    console.error('[torc] lineage explain failed:', error)
    return NextResponse.json({ error: 'TORC lineage view failed' }, { status: 500 })
  }
}
