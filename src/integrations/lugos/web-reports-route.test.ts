import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), call: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireRole: mocks.auth }))
vi.mock('./web-reports', async (original) => ({
  ...(await original<typeof import('./web-reports')>()),
  callWebReport: mocks.call,
}))
import { POST } from '@/app/api/lugos/web-reports/route'

const user = { id: 12, tenant_id: 3, workspace_id: 7, role: 'operator', is_approved: 1 }
function submit(action: string, args: object, extras: object = {}) {
  return POST(
    new Request('https://mc.test/api/lugos/web-reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, args, ...extras }),
    }),
  )
}
describe('authenticated WEIR reports', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.auth.mockReturnValue({ user })
    mocks.call.mockResolvedValue({ title: 'WEIR project work report' })
  })
  it('binds the workspace, tenant and user outside report arguments', async () => {
    const response = await submit('dias', { project: 'weir', since: '2026-11-21' })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(mocks.call).toHaveBeenCalledWith(
      { action: 'dias', args: { project: 'weir', since: '2026-11-21' } },
      'mission-control:3:7:12',
    )
  })
  it('denies signed-out requests and the service-wide API identity', async () => {
    mocks.auth.mockReturnValue({ error: 'Authentication required', status: 401 })
    expect((await submit('list', {})).status).toBe(401)
    mocks.auth.mockReturnValue({ user: { ...user, id: 0 } })
    expect((await submit('list', {})).status).toBe(403)
    mocks.auth.mockReturnValue({ user: { ...user, is_approved: 0 } })
    expect((await submit('list', {})).status).toBe(403)
    expect(mocks.call).not.toHaveBeenCalled()
  })
  it('rejects operator, executable and destination overrides', async () => {
    expect((await submit('dias', { project: 'weir' }, { owner: 'other' })).status).toBe(400)
    expect((await submit('dias', { project: 'weir', url: 'https://example.test' })).status).toBe(400)
    expect((await submit('marketplace', { query: 'keyboard', executable: 'other' })).status).toBe(400)
    expect(mocks.call).not.toHaveBeenCalled()
  })
  it('allows a viewer to read only its own archive', async () => {
    mocks.auth.mockReturnValue({ user: { ...user, role: 'viewer', id: 23 } })
    expect((await submit('marketplace', { query: 'keyboard' })).status).toBe(403)
    expect((await submit('list', {})).status).toBe(200)
    expect(mocks.call).toHaveBeenCalledWith({ action: 'list', args: {} }, 'mission-control:3:7:23')
  })
})
