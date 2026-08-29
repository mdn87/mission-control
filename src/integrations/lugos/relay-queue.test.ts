import { createPrivateKey, createPublicKey, verify } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  capsuleSigningBytes,
  canonicalDigest,
  REMOTE_DECISION_ACK_SCHEMA,
  REMOTE_DECISION_REVOCATION_SCHEMA,
  type RemoteDecisionAcknowledgement,
  type RemoteDecisionRevocation,
} from './remote-decision-contract'
import { RelayQueueError, RemoteRelayQueue } from './relay-queue'
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

function capsule(options: {
  commandId?: string
  capsuleId?: string
  nonce?: string
  decision?: 'approve' | 'deny'
  clock?: Date
} = {}) {
  const signer = new RemoteRelaySigner({
    activeSigningKey: () => ({
      key_id: 'relay-key-fixture',
      issuer_id: 'lugos-relay-issuer',
      private_key: privateKey,
    }),
  }, {
    enabled: () => true,
    clock: () => options.clock ?? new Date('2026-08-28T20:00:00.000Z'),
    capsuleId: () => options.capsuleId ?? 'capsule-fixture-1',
    nonce: () => options.nonce ?? 'AAECAwQFBgcICQoLDA0ODw',
    lifetimeSeconds: 60,
  })
  return signer.sign({
    ...input,
    command_id: options.commandId ?? input.command_id,
    decision: options.decision ?? input.decision,
  })
}

function acknowledgement(
  acknowledgedAt = '2026-08-28T20:00:14.000Z',
): RemoteDecisionAcknowledgement {
  const basis = {
    schema: REMOTE_DECISION_ACK_SCHEMA as typeof REMOTE_DECISION_ACK_SCHEMA,
    acknowledgement_id: 'ack-fixture-1',
    capsule_id: 'capsule-fixture-1',
    command_id: input.command_id,
    actor_id: input.actor_id,
    device_id: input.device_id,
    transport_principal: 'relay-device:4070pc',
    outcome: 'completed' as const,
    receipt_hash: canonicalDigest({ receipt: 1 }),
    acknowledged_at: acknowledgedAt,
  }
  return { ...basis, acknowledgement_hash: canonicalDigest(basis) }
}

function revocation(): RemoteDecisionRevocation {
  const basis = {
    schema: REMOTE_DECISION_REVOCATION_SCHEMA as typeof REMOTE_DECISION_REVOCATION_SCHEMA,
    revocation_id: 'revocation-fixture-1',
    capsule_id: 'capsule-fixture-1',
    command_id: input.command_id,
    actor_id: input.actor_id,
    reason_code: 'operator_withdrew' as const,
    revoked_at: '2026-08-28T20:00:05.000Z',
  }
  return { ...basis, revocation_hash: canonicalDigest(basis) }
}

function verifyCapsule(value: ReturnType<typeof capsule>): void {
  if (!verify(
    null,
    capsuleSigningBytes(value),
    publicKey,
    Buffer.from(value.signature, 'base64url'),
  )) {
    throw new Error('invalid capsule signature')
  }
}

function enqueue(
  queue: RemoteRelayQueue,
  value: ReturnType<typeof capsule>,
) {
  return queue.enqueue(value, canonicalDigest({
    ...input,
    command_id: value.command_id,
    decision: value.decision,
  }))
}

describe('isolated remote relay queue', () => {
  const databases: Database.Database[] = []

  afterEach(() => {
    for (const db of databases) db.close()
    databases.length = 0
  })

  function database() {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    databases.push(db)
    return db
  }

  it('creates no schema while the issuer flag is off', () => {
    const db = database()
    expect(() => new RemoteRelayQueue(db, {
      databasePurpose: 'remote-relay-isolated-v1',
      enabled: false,
      verifyCapsule,
    })).toThrow(/relay_issuer_disabled/)
    const tables = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'relay_%'
    `).all()
    expect(tables).toEqual([])
  })

  it('enforces durable command, capsule, nonce, and capacity uniqueness', () => {
    const queue = new RemoteRelayQueue(database(), {
      databasePurpose: 'remote-relay-isolated-v1',
      enabled: true,
      liveLimit: 2,
      clock: () => new Date('2026-08-28T20:00:00.000Z'),
      verifyCapsule,
    })
    const first = capsule()
    expect(enqueue(queue, first).state).toBe('queued')
    expect(enqueue(queue, first).record_hash).toBe(queue.current(first.capsule_id).record_hash)
    expect(() => enqueue(queue, capsule({
      capsuleId: 'capsule-command-conflict',
      nonce: 'EBESExQVFhcYGRobHB0eHw',
      decision: 'deny',
    }))).toThrow(/relay_command_conflict/)
    expect(() => enqueue(queue, capsule({
      commandId: 'command-nonce-conflict',
      capsuleId: 'capsule-nonce-conflict',
    }))).toThrow(/relay_uniqueness_conflict/)
    expect(() => enqueue(queue, capsule({
      commandId: 'command-capacity',
      capsuleId: 'capsule-capacity',
      nonce: 'ICEiIyQlJicoKSorLC0uLw',
    }))).not.toThrow()
    expect(() => enqueue(queue, capsule({
      commandId: 'command-over-capacity',
      capsuleId: 'capsule-over-capacity',
      nonce: 'MDEyMzQ1Njc4OTo7PD0-Pw',
    }))).toThrow(/relay_capacity_pressure/)
  })

  it('settles denial without creating a claimable item', () => {
    const queue = new RemoteRelayQueue(database(), {
      databasePurpose: 'remote-relay-isolated-v1',
      enabled: true,
      clock: () => new Date('2026-08-28T20:00:00.000Z'),
      verifyCapsule,
    })
    const denied = capsule({ decision: 'deny' })
    expect(enqueue(queue, denied).state).toBe('denied')
    expect(() => queue.claim(denied.capsule_id, denied.device_id))
      .toThrow(/relay_queue_terminal/)
  })

  it('leases, retries only after expiry, acknowledges once, and purges explicitly', () => {
    let now = new Date('2026-08-28T20:00:00.000Z')
    const queue = new RemoteRelayQueue(database(), {
      databasePurpose: 'remote-relay-isolated-v1',
      enabled: true,
      clock: () => now,
      verifyCapsule,
    })
    const signed = capsule()
    enqueue(queue, signed)
    now = new Date('2026-08-28T20:00:01.000Z')
    const claimed = queue.claim(signed.capsule_id, signed.device_id, 10)
    expect(claimed.state).toBe('claimed')
    expect(queue.claimedCapsule(signed.capsule_id, signed.device_id)).toEqual(signed)
    expect(queue.claim(signed.capsule_id, signed.device_id).record_hash)
      .toBe(claimed.record_hash)
    expect(() => queue.claim(signed.capsule_id, 'workstation-other'))
      .toThrow(/relay_claim_conflict/)

    now = new Date('2026-08-28T20:00:10.000Z')
    expect(() => queue.requeueExpiredClaim(signed.capsule_id))
      .toThrow(/relay_claim_active/)
    now = new Date('2026-08-28T20:00:11.000Z')
    expect(queue.requeueExpiredClaim(signed.capsule_id).state).toBe('queued')
    now = new Date('2026-08-28T20:00:12.000Z')
    expect(queue.claim(signed.capsule_id, signed.device_id).state).toBe('claimed')

    const ack = acknowledgement()
    const terminal = queue.acknowledge(ack)
    expect(terminal).toMatchObject({ state: 'acknowledged', outcome: 'completed' })
    expect(queue.acknowledge(ack).record_hash).toBe(terminal.record_hash)
    expect(queue.audit(signed.capsule_id)).toMatchObject({
      capsule_hash: canonicalDigest(signed),
      nonce_hash: canonicalDigest({ nonce: signed.nonce }),
      actor_id: signed.actor_id,
      transport_principal: ack.transport_principal,
      queue_state: 'acknowledged',
      outcome: 'completed',
    })
    expect(queue.bodyIsPurged(signed.capsule_id)).toBe(false)
    queue.purgeTerminalBody(signed.capsule_id)
    expect(queue.bodyIsPurged(signed.capsule_id)).toBe(true)
    expect(queue.audit(signed.capsule_id).capsule_hash).toBe(canonicalDigest(signed))
  })

  it('atomically claims the next device item and safely resumes an active lease', () => {
    let now = new Date('2026-08-28T20:00:00.000Z')
    const queue = new RemoteRelayQueue(database(), {
      databasePurpose: 'remote-relay-isolated-v1',
      enabled: true,
      clock: () => now,
      verifyCapsule,
    })
    const signed = capsule()
    enqueue(queue, signed)

    now = new Date('2026-08-28T20:00:01.000Z')
    const first = queue.claimNext(signed.device_id, 10)
    expect(first).not.toBeNull()
    expect(first?.capsule).toEqual(signed)
    expect(first?.queue_record).toMatchObject({
      state: 'claimed',
      claim_device_id: signed.device_id,
    })
    expect(queue.claimNext(signed.device_id, 10)?.queue_record.record_hash)
      .toBe(first?.queue_record.record_hash)
    expect(queue.claimNext('workstation-other')).toBeNull()

    now = new Date('2026-08-28T20:00:11.001Z')
    const reclaimed = queue.claimNext(signed.device_id, 10)
    expect(reclaimed?.queue_record.state).toBe('claimed')
    expect(reclaimed?.queue_record.revision).toBe(4)
  })

  it('maintenance requeues leases, expires capsules, and purges terminal bodies on policy', () => {
    let now = new Date('2026-08-28T20:00:00.000Z')
    const queue = new RemoteRelayQueue(database(), {
      databasePurpose: 'remote-relay-isolated-v1',
      enabled: true,
      clock: () => now,
      terminalBodyRetentionMs: 0,
      verifyCapsule,
    })
    const signed = capsule()
    enqueue(queue, signed)
    now = new Date('2026-08-28T20:00:01.000Z')
    queue.claimNext(signed.device_id, 1)
    now = new Date('2026-08-28T20:00:02.000Z')
    expect(queue.maintain()).toMatchObject({ requeued: 1 })
    expect(queue.current(signed.capsule_id).state).toBe('queued')
    now = new Date('2026-08-28T20:01:05.001Z')
    expect(queue.maintain()).toEqual({
      expired: 1,
      requeued: 0,
      bodies_purged: 1,
    })
    expect(queue.bodyIsPurged(signed.capsule_id)).toBe(true)
    expect(queue.audit(signed.capsule_id).queue_state).toBe('expired')
  })

  it('revokes durably before dispatch and rejects a conflicting replay', () => {
    const queue = new RemoteRelayQueue(database(), {
      databasePurpose: 'remote-relay-isolated-v1',
      enabled: true,
      clock: () => new Date('2026-08-28T20:00:00.000Z'),
      verifyCapsule,
    })
    enqueue(queue, capsule())
    const record = revocation()
    const terminal = queue.revoke(record)
    expect(terminal.state).toBe('revoked')
    expect(queue.revocation(record.capsule_id, record.command_id)).toEqual(record)
    expect(() => queue.revocation(record.capsule_id, 'command-other'))
      .toThrow(/relay_revocation_binding_mismatch/)
    expect(queue.revoke(record).record_hash).toBe(terminal.record_hash)
    expect(() => queue.revoke({
      ...record,
      revocation_hash: canonicalDigest({ other: true }),
    })).toThrow(RelayQueueError)
  })

  it('expires only after the frozen five-second skew', () => {
    let now = new Date('2026-08-28T20:00:00.000Z')
    const queue = new RemoteRelayQueue(database(), {
      databasePurpose: 'remote-relay-isolated-v1',
      enabled: true,
      clock: () => now,
      verifyCapsule,
    })
    const signed = capsule()
    enqueue(queue, signed)
    now = new Date('2026-08-28T20:01:05.000Z')
    expect(() => queue.expire(signed.capsule_id)).toThrow(/relay_capsule_live/)
    now = new Date('2026-08-28T20:01:05.001Z')
    expect(queue.expire(signed.capsule_id).state).toBe('expired')
  })
})
