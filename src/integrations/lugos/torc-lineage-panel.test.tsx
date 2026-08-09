import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock, ApiError } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      message: string,
    ) {
      super(message)
    }
  },
}))

vi.mock('@/lib/api-client', () => ({ apiFetch: apiFetchMock, ApiError }))

import { TorcLineagePanel } from './torc-lineage-panel'

const BASE = {
  report_kind: 'lineage_explanation',
  derived: true,
  canonical: false,
  explanation_complete: true,
  lineage: { lineage_id: 'torc-dev' },
  handoffs: [],
  continuity_events: [],
  fit_decisions: [],
}

const TRUSTED = {
  ...BASE,
  trusted: true,
  warnings: [],
  authority_changes: [
    {
      sequence: 1,
      kind: 'lineage_created',
      summary: 'Initial authority was acquired by activation-p2-implementation.',
      occurred_at: '2026-08-08T22:37:33.907659Z',
      transition_id: 'transition-1',
    },
  ],
  handoffs: [
    { handoff_id: 'handoff-1', state: 'accepted', authority_effect: 'transferred' },
    { handoff_id: 'handoff-2', state: 'rejected', authority_effect: 'none' },
  ],
}

const UNTRUSTED = {
  ...BASE,
  trusted: false,
  explanation_complete: false,
  warnings: ['Stored provenance is invalid; no authority explanation is asserted.'],
  authority_changes: [
    {
      sequence: 1,
      kind: 'lineage_created',
      summary: 'This timeline must never be rendered.',
      occurred_at: '2026-08-08T22:37:33.907659Z',
      transition_id: 'transition-1',
    },
  ],
}

function renderPanel() {
  return render(<TorcLineagePanel lineage="torc-dev" stateDir="p2-pilot" />)
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe('TorcLineagePanel', () => {
  it('renders the authority timeline and marks the view derived', async () => {
    apiFetchMock.mockResolvedValue(TRUSTED)

    renderPanel()

    expect(await screen.findByText(/Initial authority was acquired/)).toBeTruthy()
    expect(screen.getByText('derived')).toBeTruthy()
    expect(screen.getByText('non-canonical')).toBeTruthy()
    expect(screen.getByText('trusted')).toBeTruthy()
  })

  it('distinguishes handoffs that did not transfer authority', async () => {
    apiFetchMock.mockResolvedValue(TRUSTED)

    renderPanel()

    expect(await screen.findByText('transferred authority')).toBeTruthy()
    expect(screen.getByText('did not transfer authority')).toBeTruthy()
  })

  it('suppresses the timeline entirely when TORC does not trust the explanation', async () => {
    apiFetchMock.mockResolvedValue(UNTRUSTED)

    renderPanel()

    expect(await screen.findByText(/could not verify this lineage/)).toBeTruthy()
    expect(screen.getByText(/Stored provenance is invalid/)).toBeTruthy()
    expect(screen.getByText('unverified')).toBeTruthy()
    expect(screen.queryByText(/This timeline must never be rendered/)).toBeNull()
  })

  it('surfaces an upstream failure without inventing a timeline', async () => {
    apiFetchMock.mockRejectedValue(new ApiError('SERVER_ERROR', 502, 'TORC lineage view unavailable'))

    renderPanel()

    await waitFor(() => {
      expect(screen.getByText('TORC lineage view unavailable')).toBeTruthy()
    })
    expect(screen.queryByText('trusted')).toBeNull()
  })

  it('rejects a payload that is not a lineage explanation', async () => {
    apiFetchMock.mockResolvedValue({ report_kind: 'something_else' })

    renderPanel()

    expect(
      await screen.findByText('TORC returned an unrecognized lineage payload'),
    ).toBeTruthy()
  })
})
