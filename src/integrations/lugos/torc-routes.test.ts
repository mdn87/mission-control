import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  requireRoleMock,
  fetchLineageExplanationMock,
  listLineagesMock,
  TorcUnavailableError,
  TorcStateDirError,
} = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  fetchLineageExplanationMock: vi.fn(),
  listLineagesMock: vi.fn(),
  TorcUnavailableError: class TorcUnavailableError extends Error {},
  TorcStateDirError: class TorcStateDirError extends Error {},
}))

vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }))
vi.mock('@/integrations/lugos/torc-client', () => ({
  fetchLineageExplanation: fetchLineageExplanationMock,
  listLineages: listLineagesMock,
  TorcUnavailableError,
  TorcStateDirError,
}))

import { GET as getLineage } from '@/app/api/lugos/lineage/route'
import { GET as getLineageIndex } from '@/app/api/lugos/lineage/list/route'

const EXPLANATION = {
  report_kind: 'lineage_explanation',
  derived: true,
  canonical: false,
  trusted: true,
  explanation_complete: true,
  warnings: [],
  lineage: { lineage_id: 'torc-dev' },
  authority_changes: [],
  handoffs: [],
  continuity_events: [],
  fit_decisions: [],
}

function lineageRequest(query = 'lineage=torc-dev&stateDir=p2-pilot') {
  return new Request(`http://mission-control.test/api/lugos/lineage?${query}`)
}

beforeEach(() => {
  requireRoleMock.mockReset()
  fetchLineageExplanationMock.mockReset()
  listLineagesMock.mockReset()
  requireRoleMock.mockReturnValue({ user: { id: 'u1', role: 'viewer' } })
})

describe('GET /api/lugos/lineage/list', () => {
  function indexRequest() {
    return new Request('http://mission-control.test/api/lugos/lineage/list')
  }

  it('returns the stub-flagged index to a viewer', async () => {
    const index = {
      stub: true,
      lineages: [{ lineage: 'torc-dev', stateDir: 'p2-pilot' }],
    }
    listLineagesMock.mockReturnValue(index)

    const response = await getLineageIndex(indexRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(index)
    expect(requireRoleMock).toHaveBeenCalledWith(expect.anything(), 'viewer')
  })

  it('refuses an unauthenticated request', async () => {
    requireRoleMock.mockReturnValue({ error: 'Authentication required', status: 401 })

    const response = await getLineageIndex(indexRequest())

    expect(response.status).toBe(401)
    expect(listLineagesMock).not.toHaveBeenCalled()
  })

  it('does not expose a mutation verb', async () => {
    const route = await import('@/app/api/lugos/lineage/list/route')

    expect(route).not.toHaveProperty('POST')
    expect(route).not.toHaveProperty('DELETE')
  })
})

describe('GET /api/lugos/lineage', () => {
  it('returns a trusted explanation to a viewer', async () => {
    fetchLineageExplanationMock.mockResolvedValue(EXPLANATION)

    const response = await getLineage(lineageRequest())

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual(EXPLANATION)
    expect(requireRoleMock).toHaveBeenCalledWith(expect.anything(), 'viewer')
  })

  it('returns an untrusted explanation as a 200 rather than an error', async () => {
    fetchLineageExplanationMock.mockResolvedValue({
      ...EXPLANATION,
      trusted: false,
      explanation_complete: false,
      warnings: ['Stored provenance is invalid; no authority explanation is asserted.'],
    })

    const response = await getLineage(lineageRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.trusted).toBe(false)
    expect(body.warnings).toHaveLength(1)
  })

  it('refuses an unauthenticated request', async () => {
    requireRoleMock.mockReturnValue({ error: 'Authentication required', status: 401 })

    const response = await getLineage(lineageRequest())

    expect(response.status).toBe(401)
    expect(fetchLineageExplanationMock).not.toHaveBeenCalled()
  })

  it.each([
    ['lineage=&stateDir=p2-pilot', 'missing lineage'],
    ['lineage=torc-dev', 'missing stateDir'],
    ['lineage=../etc&stateDir=p2-pilot', 'traversal in lineage'],
  ])('rejects an invalid request (%s)', async (query) => {
    const response = await getLineage(lineageRequest(query))

    expect(response.status).toBe(400)
    expect(fetchLineageExplanationMock).not.toHaveBeenCalled()
  })

  it('maps a contained-path violation to 400', async () => {
    fetchLineageExplanationMock.mockRejectedValue(new TorcStateDirError('outside root'))

    const response = await getLineage(lineageRequest())

    expect(response.status).toBe(400)
  })

  it('maps an unavailable TORC to 502', async () => {
    fetchLineageExplanationMock.mockRejectedValue(new TorcUnavailableError('no torc'))

    const response = await getLineage(lineageRequest())

    expect(response.status).toBe(502)
  })

  it('does not expose a mutation verb', async () => {
    const route = await import('@/app/api/lugos/lineage/route')

    expect(route).not.toHaveProperty('POST')
    expect(route).not.toHaveProperty('PUT')
    expect(route).not.toHaveProperty('PATCH')
    expect(route).not.toHaveProperty('DELETE')
  })
})
