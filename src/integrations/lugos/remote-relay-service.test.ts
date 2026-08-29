import { afterEach, describe, expect, it, vi } from 'vitest'
import type { User } from '@/lib/auth'
import { weirSnapshotSchema } from './operator-contract'
import fixture from './__tests__/weir-projection-v1.json'
import {
  configuredActorIdForUser,
  configuredRemoteDecisionDeviceId,
  RemoteDecisionUnavailableError,
  submitRemoteDecision,
  type RemoteDecisionDependencies,
} from './remote-relay-service'

const projection = weirSnapshotSchema.parse({
  ...fixture.operator_snapshot.projections[0].value,
  generatedAt: new Date().toISOString(),
  actions: fixture.operator_snapshot.projections[0].value.actions.map(action => ({
    ...action,
    occurred_at: new Date().toISOString(),
  })),
})
const action = projection.actions[0]
const requestInput = {
  schema: 'mc.remote-decision-request/v1',
  idempotency_key: 'remote-command-fixture-1',
  decision: 'approve',
  proposal_hash: action.proposal_hash,
  action_id: action.action_id,
  work_context_hash: action.work_context_hash,
  device_id: 'workstation-4070pc',
} as const
const user = {
  id: 42,
  username: 'operator-fixture',
  display_name: 'Operator Fixture',
  role: 'operator',
  workspace_id: 1,
  tenant_id: 1,
  created_at: 0,
  updated_at: 0,
  last_login_at: null,
} satisfies User

function dependencies(): RemoteDecisionDependencies {
  return {
    reloadWeirProjection: vi.fn().mockResolvedValue(projection),
    actorIdForUser: vi.fn().mockReturnValue('mc:user:42'),
    expectedDeviceId: vi.fn().mockReturnValue('workstation-4070pc'),
    verifyStepUp: vi.fn().mockResolvedValue({
      step_up_ref: 'sha256:' + 'a'.repeat(64),
    }),
    enqueue: vi.fn().mockImplementation(async input => ({
      schema: 'weir.remote-decision-capsule/v1',
      key_id: 'relay-key-fixture',
      issuer_id: 'lugos-relay-issuer',
      capsule_id: 'capsule-fixture-1',
      ...input,
      issued_at: '2026-08-28T20:00:00+00:00',
      expires_at: '2026-08-28T20:01:00+00:00',
      nonce: 'AAECAwQFBgcICQoLDA0ODw',
      signature: 'A'.repeat(86),
    })),
  }
}

describe('remote relay service', () => {
  const originalEnv = process.env

  afterEach(() => {
    process.env = originalEnv
  })

  it('does no projection, step-up, signature, or queue work while disabled', async () => {
    const deps = dependencies()
    await expect(submitRemoteDecision(
      requestInput,
      new Request('http://localhost/api/lugos/remote-decisions'),
      user,
      deps,
      false,
    )).rejects.toMatchObject({ code: 'remote_decisions_disabled' })
    expect(deps.reloadWeirProjection).not.toHaveBeenCalled()
    expect(deps.verifyStepUp).not.toHaveBeenCalled()
    expect(deps.enqueue).not.toHaveBeenCalled()
  })

  it('reloads the exact projection before binding actor and step-up evidence', async () => {
    const deps = dependencies()
    const capsule = await submitRemoteDecision(
      requestInput,
      new Request('http://localhost/api/lugos/remote-decisions'),
      user,
      deps,
      true,
    )
    expect(capsule.actor_id).toBe('mc:user:42')
    expect(deps.verifyStepUp).toHaveBeenCalledWith(expect.objectContaining({
      user,
      binding_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    }))
    expect(deps.enqueue).toHaveBeenCalledWith({
      command_id: requestInput.idempotency_key,
      actor_id: 'mc:user:42',
      audience: 'fade-weir-remote-decision',
      device_id: requestInput.device_id,
      decision: requestInput.decision,
      proposal_hash: requestInput.proposal_hash,
      action_id: requestInput.action_id,
      work_context_hash: requestInput.work_context_hash,
      step_up_ref: 'sha256:' + 'a'.repeat(64),
    })
  })

  it('rejects stale bindings before step-up or enqueue', async () => {
    const deps = dependencies()
    await expect(submitRemoteDecision(
      { ...requestInput, action_id: 'action-substituted' },
      new Request('http://localhost/api/lugos/remote-decisions'),
      user,
      deps,
      true,
    )).rejects.toMatchObject({ code: 'remote_proposal_binding_mismatch' })
    expect(deps.verifyStepUp).not.toHaveBeenCalled()
    expect(deps.enqueue).not.toHaveBeenCalled()
  })

  it('rejects an aged or future proposal before step-up or enqueue', async () => {
    const stale = dependencies()
    vi.mocked(stale.reloadWeirProjection).mockResolvedValue({
      ...projection,
      actions: projection.actions.map(item => ({
        ...item,
        occurred_at: new Date(Date.now() - 601_000).toISOString(),
      })),
    })
    await expect(submitRemoteDecision(
      requestInput,
      new Request('http://localhost/api/lugos/remote-decisions'),
      user,
      stale,
      true,
    )).rejects.toMatchObject({ code: 'remote_proposal_stale' })
    expect(stale.verifyStepUp).not.toHaveBeenCalled()
    expect(stale.enqueue).not.toHaveBeenCalled()

    const future = dependencies()
    vi.mocked(future.reloadWeirProjection).mockResolvedValue({
      ...projection,
      actions: projection.actions.map(item => ({
        ...item,
        occurred_at: new Date(Date.now() + 6_000).toISOString(),
      })),
    })
    await expect(submitRemoteDecision(
      requestInput,
      new Request('http://localhost/api/lugos/remote-decisions'),
      user,
      future,
      true,
    )).rejects.toMatchObject({ code: 'remote_proposal_stale' })
  })

  it('accepts the frozen five-second proposal clock skew', async () => {
    const deps = dependencies()
    vi.mocked(deps.reloadWeirProjection).mockResolvedValue({
      ...projection,
      actions: projection.actions.map(item => ({
        ...item,
        occurred_at: new Date(Date.now() + 4_000).toISOString(),
      })),
    })
    await expect(submitRemoteDecision(
      requestInput,
      new Request('http://localhost/api/lugos/remote-decisions'),
      user,
      deps,
      true,
    )).resolves.toMatchObject({ command_id: requestInput.idempotency_key })
  })

  it('rejects device ids that are unsafe to carry across services', () => {
    expect(configuredRemoteDecisionDeviceId({
      MC_REMOTE_DEVICE_ID: 'workstation-4070pc',
    })).toBe('workstation-4070pc')
    expect(() => configuredRemoteDecisionDeviceId({
      MC_REMOTE_DEVICE_ID: '../workstation',
    })).toThrow(RemoteDecisionUnavailableError)
    expect(() => configuredRemoteDecisionDeviceId({
      MC_REMOTE_DEVICE_ID: 'workstation 4070pc',
    })).toThrow(RemoteDecisionUnavailableError)
  })

  it('rejects invalid step-up references and passthrough fields', async () => {
    const deps = dependencies()
    vi.mocked(deps.verifyStepUp).mockResolvedValue({ step_up_ref: 'not-a-digest' })
    await expect(submitRemoteDecision(
      requestInput,
      new Request('http://localhost/api/lugos/remote-decisions'),
      user,
      deps,
      true,
    )).rejects.toMatchObject({ code: 'remote_step_up_invalid' })
    expect(deps.enqueue).not.toHaveBeenCalled()

    await expect(submitRemoteDecision(
      { ...requestInput, parameters: { value: 'forbidden' } },
      new Request('http://localhost/api/lugos/remote-decisions'),
      user,
      dependencies(),
      true,
    )).rejects.toThrow()
  })

  it('keeps actor formatting an explicit activation decision', () => {
    process.env = { ...originalEnv }
    delete process.env.MC_REMOTE_ACTOR_FORMAT
    expect(() => configuredActorIdForUser(user)).toThrow(
      new RemoteDecisionUnavailableError('remote_actor_format_unconfigured'),
    )
    process.env.MC_REMOTE_ACTOR_FORMAT = 'mc-user-numeric-v1'
    expect(configuredActorIdForUser(user)).toBe('mc:user:42')
    expect(configuredActorIdForUser({ ...user, id: 84 })).toBe('mc:user:84')
  })
})
