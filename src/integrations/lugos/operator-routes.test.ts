import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeReceipt, makeSnapshot } from './__tests__/fixtures'

const {
  requireRoleMock,
  fetchOperatorSnapshotMock,
  openOperatorEventStreamMock,
  sendOperatorCommandMock,
} = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  fetchOperatorSnapshotMock: vi.fn(),
  openOperatorEventStreamMock: vi.fn(),
  sendOperatorCommandMock: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }))
vi.mock('@/integrations/lugos/operator-client', () => ({
  fetchOperatorSnapshot: fetchOperatorSnapshotMock,
  openOperatorEventStream: openOperatorEventStreamMock,
  sendOperatorCommand: sendOperatorCommandMock,
}))

import { GET as getSnapshot } from '@/app/api/lugos/snapshot/route'
import { GET as getEvents } from '@/app/api/lugos/events/route'
import { POST as postCommand } from '@/app/api/lugos/commands/route'

describe('Mission Control Lugos route boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireRoleMock.mockReturnValue({ user: { role: 'admin' } })
    fetchOperatorSnapshotMock.mockResolvedValue(makeSnapshot())
    openOperatorEventStreamMock.mockResolvedValue(new Response(new ReadableStream()))
    sendOperatorCommandMock.mockResolvedValue(makeReceipt())
  })

  it('confines snapshot reads to a Mission Control viewer session', async () => {
    const response = await getSnapshot(new Request('http://localhost/api/lugos/snapshot'))
    expect(response.status).toBe(200)
    expect(requireRoleMock).toHaveBeenCalledWith(expect.any(Request), 'viewer')
    expect(fetchOperatorSnapshotMock).toHaveBeenCalledOnce()
  })

  it('confines commands to a Mission Control operator session', async () => {
    requireRoleMock.mockReturnValue({ error: 'Requires operator role or higher', status: 403 })
    const response = await postCommand(new Request('http://localhost/api/lugos/commands', {
      method: 'POST',
      body: JSON.stringify({}),
    }))
    expect(response.status).toBe(403)
    expect(requireRoleMock).toHaveBeenCalledWith(expect.any(Request), 'operator')
    expect(sendOperatorCommandMock).not.toHaveBeenCalled()
  })

  it('forwards only a validated approval request to the Lugos client', async () => {
    const command = {
      schema: 'lugos-operator-command/v1',
      type: 'approval.request',
      idempotency_key: 'mc-command-0001',
      payload: { subject: 'week-2', summary: 'Issue a durable receipt.' },
    }
    const response = await postCommand(new Request('http://localhost/api/lugos/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    }))
    expect(response.status).toBe(202)
    expect(sendOperatorCommandMock).toHaveBeenCalledWith(command)
  })

  it('role-gates replay and passes only a validated cursor upstream', async () => {
    const response = await getEvents(new Request(
      'http://localhost/api/lugos/events?after=event-0002',
    ))
    expect(response.status).toBe(200)
    expect(requireRoleMock).toHaveBeenCalledWith(expect.any(Request), 'viewer')
    expect(openOperatorEventStreamMock)
      .toHaveBeenCalledWith('event-0002', expect.any(AbortSignal))
  })

  it('rejects an invalid replay cursor before contacting Lugos', async () => {
    const response = await getEvents(new Request(
      'http://localhost/api/lugos/events?after=bad%20cursor',
    ))
    expect(response.status).toBe(400)
    expect(openOperatorEventStreamMock).not.toHaveBeenCalled()
  })
})
