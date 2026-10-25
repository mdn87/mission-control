import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { OgmiPanel } from './ogmi-panel'
import { OGMI_VIEW } from './__tests__/ogmi-view.fixture'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/api-client', () => ({ apiFetch }))
beforeEach(() => { apiFetch.mockReset(); apiFetch.mockResolvedValue(OGMI_VIEW) })

it('shows verified gates separately from reported project claims and source evidence', async () => {
  render(<OgmiPanel />)
  expect(await screen.findByText('1 of 2 gates complete')).toBeTruthy()
  expect(screen.getByText('reported')).toBeTruthy()
  expect(screen.getByText('run-proof')).toBeTruthy()
  expect(screen.getByText('No review verdict recorded')).toBeTruthy()
  expect(screen.getByText('Human acceptance has not been recorded')).toBeTruthy()
  expect(screen.getByText('100% complete')).toBeTruthy()
})

it('clears previously verified evidence when a refresh fails', async () => {
  render(<OgmiPanel />)
  await screen.findByText('1 of 2 gates complete')
  apiFetch.mockRejectedValueOnce(new Error('source changed'))
  fireEvent.click(screen.getByRole('button', { name: 'Refresh evidence' }))
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.queryByText('1 of 2 gates complete')).toBeNull()
})

it('rejects an unexpected response rather than displaying unverified claims', async () => {
  apiFetch.mockResolvedValue({ ...OGMI_VIEW, schema: 'unverified/v1' })
  render(<OgmiPanel />)
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.queryByText('run-proof')).toBeNull()
})
