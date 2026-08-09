import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { fetchOperatorModelBudgets } from '@/integrations/lugos/operator-client'

export async function GET(request: Request) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  try {
    return NextResponse.json(await fetchOperatorModelBudgets(), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch {
    return NextResponse.json(
      { error: 'Paid-model budget status is unavailable' },
      { status: 502 },
    )
  }
}
