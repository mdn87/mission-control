import { render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeSnapshot } from './__tests__/fixtures'
import { makeNetworkDevicesProjection } from './__tests__/cockpit-fixtures'

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }))
vi.mock('@/lib/api-client', () => ({ apiFetch: apiFetchMock }))

import { LugosSpatialOverview } from './lugos-spatial-overview'

class FakeEventSource {
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  addEventListener() {}
  close() {}
}

describe('Lugos overview network device registry section', () => {
  beforeAll(() => {
    vi.stubGlobal('EventSource', FakeEventSource)
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    apiFetchMock.mockResolvedValue(makeSnapshot({
      projections: [
        ...makeSnapshot().projections,
        { name: 'network-devices', value: makeNetworkDevicesProjection() },
      ],
    }))
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders the registry on the overview even when the cockpit trio is absent', async () => {
    render(<LugosSpatialOverview />)
    expect(await screen.findByText('Devices observed by the GL-B3000')).toBeInTheDocument()
    expect(screen.getAllByText('fixture-label-printer').length).toBeGreaterThan(0)
    expect(screen.queryByRole('tab', { name: 'Devices' })).not.toBeInTheDocument()
    expect(screen.getByText(/Viewer session/)).toBeInTheDocument()
  })

  it('renders nothing for the registry when its projection is absent', async () => {
    apiFetchMock.mockResolvedValue(makeSnapshot())
    render(<LugosSpatialOverview />)
    expect(await screen.findByText('Lugos Fleet')).toBeInTheDocument()
    expect(screen.queryByText('Devices observed by the GL-B3000')).not.toBeInTheDocument()
  })
})
