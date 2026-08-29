import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  canonicalDigest,
  capsuleSigningBytes,
} from './remote-decision-contract'
import { RemoteRelaySigner } from './relay-signer'

const privateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)),
  ]),
  format: 'der',
  type: 'pkcs8',
})
const publicKey = createPublicKey({
  key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from('ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ', 'base64url'),
  ]),
  format: 'der',
  type: 'spki',
})
const input = {
  command_id: 'command-fixture-1',
  actor_id: 'mc:user:42',
  audience: 'fade-weir-remote-decision' as const,
  device_id: 'workstation-4070pc',
  decision: 'approve' as const,
  proposal_hash: canonicalDigest({ proposal: 1 }),
  action_id: 'action-fixture-1',
  work_context_hash: canonicalDigest({ context: 1 }),
  step_up_ref: canonicalDigest({ webauthn: 1 }),
}

describe('remote relay signer', () => {
  it('does not read a key or sign while its flag is off', () => {
    const activeSigningKey = vi.fn()
    const signer = new RemoteRelaySigner(
      { activeSigningKey },
      { enabled: () => false },
    )
    expect(() => signer.sign(input)).toThrow(/relay_issuer_disabled/)
    expect(activeSigningKey).not.toHaveBeenCalled()
  })

  it('signs the exact canonical capsule without accepting parameters', () => {
    const signer = new RemoteRelaySigner({
      activeSigningKey: () => ({
        key_id: 'relay-key-fixture',
        issuer_id: 'lugos-relay-issuer',
        private_key: privateKey,
      }),
    }, {
      enabled: () => true,
      clock: () => new Date('2026-08-28T20:00:00.000Z'),
      nonce: () => 'AAECAwQFBgcICQoLDA0ODw',
      capsuleId: () => 'capsule-fixture-1',
      lifetimeSeconds: 60,
    })
    const capsule = signer.sign(input)
    expect(capsule).toMatchObject({
      command_id: input.command_id,
      actor_id: input.actor_id,
      proposal_hash: input.proposal_hash,
      action_id: input.action_id,
      work_context_hash: input.work_context_hash,
    })
    expect(verify(
      null,
      capsuleSigningBytes(capsule),
      publicKey,
      Buffer.from(capsule.signature, 'base64url'),
    )).toBe(true)
    expect(JSON.stringify(capsule)).not.toMatch(
      /parameters|payload|credentials|cookies|permit/,
    )
    expect(() => signer.sign({
      ...input,
      parameters: {},
    } as typeof input)).toThrow()
  })

  it('rejects non-Ed25519 key material and excessive lifetimes', () => {
    expect(() => new RemoteRelaySigner(
      { activeSigningKey: () => {
        throw new Error('unused')
      } },
      { lifetimeSeconds: 121 },
    )).toThrow(/lifetime/)
    const rsaKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    const signer = new RemoteRelaySigner({
      activeSigningKey: () => ({
        key_id: 'bad-key',
        issuer_id: 'lugos-relay-issuer',
        private_key: rsaKey,
      }),
    }, { enabled: () => true })
    expect(() => signer.sign(input)).toThrow(/relay_signing_key_invalid/)
  })
})
