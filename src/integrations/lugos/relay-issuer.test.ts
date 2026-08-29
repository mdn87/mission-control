import { createPrivateKey, createPublicKey, verify } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalDigest,
  capsuleSigningBytes,
  type RemoteDecisionCapsule,
} from './remote-decision-contract'
import { RemoteRelayIssuer } from './relay-issuer'
import { RemoteRelayQueue } from './relay-queue'
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

describe('remote relay issuer', () => {
  const databases: Database.Database[] = []

  afterEach(() => {
    for (const db of databases) db.close()
    databases.length = 0
  })

  it('returns the original capsule after a lost enqueue response', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    databases.push(db)
    const activeSigningKey = vi.fn().mockReturnValue({
      key_id: 'relay-key-fixture',
      issuer_id: 'lugos-relay-issuer',
      private_key: privateKey,
    })
    let capsuleSequence = 0
    const signer = new RemoteRelaySigner({ activeSigningKey }, {
      enabled: () => true,
      clock: () => new Date('2026-08-28T20:00:00.000Z'),
      nonce: () => 'AAECAwQFBgcICQoLDA0ODw',
      capsuleId: () => `capsule-fixture-${++capsuleSequence}`,
    })
    const verifyCapsule = (capsule: RemoteDecisionCapsule) => {
      if (!verify(
        null,
        capsuleSigningBytes(capsule),
        publicKey,
        Buffer.from(capsule.signature, 'base64url'),
      )) throw new Error('invalid signature')
    }
    const queue = new RemoteRelayQueue(db, {
      databasePurpose: 'remote-relay-isolated-v1',
      enabled: true,
      clock: () => new Date('2026-08-28T20:00:00.000Z'),
      verifyCapsule,
    })
    const issuer = new RemoteRelayIssuer(signer, queue)

    const first = issuer.enqueue(input)
    const replay = issuer.enqueue(input)
    expect(replay).toEqual(first)
    expect(activeSigningKey).toHaveBeenCalledOnce()
    expect(capsuleSequence).toBe(1)

    expect(() => issuer.enqueue({ ...input, decision: 'deny' }))
      .toThrow(/relay_command_conflict/)
    expect(activeSigningKey).toHaveBeenCalledOnce()
    expect(() => issuer.enqueue({
      ...input,
      payload: {},
    } as typeof input)).toThrow()
    expect(activeSigningKey).toHaveBeenCalledOnce()
  })
})
