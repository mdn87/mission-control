import {
  createPrivateKey,
  createPublicKey,
  verify,
} from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  capsuleSigningBytes,
  canonicalDigest,
  REMOTE_DECISION_ACK_SCHEMA,
  REMOTE_DECISION_REVOCATION_SCHEMA,
} from '../integrations/lugos/remote-decision-contract'
import { RemoteRelayIssuer } from '../integrations/lugos/relay-issuer'
import { RemoteRelayQueue } from '../integrations/lugos/relay-queue'
import { RemoteRelaySigner } from '../integrations/lugos/relay-signer'
import {
  RelayRequestError,
  RemoteRelayApplication,
  type RelayDeviceIdentity,
} from './relay-application'

const privateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)),
  ]),
  format: 'der',
  type: 'pkcs8',
})
const publicKey = createPublicKey(privateKey.export({ type: 'pkcs8', format: 'pem' }))
const token = 'relay-internal.' + 'a'.repeat(40)
const identity: RelayDeviceIdentity = {
  device_id: 'workstation-4070pc',
  transport_principal: 'relay-device:4070pc',
  certificate_sha256: 'b'.repeat(64),
}
const input = {
  command_id: 'remote-command-fixture-1',
  actor_id: 'mc:user:1',
  audience: 'fade-weir-remote-decision' as const,
  device_id: identity.device_id,
  decision: 'approve' as const,
  proposal_hash: canonicalDigest({ proposal: 1 }),
  action_id: 'action-fixture-1',
  work_context_hash: canonicalDigest({ context: 1 }),
  step_up_ref: canonicalDigest({ step_up: 1 }),
}

describe('remote relay application boundaries', () => {
  const databases: Database.Database[] = []

  afterEach(() => {
    for (const database of databases) database.close()
    databases.length = 0
  })

  function fixture() {
    let now = new Date('2026-08-28T20:00:00.000Z')
    const database = new Database(':memory:')
    databases.push(database)
    const signer = new RemoteRelaySigner({
      activeSigningKey: () => ({
        key_id: 'relay-key-fixture',
        issuer_id: 'lugos-relay-issuer',
        private_key: privateKey,
      }),
    }, {
      enabled: () => true,
      clock: () => now,
      nonce: () => 'AAECAwQFBgcICQoLDA0ODw',
      capsuleId: () => 'capsule-fixture-1',
    })
    const queue = new RemoteRelayQueue(database, {
      databasePurpose: 'remote-relay-isolated-v1',
      enabled: true,
      clock: () => now,
      verifyCapsule(capsule) {
        if (!verify(
          null,
          capsuleSigningBytes(capsule),
          publicKey,
          Buffer.from(capsule.signature, 'base64url'),
        )) throw new Error('invalid signature')
      },
    })
    return {
      application: new RemoteRelayApplication(
        new RemoteRelayIssuer(signer, queue),
        queue,
        token,
      ),
      queue,
      setNow(value: string) { now = new Date(value) },
    }
  }

  it('requires the separate loopback bearer before issuing a capsule', () => {
    const { application } = fixture()
    expect(() => application.enqueue(undefined, input)).toThrow(RelayRequestError)
    expect(() => application.enqueue('Bearer wrong', input)).toThrow(
      /relay_internal_unauthorized/,
    )
    expect(application.enqueue(`Bearer ${token}`, input)).toMatchObject({
      command_id: input.command_id,
      actor_id: input.actor_id,
      device_id: input.device_id,
    })
  })

  it('binds claims and acknowledgements to the certificate identity', () => {
    const { application, setNow } = fixture()
    const capsule = application.enqueue(`Bearer ${token}`, input)
    setNow('2026-08-28T20:00:01.000Z')
    expect(() => application.claim(
      { ...identity, device_id: 'workstation-other' },
      { device_id: identity.device_id },
    )).toThrow(/relay_device_mismatch/)
    expect(application.claim(identity, { device_id: identity.device_id })?.capsule)
      .toEqual(capsule)

    const basis = {
      schema: REMOTE_DECISION_ACK_SCHEMA as typeof REMOTE_DECISION_ACK_SCHEMA,
      acknowledgement_id: 'ack-fixture-1',
      capsule_id: capsule.capsule_id,
      command_id: capsule.command_id,
      actor_id: capsule.actor_id,
      device_id: capsule.device_id,
      transport_principal: identity.transport_principal,
      outcome: 'completed' as const,
      receipt_hash: canonicalDigest({ receipt: 1 }),
      acknowledged_at: '2026-08-28T20:00:02.000Z',
    }
    const acknowledgement = {
      ...basis,
      acknowledgement_hash: canonicalDigest(basis),
    }
    setNow('2026-08-28T20:00:02.000Z')
    expect(() => application.acknowledge(
      { ...identity, transport_principal: 'relay-device:other' },
      acknowledgement,
    )).toThrow(/relay_acknowledgement_identity_mismatch/)
    expect(application.acknowledge(identity, acknowledgement).state)
      .toBe('acknowledged')
  })

  it('returns a revocation to the pinned device after the queue is terminal', () => {
    const { application, queue, setNow } = fixture()
    const capsule = application.enqueue(`Bearer ${token}`, input)
    setNow('2026-08-28T20:00:01.000Z')
    application.claim(identity, { device_id: identity.device_id })
    const basis = {
      schema: REMOTE_DECISION_REVOCATION_SCHEMA as typeof REMOTE_DECISION_REVOCATION_SCHEMA,
      revocation_id: 'revocation-fixture-1',
      capsule_id: capsule.capsule_id,
      command_id: capsule.command_id,
      actor_id: capsule.actor_id,
      reason_code: 'operator_withdrew' as const,
      revoked_at: '2026-08-28T20:00:02.000Z',
    }
    const revocation = { ...basis, revocation_hash: canonicalDigest(basis) }
    setNow('2026-08-28T20:00:02.000Z')
    queue.revoke(revocation)
    expect(application.getRevocation(
      identity,
      capsule.capsule_id,
      capsule.command_id,
    )).toEqual(revocation)
    expect(() => application.getRevocation(
      { ...identity, device_id: 'workstation-other' },
      capsule.capsule_id,
      capsule.command_id,
    )).toThrow(/relay_device_mismatch/)
  })
})
