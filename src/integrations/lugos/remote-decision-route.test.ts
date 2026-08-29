import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixture from './__tests__/weir-projection-v1.json'

const {
  requireRoleMock,
  fetchOperatorSnapshotMock,
  verifyRemoteDecisionStepUpMock,
  enqueueRemoteDecisionMock,
} = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  fetchOperatorSnapshotMock: vi.fn(),
  verifyRemoteDecisionStepUpMock: vi.fn(),
  enqueueRemoteDecisionMock: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }))
vi.mock('@/integrations/lugos/operator-client', () => ({
  fetchOperatorSnapshot: fetchOperatorSnapshotMock,
}))
vi.mock('@/lib/webauthn/remote-step-up', () => ({
  verifyRemoteDecisionStepUp: verifyRemoteDecisionStepUpMock,
}))
vi.mock('@/integrations/lugos/remote-relay-client', () => ({
  enqueueRemoteDecision: enqueueRemoteDecisionMock,
}))

import { POST } from '@/app/api/lugos/remote-decisions/route'

const action = fixture.operator_snapshot.projections[0].value.actions[0]
const input = {
  schema: 'mc.remote-decision-request/v1',
  idempotency_key: 'remote-command-fixture-1',
  decision: 'approve',
  proposal_hash: action.proposal_hash,
  action_id: action.action_id,
  work_context_hash: action.work_context_hash,
  device_id: 'workstation-4070pc',
}
const capsule = {
  schema: 'weir.remote-decision-capsule/v1',
  key_id: 'relay-key-fixture',
  issuer_id: 'lugos-relay-issuer',
  capsule_id: 'capsule-fixture-1',
  command_id: input.idempotency_key,
  actor_id: 'mc:user:42',
  audience: 'fade-weir-remote-decision',
  device_id: input.device_id,
  decision: input.decision,
  proposal_hash: input.proposal_hash,
  action_id: input.action_id,
  work_context_hash: input.work_context_hash,
  issued_at: '2026-08-28T20:00:00+00:00',
  expires_at: '2026-08-28T20:01:00+00:00',
  nonce: 'AAECAwQFBgcICQoLDA0ODw',
  step_up_ref: 'sha256:' + 'a'.repeat(64),
  signature: 'A'.repeat(86),
}

function request(body: unknown): Request {
  return new Request('http://localhost/api/lugos/remote-decisions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('Mission Control remote decision route', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.clearAllMocks()
    process.env = { ...originalEnv }
    delete process.env.MC_REMOTE_DECISIONS_ENABLED
    delete process.env.MC_REMOTE_ACTOR_FORMAT
    requireRoleMock.mockReturnValue({
      user: {
        id: 42,
        username: 'operator-fixture',
        display_name: 'Operator Fixture',
        role: 'operator',
        workspace_id: 1,
        tenant_id: 1,
        created_at: 0,
        updated_at: 0,
        last_login_at: null,
      },
    })
    fetchOperatorSnapshotMock.mockResolvedValue(fixture.operator_snapshot)
    verifyRemoteDecisionStepUpMock.mockResolvedValue({
      step_up_ref: 'sha256:' + 'a'.repeat(64),
    })
    enqueueRemoteDecisionMock.mockResolvedValue(capsule)
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns 404 and performs no auth, read, step-up, or enqueue while off', async () => {
    const response = await POST(request({ parameters: { value: 'ignored while off' } }))
    expect(response.status).toBe(404)
    expect(requireRoleMock).not.toHaveBeenCalled()
    expect(fetchOperatorSnapshotMock).not.toHaveBeenCalled()
    expect(verifyRemoteDecisionStepUpMock).not.toHaveBeenCalled()
    expect(enqueueRemoteDecisionMock).not.toHaveBeenCalled()
  })

  it('requires an operator before reading current WEIR state', async () => {
    process.env.MC_REMOTE_DECISIONS_ENABLED = 'true'
    requireRoleMock.mockReturnValue({
      error: 'Requires operator role or higher',
      status: 403,
    })
    const response = await POST(request(input))
    expect(response.status).toBe(403)
    expect(requireRoleMock).toHaveBeenCalledWith(expect.any(Request), 'operator')
    expect(fetchOperatorSnapshotMock).not.toHaveBeenCalled()
    expect(enqueueRemoteDecisionMock).not.toHaveBeenCalled()
  })

  it('fails closed when actor format or step-up provider is not configured', async () => {
    process.env.MC_REMOTE_DECISIONS_ENABLED = 'true'
    const noActor = await POST(request(input))
    expect(noActor.status).toBe(503)
    expect(await noActor.json()).toEqual({ error: 'remote_actor_format_unconfigured' })
    expect(verifyRemoteDecisionStepUpMock).not.toHaveBeenCalled()
    expect(enqueueRemoteDecisionMock).not.toHaveBeenCalled()

    process.env.MC_REMOTE_ACTOR_FORMAT = 'mc-user-numeric-v1'
    verifyRemoteDecisionStepUpMock.mockRejectedValueOnce(
      new Error('provider unavailable'),
    )
    const noStepUp = await POST(request(input))
    expect(noStepUp.status).toBe(503)
    expect(enqueueRemoteDecisionMock).not.toHaveBeenCalled()
  })

  it('enqueues only the exact reloaded binding after step-up', async () => {
    process.env.MC_REMOTE_DECISIONS_ENABLED = 'true'
    process.env.MC_REMOTE_ACTOR_FORMAT = 'mc-user-numeric-v1'
    const response = await POST(request(input))
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual(capsule)
    expect(fetchOperatorSnapshotMock).toHaveBeenCalledOnce()
    expect(verifyRemoteDecisionStepUpMock).toHaveBeenCalledOnce()
    expect(enqueueRemoteDecisionMock).toHaveBeenCalledWith({
      command_id: input.idempotency_key,
      actor_id: 'mc:user:42',
      audience: 'fade-weir-remote-decision',
      device_id: input.device_id,
      decision: input.decision,
      proposal_hash: input.proposal_hash,
      action_id: input.action_id,
      work_context_hash: input.work_context_hash,
      step_up_ref: 'sha256:' + 'a'.repeat(64),
    })
  })

  it('rejects passthrough fields before projection reload or enqueue', async () => {
    process.env.MC_REMOTE_DECISIONS_ENABLED = 'true'
    process.env.MC_REMOTE_ACTOR_FORMAT = 'mc-user-numeric-v1'
    const response = await POST(request({
      ...input,
      parameters: { value: 'forbidden' },
    }))
    expect(response.status).toBe(400)
    expect(fetchOperatorSnapshotMock).not.toHaveBeenCalled()
    expect(enqueueRemoteDecisionMock).not.toHaveBeenCalled()
  })
})
