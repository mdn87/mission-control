import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { issueReviewGrant, revokeReviewGrant } from '@/integrations/lugos/review-board'
import {
  callWebReport,
  reportOwner,
  WebReportError,
  webReportRequest,
} from '@/integrations/lugos/web-reports'

export const dynamic = 'force-dynamic'
const reply = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })

export async function POST(request: Request) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return reply({ error: auth.error }, auth.status)
  const owner = reportOwner(auth.user)
  if (!owner) return reply({ error: 'Sign in with an operator account.' }, 403)
  // The global proxy checks the browser Origin against the configured deployment hosts.
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    return reply({ error: 'Expected a JSON request.' }, 415)
  const reader = request.body?.getReader()
  if (!reader) return reply({ error: 'Empty report request.' }, 400)
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.length
    if (size > 16_384) {
      await reader.cancel()
      return reply({ error: 'Report request is too large.' }, 413)
    }
    chunks.push(value)
  }
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return reply({ error: 'Invalid JSON.' }, 400)
  }
  const parsed = webReportRequest.safeParse(raw)
  if (!parsed.success) return reply({ error: 'Invalid report fields.' }, 400)
  if (['dias', 'marketplace', 'task_review'].includes(parsed.data.action) && auth.user.role === 'viewer') {
    return reply({ error: 'An operator role is required to run a new report.' }, 403)
  }
  try {
    if (parsed.data.action === 'task_review') {
      const grant = issueReviewGrant(request, owner)
      if (!grant) return reply({ error: 'A current operator browser session is required.' }, 403)
      try {
        return reply(await callWebReport(parsed.data, owner, grant))
      } finally {
        revokeReviewGrant(grant)
      }
    }
    return reply(await callWebReport(parsed.data, owner))
  } catch (error) {
    return error instanceof WebReportError
      ? reply({ error: error.message }, error.status)
      : reply({ error: 'Report service unavailable.' }, 502)
  }
}
