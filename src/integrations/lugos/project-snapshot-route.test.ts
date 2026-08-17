import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PROJECT_SNAPSHOT_VIEW } from './__tests__/project-snapshot-view.fixture'

const { requireRole, fetchCurrentProjectSnapshot } = vi.hoisted(() => ({
  requireRole: vi.fn(),
  fetchCurrentProjectSnapshot: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/integrations/lugos/project-snapshot-client', () => ({
  fetchCurrentProjectSnapshot,
}))

import { GET } from '@/app/api/lugos/project-snapshot/route'

beforeEach(() => {
  requireRole.mockReset()
  fetchCurrentProjectSnapshot.mockReset()
  requireRole.mockReturnValue({ user: { id: 'u1', role: 'viewer' } })
  fetchCurrentProjectSnapshot.mockResolvedValue(PROJECT_SNAPSHOT_VIEW)
})

describe('GET /api/lugos/project-snapshot', () => {
  it('returns the trusted envelope to a viewer without caching', async () => {
    const response = await GET(new Request('http://mission-control.test/api/lugos/project-snapshot'))

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual(PROJECT_SNAPSHOT_VIEW)
    expect(requireRole).toHaveBeenCalledWith(expect.anything(), 'viewer')
  })

  it('does not expose a mutation verb', async () => {
    const route = await import('@/app/api/lugos/project-snapshot/route')

    expect(route).not.toHaveProperty('POST')
    expect(route).not.toHaveProperty('PUT')
    expect(route).not.toHaveProperty('PATCH')
    expect(route).not.toHaveProperty('DELETE')
  })

  it('refuses an unauthenticated request without invoking TORC', async () => {
    requireRole.mockReturnValue({ error: 'Authentication required', status: 401 })

    const response = await GET(new Request('http://mission-control.test/api/lugos/project-snapshot'))

    expect(response.status).toBe(401)
    expect(fetchCurrentProjectSnapshot).not.toHaveBeenCalled()
  })

  it('maps an unavailable TORC view to 502', async () => {
    fetchCurrentProjectSnapshot.mockRejectedValue(new Error('not configured'))

    const response = await GET(new Request('http://mission-control.test/api/lugos/project-snapshot'))

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({
      error: 'TORC project snapshot view unavailable',
    })
  })
})
