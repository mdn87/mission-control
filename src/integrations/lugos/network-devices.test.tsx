import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DevicesDetail } from './network-devices'
import { CockpitDrillIn, CockpitExceptionDeck } from './cockpit-overview'
import {
  makeBranReadinessProjection,
  makeDiagnosticsProjection,
  makeFleetProjection,
  makeNetworkDevicesProjection,
} from './__tests__/cockpit-fixtures'

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }))
vi.mock('@/lib/api-client', () => ({ apiFetch: apiFetchMock }))

function receipt(type: string) {
  return {
    schema: 'lugos-operator-receipt/v1',
    receipt_id: `receipt-${type}`,
    type,
    idempotency_key: 'mc-test',
    status: 'accepted',
    accepted_at: '2026-08-03T12:00:05.000Z',
  }
}

describe('Mission Control network device registry', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders new, live, offline, managed, and randomized evidence without any router control', () => {
    render(
      <DevicesDetail
        networkDevices={makeNetworkDevicesProjection()}
        targetSlugs={['4070pc', 'nodens']}
        canCommand={false}
      />,
    )
    expect(screen.getByText(/gl-b3000 · fixture adapter · mutation none/)).toBeInTheDocument()
    expect(screen.getAllByText('fixture-label-printer').length).toBeGreaterThan(0)
    expect(screen.getAllByText('appleMac').length).toBeGreaterThan(0)
    expect(screen.getAllByText('randomized mac').length).toBeGreaterThan(0)
    expect(screen.getByText(/Viewer session/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add device/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /merge/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/reservation.*apply|propose ip|dhcp/i)).not.toBeInTheDocument()
  })

  it('prefills Add Device from router evidence and posts the closed device.add command', async () => {
    apiFetchMock.mockResolvedValue(receipt('device.add'))
    const onReceipt = vi.fn()
    const onReload = vi.fn()
    render(
      <DevicesDetail
        networkDevices={makeNetworkDevicesProjection()}
        targetSlugs={['4070pc', 'nodens']}
        canCommand
        onReceipt={onReceipt}
        onReload={onReload}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add device fixture-label-printer' }))
    const form = screen.getByRole('form', { name: 'Add device' })
    expect(form).toBeInTheDocument()
    expect(screen.getByText('00:00:5E:00:53:01')).toBeInTheDocument()
    expect(screen.getByLabelText('Device id')).toHaveValue('fixture-label-printer')
    expect(screen.getByLabelText('Friendly name')).toHaveValue('fixture-label-printer')
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'printer' } })
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'office' } })
    fireEvent.change(screen.getByLabelText(/Roles/), { target: { value: 'label-printer, Ignored Role' } })
    fireEvent.submit(form)

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    const [url, init] = apiFetchMock.mock.calls[0]
    expect(url).toBe('/api/lugos/commands')
    const body = JSON.parse(String(init.body))
    expect(body.type).toBe('device.add')
    expect(body.payload).toEqual({
      source_device_id: 'dev-00005e005301',
      device_id: 'fixture-label-printer',
      name: 'fixture-label-printer',
      category: 'printer',
      manufacturer: null,
      model: null,
      location: 'office',
      roles: ['label-printer'],
      notes: null,
      target_slug: null,
    })
    await waitFor(() => expect(onReceipt).toHaveBeenCalledWith(expect.objectContaining({ type: 'device.add' })))
    expect(onReload).toHaveBeenCalledOnce()
    expect(screen.queryByRole('form', { name: 'Add device' })).not.toBeInTheDocument()
  })

  it('merges a provisional interface into an existing device without creating one', async () => {
    apiFetchMock.mockResolvedValue(receipt('device.merge'))
    render(
      <DevicesDetail
        networkDevices={makeNetworkDevicesProjection()}
        targetSlugs={[]}
        canCommand
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Merge device appleMac' }))
    const form = screen.getByRole('form', { name: 'Merge device' })
    fireEvent.change(screen.getByLabelText('Merge into existing device'), { target: { value: '4070pc' } })
    fireEvent.submit(form)
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce())
    const body = JSON.parse(String(apiFetchMock.mock.calls[0][1].body))
    expect(body.type).toBe('device.merge')
    expect(body.payload).toEqual({ source_device_id: 'dev-769335c39dd4', into_device_id: '4070pc' })
  })

  it('exposes the Devices tab only when the projection is present and lists new devices in the deck', () => {
    const { rerender } = render(
      <CockpitDrillIn
        fleet={makeFleetProjection()}
        diagnostics={makeDiagnosticsProjection()}
        branReadiness={makeBranReadinessProjection()}
        detail="fleet"
        onSelect={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByRole('tab', { name: 'Devices' })).not.toBeInTheDocument()
    rerender(
      <CockpitDrillIn
        fleet={makeFleetProjection()}
        diagnostics={makeDiagnosticsProjection()}
        branReadiness={makeBranReadinessProjection()}
        networkDevices={makeNetworkDevicesProjection()}
        detail="devices"
        onSelect={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByRole('tab', { name: 'Devices' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Network devices')).toBeInTheDocument()

    render(
      <CockpitExceptionDeck
        fleet={makeFleetProjection()}
        diagnostics={makeDiagnosticsProjection()}
        branReadiness={makeBranReadinessProjection()}
        networkDevices={makeNetworkDevicesProjection()}
        onOpen={() => {}}
      />,
    )
    expect(screen.getByText('New device: fixture-label-printer')).toBeInTheDocument()
    expect(screen.getByText('New device: appleMac')).toBeInTheDocument()
    expect(screen.queryByText(/New device: 4070pc/)).not.toBeInTheDocument()
  })
})
