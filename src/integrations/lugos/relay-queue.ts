import type Database from 'better-sqlite3'
import {
  canonicalDigest,
  canonicalJson,
  MAX_REMOTE_DECISION_LIVE_ENTRIES,
  REMOTE_DECISION_AUDIT_SCHEMA,
  REMOTE_DECISION_QUEUE_STATE_SCHEMA,
  remoteDecisionAcknowledgementSchema,
  remoteDecisionAuditSchema,
  remoteDecisionCapsuleSchema,
  remoteDecisionQueueRecordSchema,
  remoteDecisionRevocationSchema,
  type RemoteDecisionAcknowledgement,
  type RemoteDecisionAudit,
  type RemoteDecisionCapsule,
  type RemoteDecisionQueueRecord,
  type RemoteDecisionRevocation,
} from './remote-decision-contract'
import { relayIssuerEnabled } from './relay-signer'

const RELAY_QUEUE_SCHEMA_VERSION = 1
const MAX_CLAIM_LEASE_SECONDS = 30
const EXPIRY_SKEW_MS = 5_000
const DEFAULT_TERMINAL_BODY_RETENTION_MS = 5 * 60 * 1_000
const EFFECT_OUTCOMES = new Set([
  'completed',
  'failed',
  'blocked',
  'cancelled',
  'outcome_unknown',
])
const TERMINAL_STATES = new Set([
  'acknowledged',
  'denied',
  'expired',
  'revoked',
])

interface CapsuleRow {
  capsule_id: string
  command_id: string
  request_hash: string
  capsule_hash: string
  nonce_hash: string
  capsule_json: string | null
  actor_id: string
  device_id: string
  decision: 'approve' | 'deny'
  issued_at: string
  state: RemoteDecisionQueueRecord['state']
  revision: number
  current_record_hash: string
  transport_principal: string | null
  outcome: RemoteDecisionAcknowledgement['outcome'] | null
  terminal_at: string | null
  terminal_ref_hash: string | null
  body_purged: number
}

export interface ClaimedRemoteDecision {
  capsule: RemoteDecisionCapsule
  queue_record: RemoteDecisionQueueRecord
}

export interface RelayMaintenanceResult {
  expired: number
  requeued: number
  bodies_purged: number
}

export class RelayQueueError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'RelayQueueError'
  }
}

function iso(date: Date): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new RelayQueueError('relay_clock_invalid')
  }
  return date.toISOString()
}

function verifyHashRecord(
  value: Record<string, unknown>,
  hashField: string,
): void {
  const basis = { ...value }
  const expected = basis[hashField]
  delete basis[hashField]
  if (canonicalDigest(basis) !== expected) {
    throw new RelayQueueError('relay_record_hash_mismatch')
  }
}

function queueRecord(input: Omit<RemoteDecisionQueueRecord, 'record_hash'>) {
  const record = {
    ...input,
    record_hash: canonicalDigest(input),
  }
  return remoteDecisionQueueRecordSchema.parse(record)
}

export class RemoteRelayQueue {
  private readonly liveLimit: number
  private readonly clock: () => Date
  private readonly verifyCapsule: (capsule: RemoteDecisionCapsule) => void
  private readonly terminalBodyRetentionMs: number

  constructor(
    private readonly db: Database.Database,
    options: {
      databasePurpose: 'remote-relay-isolated-v1'
      enabled?: boolean
      liveLimit?: number
      clock?: () => Date
      terminalBodyRetentionMs?: number
      verifyCapsule(capsule: RemoteDecisionCapsule): void
    },
  ) {
    if (options.databasePurpose !== 'remote-relay-isolated-v1') {
      throw new TypeError('Remote relay requires its isolated database')
    }
    if (!(options.enabled ?? relayIssuerEnabled())) {
      throw new RelayQueueError('relay_issuer_disabled')
    }
    this.liveLimit = options.liveLimit ?? MAX_REMOTE_DECISION_LIVE_ENTRIES
    if (!Number.isSafeInteger(this.liveLimit)
      || this.liveLimit < 1
      || this.liveLimit > MAX_REMOTE_DECISION_LIVE_ENTRIES) {
      throw new TypeError('Remote relay live-entry limit is invalid')
    }
    if (typeof options.verifyCapsule !== 'function') {
      throw new TypeError('Remote relay capsule verifier is required')
    }
    this.clock = options.clock ?? (() => new Date())
    this.verifyCapsule = options.verifyCapsule
    this.terminalBodyRetentionMs = (
      options.terminalBodyRetentionMs ?? DEFAULT_TERMINAL_BODY_RETENTION_MS
    )
    if (!Number.isSafeInteger(this.terminalBodyRetentionMs)
      || this.terminalBodyRetentionMs < 0
      || this.terminalBodyRetentionMs > DEFAULT_TERMINAL_BODY_RETENTION_MS) {
      throw new TypeError('Remote relay terminal-body retention is invalid')
    }
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        purpose TEXT NOT NULL CHECK (purpose = 'remote-relay-isolated-v1')
      );
      CREATE TABLE IF NOT EXISTS relay_capsules (
        capsule_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        capsule_hash TEXT NOT NULL UNIQUE,
        nonce_hash TEXT NOT NULL UNIQUE,
        capsule_json TEXT,
        actor_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('approve', 'deny')),
        issued_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'queued', 'claimed', 'acknowledged', 'denied', 'expired', 'revoked'
        )),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        current_record_hash TEXT NOT NULL,
        transport_principal TEXT,
        outcome TEXT,
        terminal_at TEXT,
        terminal_ref_hash TEXT,
        body_purged INTEGER NOT NULL DEFAULT 0 CHECK (body_purged IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS relay_transitions (
        transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
        capsule_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        record_hash TEXT NOT NULL UNIQUE,
        record_json TEXT NOT NULL,
        UNIQUE (capsule_id, revision),
        FOREIGN KEY (capsule_id) REFERENCES relay_capsules(capsule_id)
      );
      CREATE TABLE IF NOT EXISTS relay_revocations (
        capsule_id TEXT PRIMARY KEY,
        revocation_hash TEXT NOT NULL UNIQUE,
        revocation_json TEXT NOT NULL,
        FOREIGN KEY (capsule_id) REFERENCES relay_capsules(capsule_id)
      );
    `)
    this.db.prepare(`
      INSERT OR IGNORE INTO relay_metadata (singleton, schema_version, purpose)
      VALUES (1, ?, 'remote-relay-isolated-v1')
    `).run(RELAY_QUEUE_SCHEMA_VERSION)
    const metadata = this.db.prepare(`
      SELECT schema_version, purpose FROM relay_metadata WHERE singleton = 1
    `).get() as { schema_version: number; purpose: string } | undefined
    if (metadata?.schema_version !== RELAY_QUEUE_SCHEMA_VERSION
      || metadata.purpose !== 'remote-relay-isolated-v1') {
      throw new RelayQueueError('relay_queue_schema_unsupported')
    }
  }

  enqueue(
    rawCapsule: RemoteDecisionCapsule,
    requestHash: string,
  ): RemoteDecisionQueueRecord {
    const capsule = remoteDecisionCapsuleSchema.parse(rawCapsule)
    if (!/^sha256:[a-f0-9]{64}$/.test(requestHash)) {
      throw new RelayQueueError('relay_request_hash_invalid')
    }
    const capsuleJson = canonicalJson(capsule)
    const capsuleHash = canonicalDigest(capsule)
    const nonceHash = canonicalDigest({ nonce: capsule.nonce })
    this.verifyCapsule(capsule)
    const recordedDate = this.clock()
    const recordedMs = recordedDate.getTime()
    if (recordedMs < Date.parse(capsule.issued_at)) {
      throw new RelayQueueError('relay_capsule_not_yet_valid')
    }
    if (recordedMs > Date.parse(capsule.expires_at) + EXPIRY_SKEW_MS) {
      throw new RelayQueueError('relay_capsule_expired')
    }
    return this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT request_hash, capsule_id FROM relay_capsules WHERE command_id = ?
      `).get(capsule.command_id) as {
        request_hash: string
        capsule_id: string
      } | undefined
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new RelayQueueError('relay_command_conflict')
        }
        return this.current(existing.capsule_id)
      }
      const live = this.db.prepare(`
        SELECT COUNT(*) AS count FROM relay_capsules
        WHERE state IN ('queued', 'claimed')
      `).get() as { count: number }
      if (live.count >= this.liveLimit) {
        throw new RelayQueueError('relay_capacity_pressure')
      }
      const recordedAt = iso(recordedDate)
      const initial = queueRecord({
        schema: REMOTE_DECISION_QUEUE_STATE_SCHEMA,
        record_id: `queue:${capsule.capsule_id}:1`,
        capsule_id: capsule.capsule_id,
        command_id: capsule.command_id,
        state: 'queued',
        revision: 1,
        claim_device_id: null,
        claim_expires_at: null,
        outcome: null,
        recorded_at: recordedAt,
        previous_record_hash: null,
      })
      try {
        this.db.prepare(`
          INSERT INTO relay_capsules (
            capsule_id, command_id, request_hash, capsule_hash, nonce_hash, capsule_json,
            actor_id, device_id, decision, issued_at, state, revision,
            current_record_hash, transport_principal, outcome, terminal_at,
            terminal_ref_hash, body_purged
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, ?, NULL, NULL, NULL, NULL, 0)
        `).run(
          capsule.capsule_id,
          capsule.command_id,
          requestHash,
          capsuleHash,
          nonceHash,
          capsuleJson,
          capsule.actor_id,
          capsule.device_id,
          capsule.decision,
          capsule.issued_at,
          initial.record_hash,
        )
        this.insertTransition(initial)
      } catch (error) {
        if (String(error).includes('UNIQUE constraint failed')) {
          throw new RelayQueueError('relay_uniqueness_conflict')
        }
        throw error
      }
      if (capsule.decision === 'deny') {
        const row = this.row(capsule.capsule_id)
        const denied = this.transition(row, initial, {
          state: 'denied',
          claim_device_id: null,
          claim_expires_at: null,
          outcome: null,
          recorded_at: recordedAt,
        })
        this.db.prepare(`
          UPDATE relay_capsules SET terminal_at = ? WHERE capsule_id = ?
        `).run(recordedAt, capsule.capsule_id)
        return denied
      }
      return initial
    })()
  }

  current(capsuleId: string): RemoteDecisionQueueRecord {
    const row = this.row(capsuleId)
    const transition = this.db.prepare(`
      SELECT record_json FROM relay_transitions
      WHERE capsule_id = ? AND revision = ?
    `).get(capsuleId, row.revision) as { record_json: string } | undefined
    if (!transition) throw new RelayQueueError('relay_queue_corrupt')
    const record = remoteDecisionQueueRecordSchema.parse(
      JSON.parse(transition.record_json),
    )
    verifyHashRecord(record, 'record_hash')
    if (record.record_hash !== row.current_record_hash || record.state !== row.state) {
      throw new RelayQueueError('relay_queue_corrupt')
    }
    return record
  }

  existingCapsule(
    commandId: string,
    requestHash: string,
  ): RemoteDecisionCapsule | null {
    const row = this.db.prepare(`
      SELECT * FROM relay_capsules WHERE command_id = ?
    `).get(commandId) as CapsuleRow | undefined
    if (!row) return null
    if (row.request_hash !== requestHash) {
      throw new RelayQueueError('relay_command_conflict')
    }
    return this.requireCapsuleBody(row)
  }

  claim(
    capsuleId: string,
    deviceId: string,
    leaseSeconds = 10,
  ): RemoteDecisionQueueRecord {
    if (!Number.isSafeInteger(leaseSeconds)
      || leaseSeconds < 1
      || leaseSeconds > MAX_CLAIM_LEASE_SECONDS) {
      throw new TypeError('Remote relay claim lease is invalid')
    }
    return this.db.transaction(() => {
      const row = this.row(capsuleId)
      const current = this.current(capsuleId)
      if (row.state === 'claimed') {
        if (current.claim_device_id === deviceId) return current
        throw new RelayQueueError('relay_claim_conflict')
      }
      if (row.state !== 'queued') throw new RelayQueueError('relay_queue_terminal')
      const capsule = this.requireCapsuleBody(row)
      if (capsule.decision !== 'approve') {
        throw new RelayQueueError('relay_denial_not_claimable')
      }
      if (capsule.device_id !== deviceId) {
        throw new RelayQueueError('relay_device_mismatch')
      }
      const now = this.clock()
      const nowMs = now.getTime()
      const issuedMs = Date.parse(capsule.issued_at)
      const expiresMs = Date.parse(capsule.expires_at) + EXPIRY_SKEW_MS
      if (nowMs < issuedMs) throw new RelayQueueError('relay_capsule_not_yet_valid')
      if (nowMs > expiresMs) throw new RelayQueueError('relay_capsule_expired')
      const claimExpiresMs = Math.min(nowMs + leaseSeconds * 1000, expiresMs)
      if (claimExpiresMs <= nowMs) throw new RelayQueueError('relay_capsule_expired')
      return this.transition(row, current, {
        state: 'claimed',
        claim_device_id: deviceId,
        claim_expires_at: new Date(claimExpiresMs).toISOString(),
        outcome: null,
        recorded_at: iso(now),
      })
    })()
  }

  claimNext(
    deviceId: string,
    leaseSeconds = 10,
  ): ClaimedRemoteDecision | null {
    this.validateDeviceId(deviceId)
    this.validateLease(leaseSeconds)
    return this.db.transaction(() => {
      const candidates = this.db.prepare(`
        SELECT capsule_id FROM relay_capsules
        WHERE device_id = ? AND state IN ('claimed', 'queued')
        ORDER BY CASE state WHEN 'claimed' THEN 0 ELSE 1 END, issued_at, capsule_id
      `).all(deviceId) as Array<{ capsule_id: string }>
      const now = this.clock()
      const nowMs = now.getTime()
      const recordedAt = iso(now)

      for (const candidate of candidates) {
        let row = this.row(candidate.capsule_id)
        let current = this.current(candidate.capsule_id)
        const capsule = this.requireCapsuleBody(row)
        const expiresMs = Date.parse(capsule.expires_at) + EXPIRY_SKEW_MS

        if (nowMs > expiresMs) {
          const expired = this.transition(row, current, {
            state: 'expired',
            claim_device_id: null,
            claim_expires_at: null,
            outcome: null,
            recorded_at: recordedAt,
          })
          this.db.prepare(`
            UPDATE relay_capsules SET terminal_at = ? WHERE capsule_id = ?
          `).run(recordedAt, capsule.capsule_id)
          current = expired
          continue
        }

        if (row.state === 'claimed') {
          if (current.claim_device_id !== deviceId
            || current.claim_expires_at === null) {
            throw new RelayQueueError('relay_queue_corrupt')
          }
          if (nowMs < Date.parse(current.claim_expires_at)) {
            return { capsule, queue_record: current }
          }
          current = this.transition(row, current, {
            state: 'queued',
            claim_device_id: null,
            claim_expires_at: null,
            outcome: null,
            recorded_at: recordedAt,
          })
          row = this.row(candidate.capsule_id)
        }

        if (current.state !== 'queued') continue
        const claimExpiresMs = Math.min(nowMs + leaseSeconds * 1_000, expiresMs)
        if (claimExpiresMs <= nowMs) continue
        const claimed = this.transition(row, current, {
          state: 'claimed',
          claim_device_id: deviceId,
          claim_expires_at: new Date(claimExpiresMs).toISOString(),
          outcome: null,
          recorded_at: recordedAt,
        })
        return { capsule, queue_record: claimed }
      }
      return null
    })()
  }

  claimedCapsule(capsuleId: string, deviceId: string): RemoteDecisionCapsule {
    const row = this.row(capsuleId)
    const current = this.current(capsuleId)
    if (row.state !== 'claimed' || current.claim_device_id !== deviceId) {
      throw new RelayQueueError('relay_claim_binding_mismatch')
    }
    return this.requireCapsuleBody(row)
  }

  requeueExpiredClaim(capsuleId: string): RemoteDecisionQueueRecord {
    return this.db.transaction(() => {
      const row = this.row(capsuleId)
      const current = this.current(capsuleId)
      if (row.state !== 'claimed' || current.claim_expires_at === null) {
        throw new RelayQueueError('relay_claim_missing')
      }
      const capsule = this.requireCapsuleBody(row)
      const now = this.clock()
      if (now.getTime() < Date.parse(current.claim_expires_at)) {
        throw new RelayQueueError('relay_claim_active')
      }
      if (now.getTime() > Date.parse(capsule.expires_at) + EXPIRY_SKEW_MS) {
        throw new RelayQueueError('relay_capsule_expired')
      }
      return this.transition(row, current, {
        state: 'queued',
        claim_device_id: null,
        claim_expires_at: null,
        outcome: null,
        recorded_at: iso(now),
      })
    })()
  }

  acknowledge(
    rawAcknowledgement: RemoteDecisionAcknowledgement,
  ): RemoteDecisionQueueRecord {
    const acknowledgement = remoteDecisionAcknowledgementSchema.parse(
      rawAcknowledgement,
    )
    verifyHashRecord(acknowledgement, 'acknowledgement_hash')
    return this.db.transaction(() => {
      const row = this.row(acknowledgement.capsule_id)
      if (TERMINAL_STATES.has(row.state)) {
        if (row.terminal_ref_hash === acknowledgement.acknowledgement_hash) {
          return this.current(row.capsule_id)
        }
        throw new RelayQueueError('relay_acknowledgement_conflict')
      }
      if (row.state !== 'claimed') {
        throw new RelayQueueError('relay_claim_missing')
      }
      if (row.command_id !== acknowledgement.command_id
        || row.actor_id !== acknowledgement.actor_id
        || row.device_id !== acknowledgement.device_id) {
        throw new RelayQueueError('relay_acknowledgement_binding_mismatch')
      }
      const current = this.current(row.capsule_id)
      const acknowledgedMs = Date.parse(acknowledgement.acknowledged_at)
      if (acknowledgedMs < Date.parse(current.recorded_at)
        || acknowledgedMs > this.clock().getTime() + EXPIRY_SKEW_MS) {
        throw new RelayQueueError('relay_acknowledgement_time_invalid')
      }
      let state: 'acknowledged' | 'denied' | 'expired' | 'revoked'
      if (EFFECT_OUTCOMES.has(acknowledgement.outcome)) {
        state = 'acknowledged'
      } else if (acknowledgement.outcome === 'denied'
        || acknowledgement.outcome === 'expired'
        || acknowledgement.outcome === 'revoked') {
        state = acknowledgement.outcome
      } else {
        throw new RelayQueueError('relay_acknowledgement_outcome_invalid')
      }
      const next = this.transition(row, current, {
        state,
        claim_device_id: null,
        claim_expires_at: null,
        outcome: state === 'acknowledged' ? acknowledgement.outcome : null,
        recorded_at: acknowledgement.acknowledged_at,
      })
      this.db.prepare(`
        UPDATE relay_capsules
        SET transport_principal = ?, outcome = ?, terminal_at = ?, terminal_ref_hash = ?
        WHERE capsule_id = ?
      `).run(
        acknowledgement.transport_principal,
        next.outcome,
        acknowledgement.acknowledged_at,
        acknowledgement.acknowledgement_hash,
        row.capsule_id,
      )
      return next
    })()
  }

  revoke(rawRevocation: RemoteDecisionRevocation): RemoteDecisionQueueRecord {
    const revocation = remoteDecisionRevocationSchema.parse(rawRevocation)
    verifyHashRecord(revocation, 'revocation_hash')
    return this.db.transaction(() => {
      const row = this.row(revocation.capsule_id)
      if (row.state === 'revoked') {
        if (row.terminal_ref_hash === revocation.revocation_hash) {
          return this.current(row.capsule_id)
        }
        throw new RelayQueueError('relay_revocation_conflict')
      }
      if (TERMINAL_STATES.has(row.state)) {
        throw new RelayQueueError('relay_revocation_too_late')
      }
      if (row.command_id !== revocation.command_id) {
        throw new RelayQueueError('relay_revocation_binding_mismatch')
      }
      const current = this.current(row.capsule_id)
      const revokedMs = Date.parse(revocation.revoked_at)
      if (revokedMs < Date.parse(row.issued_at)
        || revokedMs > this.clock().getTime() + EXPIRY_SKEW_MS) {
        throw new RelayQueueError('relay_revocation_time_invalid')
      }
      const next = this.transition(row, current, {
        state: 'revoked',
        claim_device_id: null,
        claim_expires_at: null,
        outcome: null,
        recorded_at: revocation.revoked_at,
      })
      this.db.prepare(`
        INSERT INTO relay_revocations (capsule_id, revocation_hash, revocation_json)
        VALUES (?, ?, ?)
      `).run(
        row.capsule_id,
        revocation.revocation_hash,
        canonicalJson(revocation),
      )
      this.db.prepare(`
        UPDATE relay_capsules SET terminal_at = ?, terminal_ref_hash = ?
        WHERE capsule_id = ?
      `).run(revocation.revoked_at, revocation.revocation_hash, row.capsule_id)
      return next
    })()
  }

  revocation(
    capsuleId: string,
    commandId: string,
  ): RemoteDecisionRevocation | null {
    const row = this.db.prepare(`
      SELECT revocation_json FROM relay_revocations WHERE capsule_id = ?
    `).get(capsuleId) as { revocation_json: string } | undefined
    if (!row) return null
    const revocation = remoteDecisionRevocationSchema.parse(
      JSON.parse(row.revocation_json),
    )
    verifyHashRecord(revocation, 'revocation_hash')
    if (revocation.command_id !== commandId) {
      throw new RelayQueueError('relay_revocation_binding_mismatch')
    }
    return revocation
  }

  expire(capsuleId: string): RemoteDecisionQueueRecord {
    return this.db.transaction(() => {
      const row = this.row(capsuleId)
      if (row.state === 'expired') return this.current(capsuleId)
      if (TERMINAL_STATES.has(row.state)) {
        throw new RelayQueueError('relay_queue_terminal')
      }
      const capsule = this.requireCapsuleBody(row)
      const now = this.clock()
      if (now.getTime() <= Date.parse(capsule.expires_at) + EXPIRY_SKEW_MS) {
        throw new RelayQueueError('relay_capsule_live')
      }
      const current = this.current(capsuleId)
      const recordedAt = iso(now)
      const next = this.transition(row, current, {
        state: 'expired',
        claim_device_id: null,
        claim_expires_at: null,
        outcome: null,
        recorded_at: recordedAt,
      })
      this.db.prepare(`
        UPDATE relay_capsules SET terminal_at = ? WHERE capsule_id = ?
      `).run(recordedAt, capsuleId)
      return next
    })()
  }

  purgeTerminalBody(capsuleId: string): void {
    this.db.transaction(() => {
      const row = this.row(capsuleId)
      if (!TERMINAL_STATES.has(row.state)) {
        throw new RelayQueueError('relay_body_purge_too_early')
      }
      this.db.prepare(`
        UPDATE relay_capsules SET capsule_json = NULL, body_purged = 1
        WHERE capsule_id = ?
      `).run(capsuleId)
    })()
  }

  audit(capsuleId: string): RemoteDecisionAudit {
    const row = this.row(capsuleId)
    const current = this.current(capsuleId)
    const basis = {
      schema: REMOTE_DECISION_AUDIT_SCHEMA,
      audit_id: `audit:${row.capsule_id}:${row.revision}`,
      capsule_hash: row.capsule_hash,
      nonce_hash: row.nonce_hash,
      capsule_id: row.capsule_id,
      command_id: row.command_id,
      actor_id: row.actor_id,
      device_id: row.device_id,
      transport_principal: row.transport_principal,
      decision: row.decision,
      queue_state: row.state,
      outcome: current.outcome,
      issued_at: row.issued_at,
      terminal_at: row.terminal_at,
      recorded_at: current.recorded_at,
    }
    return remoteDecisionAuditSchema.parse({
      ...basis,
      audit_hash: canonicalDigest(basis),
    })
  }

  bodyIsPurged(capsuleId: string): boolean {
    return this.row(capsuleId).body_purged === 1
  }

  targetDevice(capsuleId: string): string {
    return this.row(capsuleId).device_id
  }

  maintain(): RelayMaintenanceResult {
    return this.db.transaction(() => {
      const now = this.clock()
      const nowMs = now.getTime()
      const recordedAt = iso(now)
      let expired = 0
      let requeued = 0
      let bodiesPurged = 0
      const live = this.db.prepare(`
        SELECT capsule_id FROM relay_capsules
        WHERE state IN ('queued', 'claimed')
        ORDER BY issued_at, capsule_id
      `).all() as Array<{ capsule_id: string }>

      for (const item of live) {
        const row = this.row(item.capsule_id)
        const current = this.current(item.capsule_id)
        const capsule = this.requireCapsuleBody(row)
        if (nowMs > Date.parse(capsule.expires_at) + EXPIRY_SKEW_MS) {
          this.transition(row, current, {
            state: 'expired',
            claim_device_id: null,
            claim_expires_at: null,
            outcome: null,
            recorded_at: recordedAt,
          })
          this.db.prepare(`
            UPDATE relay_capsules SET terminal_at = ? WHERE capsule_id = ?
          `).run(recordedAt, item.capsule_id)
          expired += 1
          continue
        }
        if (row.state === 'claimed'
          && current.claim_expires_at !== null
          && nowMs >= Date.parse(current.claim_expires_at)) {
          this.transition(row, current, {
            state: 'queued',
            claim_device_id: null,
            claim_expires_at: null,
            outcome: null,
            recorded_at: recordedAt,
          })
          requeued += 1
        }
      }

      const purgeBefore = new Date(nowMs - this.terminalBodyRetentionMs).toISOString()
      const purged = this.db.prepare(`
        UPDATE relay_capsules SET capsule_json = NULL, body_purged = 1
        WHERE state IN ('acknowledged', 'denied', 'expired', 'revoked')
          AND body_purged = 0
          AND terminal_at IS NOT NULL
          AND terminal_at <= ?
      `).run(purgeBefore)
      bodiesPurged = purged.changes
      return { expired, requeued, bodies_purged: bodiesPurged }
    })()
  }

  private transition(
    row: CapsuleRow,
    current: RemoteDecisionQueueRecord,
    change: Pick<
      RemoteDecisionQueueRecord,
      'state' | 'claim_device_id' | 'claim_expires_at' | 'outcome' | 'recorded_at'
    >,
  ): RemoteDecisionQueueRecord {
    if (Date.parse(change.recorded_at) < Date.parse(current.recorded_at)) {
      throw new RelayQueueError('relay_transition_time_invalid')
    }
    const revision = current.revision + 1
    const next = queueRecord({
      schema: REMOTE_DECISION_QUEUE_STATE_SCHEMA,
      record_id: `queue:${row.capsule_id}:${revision}`,
      capsule_id: row.capsule_id,
      command_id: row.command_id,
      revision,
      previous_record_hash: current.record_hash,
      ...change,
    })
    const updated = this.db.prepare(`
      UPDATE relay_capsules
      SET state = ?, revision = ?, current_record_hash = ?
      WHERE capsule_id = ? AND revision = ? AND current_record_hash = ?
    `).run(
      next.state,
      revision,
      next.record_hash,
      row.capsule_id,
      current.revision,
      current.record_hash,
    )
    if (updated.changes !== 1) throw new RelayQueueError('relay_queue_conflict')
    this.insertTransition(next)
    return next
  }

  private insertTransition(record: RemoteDecisionQueueRecord): void {
    this.db.prepare(`
      INSERT INTO relay_transitions (capsule_id, revision, record_hash, record_json)
      VALUES (?, ?, ?, ?)
    `).run(
      record.capsule_id,
      record.revision,
      record.record_hash,
      canonicalJson(record),
    )
  }

  private row(capsuleId: string): CapsuleRow {
    const row = this.db.prepare(`
      SELECT * FROM relay_capsules WHERE capsule_id = ?
    `).get(capsuleId) as CapsuleRow | undefined
    if (!row) throw new RelayQueueError('relay_capsule_not_found')
    return row
  }

  private requireCapsuleBody(row: CapsuleRow): RemoteDecisionCapsule {
    if (row.capsule_json === null) {
      throw new RelayQueueError('relay_capsule_body_purged')
    }
    const capsule = remoteDecisionCapsuleSchema.parse(JSON.parse(row.capsule_json))
    if (canonicalDigest(capsule) !== row.capsule_hash) {
      throw new RelayQueueError('relay_capsule_hash_mismatch')
    }
    return capsule
  }


  private validateDeviceId(deviceId: string): void {
    if (typeof deviceId !== 'string' || deviceId.length < 1 || deviceId.length > 128) {
      throw new TypeError('Remote relay device ID is invalid')
    }
  }

  private validateLease(leaseSeconds: number): void {
    if (!Number.isSafeInteger(leaseSeconds)
      || leaseSeconds < 1
      || leaseSeconds > MAX_CLAIM_LEASE_SECONDS) {
      throw new TypeError('Remote relay claim lease is invalid')
    }
  }
}
