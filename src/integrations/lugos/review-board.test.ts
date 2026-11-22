import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const shared = vi.hoisted(() => ({ session: vi.fn(), database: vi.fn() }))
vi.mock('@/lib/auth', async (original) => ({
  ...(await original<typeof import('@/lib/auth')>()),
  lookupSessionHash: shared.session,
}))
vi.mock('@/lib/db', () => ({ getDatabase: shared.database }))
import { issueReviewGrant, redeemReviewGrant } from './review-board'
import { GET } from '@/app/api/lugos/review-board/route'
import { MC_SESSION_COOKIE_NAME } from '@/lib/session-cookie'

const account = { id: 4, workspace_id: 3, tenant_id: 1, is_approved: 1, role: 'operator', sessionId: 21 }
const owner = 'mission-control:1:3:4'
const request = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/lugos/review-board', { headers })
const cookie = { cookie: MC_SESSION_COOKIE_NAME + '=test-caller-session' }

describe('signed-in task board reads', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    shared.session.mockReturnValue(account)
  })
  it('requires the same signed-in owner and consumes a grant once', () => {
    expect(issueReviewGrant(request(), owner)).toBeNull()
    expect(issueReviewGrant(request(cookie), 'mission-control:1:6:4')).toBeNull()
    const token = issueReviewGrant(request(cookie), owner)!
    expect(token).toMatch(/^[a-f\d]{64}$/)
    expect(redeemReviewGrant(token, owner)?.workspace_id).toBe(3)
    expect(redeemReviewGrant(token, owner)).toBeNull()
  })
  it('denies revoked, mismatched, expired or demoted sessions', () => {
    for (const change of [null, { ...account, workspace_id: 6 }, { ...account, role: 'viewer' }]) {
      shared.session.mockReturnValue(account)
      const token = issueReviewGrant(request(cookie), owner)!
      shared.session.mockReturnValue(change)
      expect(redeemReviewGrant(token, owner)).toBeNull()
    }
    shared.session.mockReturnValue(account)
    vi.useFakeTimers()
    try {
      const token = issueReviewGrant(request(cookie), owner)!
      vi.advanceTimersByTime(91_000)
      expect(redeemReviewGrant(token, owner)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
  it('requires a signed-in viewer or a valid delegated read', async () => {
    expect((await GET(request())).status).toBe(401)
    expect((await GET(request({ 'x-weir-review-grant': 'wrong' }))).status).toBe(401)
    expect(shared.database).not.toHaveBeenCalled()
  })

  it('serves only the Review column of the signed-in workspace as an inert document', async () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, workspace_id INTEGER, status TEXT)')
      const add = db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?)')
      add.run(7, '<script>Review & one</script>', 3, 'review')
      add.run(8, 'Other workspace', 6, 'review')
      add.run(9, 'Different column', 3, 'quality_review')
      shared.database.mockReturnValue(db)
      for (const headers of [cookie, {
        'x-weir-review-grant': issueReviewGrant(request(cookie), owner)!,
        'x-weir-report-owner': owner,
      }]) {
        const response = await GET(request(headers as Record<string, string>))
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toContain('no-store')
        const html = await response.text()
        expect(html).toContain('data-total="1"')
        expect(html).toContain('data-task-id="7"')
        expect(html).toContain('&lt;script&gt;Review &amp; one&lt;/script&gt;')
        expect(html).not.toContain('Other workspace')
        expect(html).not.toContain('Different column')
      }
    } finally {
      db.close()
    }
  })
})
