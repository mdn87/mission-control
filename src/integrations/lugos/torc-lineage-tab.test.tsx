import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock, ApiError } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(readonly code: string, readonly status: number, message: string) {
      super(message)
    }
  },
}))

vi.mock('@/lib/api-client', () => ({ apiFetch: apiFetchMock, ApiError }))

import { TorcLineageTab } from './torc-lineage-tab'

const INDEX = {
  stub: true,
  lineages: [
    { lineage: 'torc-dev', stateDir: 'p2-pilot', label: 'P2 pilot' },
    { lineage: 'torc-demo', stateDir: 'demo' },
  ],
}

const EXPLANATION = {
  report_kind: 'lineage_explanation',
  derived: true,
  canonical: false,
  trusted: true,
  explanation_complete: true,
  warnings: [],
  lineage: { lineage_id: 'torc-dev' },
  authority_changes: [
    {
      sequence: 1,
      kind: 'lineage_created',
      summary: 'Initial authority was acquired.',
      occurred_at: '2026-08-08T22:37:33.907659Z',
      transition_id: 'transition-1',
    },
  ],
  handoffs: [],
  continuity_events: [],
  fit_decisions: [],
}

function routeResponses(index: unknown = INDEX) {
  apiFetchMock.mockImplementation((path: string) =>
    path.startsWith('/api/lugos/lineage/list')
      ? Promise.resolve(index)
      : Promise.resolve(EXPLANATION),
  )
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe('TorcLineageTab', () => {
  it('marks the lineage index as a stub', async () => {
    routeResponses()

    render(<TorcLineageTab />)

    expect(await screen.findByText('stub')).toBeTruthy()
    expect(screen.getByText(/no enumerate-lineages contract/)).toBeTruthy()
  })

  it('lists configured lineages and explains the first by default', async () => {
    routeResponses()

    render(<TorcLineageTab />)

    expect(await screen.findByRole('button', { name: 'P2 pilot' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'torc-demo' })).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByText(/Initial authority was acquired/)).toBeTruthy()
    })
    const explainCall = apiFetchMock.mock.calls.find(([path]) =>
      path.startsWith('/api/lugos/lineage?'),
    )
    expect(explainCall?.[0]).toContain('lineage=torc-dev')
    expect(explainCall?.[0]).toContain('stateDir=p2-pilot')
  })

  it('explains a different lineage when selected', async () => {
    routeResponses()

    render(<TorcLineageTab />)
    fireEvent.click(await screen.findByRole('button', { name: 'torc-demo' }))

    await waitFor(() => {
      const calls = apiFetchMock.mock.calls.filter(([path]) =>
        path.startsWith('/api/lugos/lineage?'),
      )
      expect(calls.some(([path]) => path.includes('lineage=torc-demo'))).toBe(true)
    })
  })

  it('reports an empty index without inventing lineages', async () => {
    routeResponses({ stub: true, lineages: [] })

    render(<TorcLineageTab />)

    expect(await screen.findByText('No lineages configured.')).toBeTruthy()
    expect(screen.getByText('Select a lineage to explain.')).toBeTruthy()
  })

  it('allows explaining a lineage typed directly', async () => {
    routeResponses({ stub: true, lineages: [] })

    render(<TorcLineageTab />)
    await screen.findByText('No lineages configured.')

    fireEvent.change(screen.getByPlaceholderText('torc-dev'), {
      target: { value: 'torc-manual' },
    })
    fireEvent.change(screen.getByPlaceholderText('p2-pilot'), {
      target: { value: 'manual-state' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Explain' }))

    await waitFor(() => {
      const calls = apiFetchMock.mock.calls.filter(([path]) =>
        path.startsWith('/api/lugos/lineage?'),
      )
      expect(calls.some(([path]) => path.includes('lineage=torc-manual'))).toBe(true)
    })
  })

  it('surfaces an index failure', async () => {
    apiFetchMock.mockRejectedValue(new ApiError('SERVER_ERROR', 500, 'TORC lineage index failed'))

    render(<TorcLineageTab />)

    expect(await screen.findByText('TORC lineage index failed')).toBeTruthy()
  })
})
