import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { approvalRequestCommandSchema } from '@/integrations/lugos/operator-contract'
import { sendOperatorCommand } from '@/integrations/lugos/operator-client'

export async function POST(request: Request) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  let input: unknown
  try {
    input = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid command' }, { status: 400 })
  }
  const command = approvalRequestCommandSchema.safeParse(input)
  if (!command.success) {
    return NextResponse.json({ error: 'Invalid command' }, { status: 400 })
  }

  try {
    return NextResponse.json(await sendOperatorCommand(command.data), {
      status: 202,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch {
    return NextResponse.json(
      { error: 'Lugos operator command unavailable' },
      { status: 502 },
    )
  }
}
