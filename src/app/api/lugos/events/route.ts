import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { operatorCursorSchema } from '@/integrations/lugos/operator-contract'
import { openOperatorEventStream } from '@/integrations/lugos/operator-client'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const url = new URL(request.url)
  const rawCursor = request.headers.get('last-event-id') || url.searchParams.get('after')
  const parsedCursor = rawCursor === null
    ? { success: true as const, data: null }
    : operatorCursorSchema.safeParse(rawCursor)
  if (!parsedCursor.success) {
    return NextResponse.json({ error: 'Invalid event cursor' }, { status: 400 })
  }

  try {
    const upstream = await openOperatorEventStream(parsedCursor.data, request.signal)
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Cache-Control': 'no-cache, no-transform',
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  } catch {
    return NextResponse.json(
      { error: 'Lugos operator event stream unavailable' },
      { status: 502 },
    )
  }
}
