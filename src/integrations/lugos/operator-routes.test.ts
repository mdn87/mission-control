import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeReceipt, makeSnapshot } from './__tests__/fixtures'
import {
  makeBranReadinessProjection,
  makeDiagnosticsProjection,
  makeFleetProjection,
  makeNetworkDevicesProjection,
} from './__tests__/cockpit-fixtures'

const {
  requireRoleMock,
  fetchOperatorSnapshotMock,
  openOperatorEventStreamMock,
  sendOperatorCommandMock,
  fetchOperatorModelBudgetsMock,
  observePaidModelBudgetsMock,
} = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  fetchOperatorSnapshotMock: vi.fn(),
  openOperatorEventStreamMock: vi.fn(),
  sendOperatorCommandMock: vi.fn(),
  fetchOperatorModelBudgetsMock: vi.fn(),
  observePaidModelBudgetsMock: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }))
vi.mock('@/integrations/lugos/operator-client', () => ({
  fetchOperatorSnapshot: fetchOperatorSnapshotMock,
  openOperatorEventStream: openOperatorEventStreamMock,
  sendOperatorCommand: sendOperatorCommandMock,
  fetchOperatorModelBudgets: fetchOperatorModelBudgetsMock,
}))
vi.mock('@/lib/paid-model-observability', () => ({
  observePaidModelBudgets: observePaidModelBudgetsMock,
}))

import { GET as getSnapshot } from '@/app/api/lugos/snapshot/route'
import { GET as getDestinations } from '@/app/api/lugos/destinations/route'
import { GET as getEvents } from '@/app/api/lugos/events/route'
import { POST as postCommand } from '@/app/api/lugos/commands/route'
import { GET as getModelBudgets } from '@/app/api/lugos/model-budgets/route'
import { DEEPSEEK_CHAT_MODEL, GROK_CHAT_MODEL, LOCAL_CHAT_MODEL } from './model-budgets'

describe('Mission Control Lugos route boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireRoleMock.mockReturnValue({ user: { role: 'admin' } })
    fetchOperatorSnapshotMock.mockResolvedValue(makeSnapshot())
    openOperatorEventStreamMock.mockResolvedValue(new Response(new ReadableStream()))
    sendOperatorCommandMock.mockResolvedValue(makeReceipt())
    fetchOperatorModelBudgetsMock.mockResolvedValue({
      schema: 'lugos-model-budgets/v1',
      generatedAt: '2026-08-08T23:10:00.000Z',
      staleAfterSeconds: 120,
      defaultModel: LOCAL_CHAT_MODEL,
      lanes: [
        { id: 'deepseek', label: 'DeepSeek', model: DEEPSEEK_CHAT_MODEL, provider: 'NVIDIA', paid: true, maxBudgetUsd: 2, maxOutputTokens: 2048, spendUsd: 0, remainingUsd: 2, percentUsed: 0, budgetDuration: '30d', resetAt: null, status: 'healthy' },
        { id: 'grok', label: 'Grok', model: GROK_CHAT_MODEL, provider: 'xAI', paid: true, maxBudgetUsd: 2, maxOutputTokens: 2048, spendUsd: 0, remainingUsd: 2, percentUsed: 0, budgetDuration: '30d', resetAt: null, status: 'healthy' },
      ],
    })
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

  it('operator-gates the sanitized paid-model budget projection', async () => {
    const response = await getModelBudgets(new Request('http://localhost/api/lugos/model-budgets'))
    expect(response.status).toBe(200)
    expect(requireRoleMock).toHaveBeenCalledWith(expect.any(Request), 'operator')
    expect(fetchOperatorModelBudgetsMock).toHaveBeenCalledOnce()
    expect(observePaidModelBudgetsMock).toHaveBeenCalledOnce()

    requireRoleMock.mockReturnValue({ error: 'Requires operator role or higher', status: 403 })
    const denied = await getModelBudgets(new Request('http://localhost/api/lugos/model-budgets'))
    expect(denied.status).toBe(403)
    expect(fetchOperatorModelBudgetsMock).toHaveBeenCalledOnce()
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

describe('Mission Control network-devices route boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireRoleMock.mockReturnValue({ user: { role: 'viewer' } })
  })

  it('passes the network-devices projection through the viewer snapshot only when the cockpit flag is on', async () => {
    const previous = process.env.MC_LUGOS_COCKPIT
    fetchOperatorSnapshotMock.mockResolvedValue(makeSnapshot({
      projections: [
        ...makeSnapshot().projections,
        { name: 'network-devices', value: makeNetworkDevicesProjection() },
      ],
    }))
    try {
      process.env.MC_LUGOS_COCKPIT = '1'
      const enabled = await getSnapshot(new Request('http://localhost/api/lugos/snapshot'))
      const body = await enabled.json()
      expect(body.projections.map((item: { name: string }) => item.name)).toEqual(['autowork', 'network-devices'])
      expect(JSON.stringify(body)).not.toContain('notes')
      process.env.MC_LUGOS_COCKPIT = '0'
      const disabled = await getSnapshot(new Request('http://localhost/api/lugos/snapshot'))
      expect((await disabled.json()).projections.map((item: { name: string }) => item.name)).toEqual(['autowork'])
    } finally {
      if (previous === undefined) delete process.env.MC_LUGOS_COCKPIT
      else process.env.MC_LUGOS_COCKPIT = previous
    }
  })

  it('forwards device commands only from an operator session', async () => {
    requireRoleMock.mockReturnValue({ user: { role: 'operator' } })
    sendOperatorCommandMock.mockResolvedValue(makeReceipt({ type: 'device.merge' }))
    const response = await postCommand(new Request('http://localhost/api/lugos/commands', {
      method: 'POST',
      body: JSON.stringify({
        schema: 'lugos-operator-command/v1',
        type: 'device.merge',
        idempotency_key: 'mc-merge-1',
        payload: { source_device_id: 'dev-769335c39dd4', into_device_id: '4070pc' },
      }),
    }))
    expect(response.status).toBe(202)
    expect(sendOperatorCommandMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'device.merge' }))

    const invalid = await postCommand(new Request('http://localhost/api/lugos/commands', {
      method: 'POST',
      body: JSON.stringify({
        schema: 'lugos-operator-command/v1',
        type: 'reservation.apply',
        idempotency_key: 'mc-res-1',
        payload: { device_id: '4070pc', address: '10.0.1.30' },
      }),
    }))
    expect(invalid.status).toBe(400)
  })
})
