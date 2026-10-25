import { beforeEach, expect, it, vi } from 'vitest'
import { OGMI_VIEW } from './__tests__/ogmi-view.fixture'
const { requireRole, fetchOgmiProjection, denyUnscopedResourceForStrictWorkspace } = vi.hoisted(() => ({ requireRole: vi.fn(), fetchOgmiProjection: vi.fn(), denyUnscopedResourceForStrictWorkspace: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/workspace-isolation', () => ({ denyUnscopedResourceForStrictWorkspace }))
vi.mock('./ogmi-client', () => ({ fetchOgmiProjection }))
import { GET } from '@/app/api/lugos/ogmi/route'
beforeEach(() => {
  requireRole.mockReset(); fetchOgmiProjection.mockReset()
  denyUnscopedResourceForStrictWorkspace.mockReset()
  requireRole.mockReturnValue({ user: { role: 'viewer' } })
  fetchOgmiProjection.mockResolvedValue(OGMI_VIEW)
})
it('denies strict or missing workspace context before launching the verifier', async () => {
  denyUnscopedResourceForStrictWorkspace.mockReturnValue(new Response('Forbidden', { status: 403 }))
  expect((await GET(new Request('http://localhost/api/lugos/ogmi'))).status).toBe(403)
  expect(denyUnscopedResourceForStrictWorkspace).toHaveBeenCalledWith({ role: 'viewer' }, 'ogmi_evidence', '/api/lugos/ogmi')
  expect(fetchOgmiProjection).not.toHaveBeenCalled()
})
it('authenticates before reading and ignores browser-selected filesystem paths', async () => {
  const result = await GET(new Request('http://localhost/api/lugos/ogmi?project=secret&snapshot=other'))
  expect(requireRole).toHaveBeenCalledWith(expect.any(Request), 'viewer')
  expect(fetchOgmiProjection).toHaveBeenCalledWith()
  expect(result.headers.get('Cache-Control')).toBe('no-store')
  expect(await result.json()).toEqual(OGMI_VIEW)
})
it('does not launch the reader for unauthenticated requests', async () => {
  requireRole.mockReturnValue({ error: 'Unauthorized', status: 401 })
  expect((await GET(new Request('http://localhost/api/lugos/ogmi'))).status).toBe(401)
  expect(fetchOgmiProjection).not.toHaveBeenCalled()
})
it('fails closed without leaking local error paths or keeping cached evidence', async () => {
  fetchOgmiProjection.mockRejectedValue(new Error('private /configured/path'))
  const result = await GET(new Request('http://localhost/api/lugos/ogmi'))
  expect(result.status).toBe(503)
  expect(result.headers.get('Cache-Control')).toBe('no-store')
  expect(await result.text()).not.toContain('private')
  const route = await import('@/app/api/lugos/ogmi/route')
  for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(route).not.toHaveProperty(verb)
})
