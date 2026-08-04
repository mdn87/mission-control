import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeReceipt, makeSnapshot } from './__tests__/fixtures'
import {
  makeBranReadinessProjection,
  makeDiagnosticsProjection,
  makeFleetProjection,
} from './__tests__/cockpit-fixtures'

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
import { GET as getDestinations } from '@/app/api/lugos/destinations/route'
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

  it('applies the cockpit flag at request time without changing legacy projections', async () => {
    const previous = process.env.MC_LUGOS_COCKPIT
    const snapshot = makeSnapshot({
      projections: [
        ...makeSnapshot().projections,
        { name: 'fleet', value: makeFleetProjection() },
        { name: 'cockpit-diagnostics', value: makeDiagnosticsProjection() },
        { name: 'bran-readiness', value: makeBranReadinessProjection() },
      ],
    })
    fetchOperatorSnapshotMock.mockResolvedValue(snapshot)
    try {
      process.env.MC_LUGOS_COCKPIT = '0'
      const disabled = await getSnapshot(new Request('http://localhost/api/lugos/snapshot'))
      expect((await disabled.json()).projections.map(
        (item: { name: string }) => item.name,
      )).toEqual(['autowork'])

      process.env.MC_LUGOS_COCKPIT = '1'
      const enabled = await getSnapshot(new Request('http://localhost/api/lugos/snapshot'))
      expect((await enabled.json()).projections.map(
        (item: { name: string }) => item.name,
      )).toEqual(['autowork', 'fleet', 'cockpit-diagnostics', 'bran-readiness'])
    } finally {
      if (previous === undefined) delete process.env.MC_LUGOS_COCKPIT
      else process.env.MC_LUGOS_COCKPIT = previous
    }
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

  it('viewer-gates specialist destinations and serves only runtime-approved public links', async () => {
    const previousFlag = process.env.MC_LUGOS_COCKPIT
    const previousFiles = process.env.MC_LUGOS_FILES_PUBLIC_URL
    try {
      process.env.MC_LUGOS_COCKPIT = '1'
      process.env.MC_LUGOS_FILES_PUBLIC_URL = 'https://files.newman.foo'
      const response = await getDestinations(new Request('http://localhost/api/lugos/destinations'))
      expect(response.status).toBe(200)
      expect(requireRoleMock).toHaveBeenCalledWith(expect.any(Request), 'viewer')
      const body = await response.json()
      expect(body.destinations.find((item: { id: string }) => item.id === 'files').href)
        .toBe('https://files.newman.foo/')
    } finally {
      if (previousFlag === undefined) delete process.env.MC_LUGOS_COCKPIT
      else process.env.MC_LUGOS_COCKPIT = previousFlag
      if (previousFiles === undefined) delete process.env.MC_LUGOS_FILES_PUBLIC_URL
      else process.env.MC_LUGOS_FILES_PUBLIC_URL = previousFiles
    }
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

  it('forwards a validated Agent Mail handoff without widening its artifact contract', async () => {
    const command = {
      schema: 'lugos-operator-command/v1',
      type: 'mail.handoff',
      idempotency_key: 'mc-command-mail-0001',
      payload: {
        from_agent: '4070pc/mission-control',
        to_agent: '4070pc/codex',
        subject: 'Week 4 proof',
        body: 'Approve one bounded artifact.',
        artifact: { repo: 'lugos', path: 'week4/task-loop.json' },
      },
    }
    const response = await postCommand(new Request('http://localhost/api/lugos/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
    }))
    expect(response.status).toBe(202)
    expect(sendOperatorCommandMock).toHaveBeenCalledWith(command)
  })

  it('rejects command passthrough fields before contacting Lugos', async () => {
    const response = await postCommand(new Request('http://localhost/api/lugos/commands', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: 'lugos-operator-command/v1',
        type: 'task.approve',
        idempotency_key: 'mc-command-approve-0001',
        payload: {
          loop_id: 'mail:41',
          decision: 'approved',
          shell: 'arbitrary passthrough',
        },
      }),
    }))
    expect(response.status).toBe(400)
    expect(sendOperatorCommandMock).not.toHaveBeenCalled()
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
