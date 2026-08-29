import { createPublicKey, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  assertParameterFreeRemoteDecision,
  canonicalDigest,
  capsuleSigningBytes,
  remoteDecisionCapsuleSchema,
  remoteDecisionRequestSchema,
} from './remote-decision-contract'

const frozenCapsule = {
  action_id: 'action-fixture-1',
  actor_id: 'mc:user:42',
  audience: 'fade-weir-remote-decision',
  capsule_id: 'capsule-fixture-approve',
  command_id: 'command-fixture-approve',
  decision: 'approve',
  device_id: 'workstation-4070pc',
  expires_at: '2026-08-28T20:01:00+00:00',
  issued_at: '2026-08-28T20:00:00+00:00',
  issuer_id: 'lugos-relay-issuer',
  key_id: 'relay-key-2026-08',
  nonce: 'AAECAwQFBgcICQoLDA0ODw',
  proposal_hash: 'sha256:afb0208ce2d6499416fdf686e16b7d21b35440acded688e45b29cfb243239d2f',
  schema: 'weir.remote-decision-capsule/v1',
  signature: 'DceZzd4RzTR6jGhNaAvqWgeBYxDGI1KX4zXAyaqs7tmJjjnQK_AEiWi9NLUno9x34rbZYrFfAtnLp0235tE-Bw',
  step_up_ref: 'sha256:da66321b0c44cfb8ea48938cf1140d52c3f146fece0339afb9c2530998a42074',
  work_context_hash: 'sha256:677c86008a0e230d6bdc0e4aa41886cc7849be1c5c9255e4bce98c1d989b4158',
} as const

describe('remote decision contract', () => {
  it('matches the frozen WEIR canonical hash and Ed25519 vector', () => {
    const capsule = remoteDecisionCapsuleSchema.parse(frozenCapsule)
    expect(canonicalDigest(capsule))
      .toBe('sha256:78010eaebc33c025695842602d4691712602ae333dde4ebdf438784f1d103f70')
    const rawPublicKey = Buffer.from(
      'ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ',
      'base64url',
    )
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        rawPublicKey,
      ]),
      format: 'der',
      type: 'spki',
    })
    expect(verify(
      null,
      capsuleSigningBytes(capsule),
      publicKey,
      Buffer.from(capsule.signature, 'base64url'),
    )).toBe(true)
  })

  it('rejects parameter and generic payload channels', () => {
    expect(() => remoteDecisionCapsuleSchema.parse({
      ...frozenCapsule,
      parameters: { value: 'forbidden' },
    })).toThrow()
    expect(() => remoteDecisionRequestSchema.parse({
      schema: 'mc.remote-decision-request/v1',
      idempotency_key: 'command-fixture-approve',
      decision: 'approve',
      proposal_hash: frozenCapsule.proposal_hash,
      action_id: frozenCapsule.action_id,
      work_context_hash: frozenCapsule.work_context_hash,
      device_id: frozenCapsule.device_id,
      payload: {},
    })).toThrow()
    expect(() => assertParameterFreeRemoteDecision({ payload: {} })).toThrow()
  })

  it('rejects lifetimes beyond the frozen 120-second bound', () => {
    expect(() => remoteDecisionCapsuleSchema.parse({
      ...frozenCapsule,
      expires_at: '2026-08-28T20:02:01+00:00',
    })).toThrow(/lifetime/i)
  })
})
