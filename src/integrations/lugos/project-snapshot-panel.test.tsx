// @vitest-environment jsdom
import React from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PROJECT_SNAPSHOT_VIEW } from './__tests__/project-snapshot-view.fixture'

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('@/lib/api-client', () => ({ apiFetch, ApiError: class ApiError extends Error {} }))

import { ProjectSnapshotPanel } from './project-snapshot-panel'

beforeEach(() => {
  apiFetch.mockReset()
  apiFetch.mockResolvedValue(PROJECT_SNAPSHOT_VIEW)
})

describe('ProjectSnapshotPanel', () => {
  it('renders accepted project, claim, receipt, blocker, decision, activity, conflict, and unknown data', async () => {
    const { container } = render(<ProjectSnapshotPanel />)

    expect(await screen.findByText('Lugos snapshot')).toBeTruthy()
    expect(screen.getByText('TORC')).toBeTruthy()
    expect(screen.getByText('consumer-ready')).toBeTruthy()
    expect(screen.getByText('No open blocker')).toBeTruthy()
    expect(screen.getByText('Choose refresh cadence')).toBeTruthy()
    expect(screen.getByText('Accepted snapshot')).toBeTruthy()
    expect(screen.getByText('Status sources disagree')).toBeTruthy()
    expect(screen.getByText('Windows smoke not run')).toBeTruthy()
    expect(screen.getByText('schema_validity')).toBeTruthy()
    expect(apiFetch).toHaveBeenCalledWith('/api/lugos/project-snapshot')
    expect(container.querySelector('form')).toBeNull()
    expect(container.querySelector('[contenteditable]')).toBeNull()
  })

  it('refuses an unrecognized payload instead of partially rendering it', async () => {
    apiFetch.mockResolvedValue({ ...PROJECT_SNAPSHOT_VIEW, trusted: false })

    render(<ProjectSnapshotPanel />)

    expect(await screen.findByText('TORC returned an unrecognized snapshot payload')).toBeTruthy()
    expect(screen.queryByText('consumer-ready')).toBeNull()
  })
})
