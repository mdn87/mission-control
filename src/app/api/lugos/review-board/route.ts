import { getDatabase } from '@/lib/db'
import { escapeHtml } from '@/lib/injection-guard'
import { redeemReviewGrant, reviewViewer } from '@/integrations/lugos/review-board'

export const dynamic = 'force-dynamic'
const headers = {
  'Cache-Control': 'private, no-store',
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}

export async function GET(request: Request) {
  const token = request.headers.get('x-weir-review-grant')
  const user =
    token === null
      ? reviewViewer(request)
      : redeemReviewGrant(token, request.headers.get('x-weir-report-owner'))
  if (!user) return new Response('Sign in to read the task board.', { status: 401, headers })
  const rows = getDatabase()
    .prepare(
      "SELECT id, title, COUNT(*) OVER () AS total FROM tasks WHERE workspace_id = ? AND status = 'review' ORDER BY id LIMIT 200",
    )
    .all(user.workspace_id) as { id: number; title: string; total: number }[]
  const total = rows[0]?.total ?? 0
  const items = rows
    .map(
      (row) =>
        '<li data-task-id="' + row.id + '"><span data-task-title>' + escapeHtml(row.title) + '</span></li>',
    )
    .join('')
  const summary =
    total > rows.length
      ? 'Showing the first ' + rows.length + ' of ' + total + ' tasks.'
      : total === 0
        ? 'No tasks are in review.'
        : total + (total === 1 ? ' task is' : ' tasks are') + ' in review.'
  return new Response(
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Tasks in review</title>' +
      '<main data-weir-review-board="1" data-workspace-id="' +
      user.workspace_id +
      '" data-total="' +
      total +
      '"><h1>Tasks in review</h1><p>' +
      summary +
      '</p><ol>' +
      items +
      '</ol></main></html>',
    { headers },
  )
}
