import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { fetchOperatorModelBudgets } from '@/integrations/lugos/operator-client'
import { logger } from '@/lib/logger'
import { observePaidModelBudgets } from '@/lib/paid-model-observability'

export async function GET(request: Request) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  try {
    const budgets = await fetchOperatorModelBudgets()
    try {
      observePaidModelBudgets({
        budgets,
        workspaceId: auth.user.workspace_id ?? 1,
        recipient: auth.user.username,
      })
    } catch (error) {
      logger.warn({ err: error }, 'Paid-model budget observability write failed')
    }
    return NextResponse.json(budgets, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch {
    return NextResponse.json(
      { error: 'Paid-model budget status is unavailable' },
      { status: 502 },
    )
  }
}
