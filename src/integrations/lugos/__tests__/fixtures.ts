import {
  AUTOWORK_DELTA_SCHEMA,
  AUTOWORK_SNAPSHOT_SCHEMA,
  OPERATOR_EVENT_SCHEMA,
  OPERATOR_RECEIPT_SCHEMA,
  OPERATOR_SNAPSHOT_SCHEMA,
  type AutoworkDelta,
  type AutoworkProjection,
  type OperatorReceipt,
  type OperatorSnapshot,
  type TaskLoopProjection,
} from '../operator-contract'

const phases = {
  classify: 'succeeded',
  assign: 'succeeded',
  attest: 'succeeded',
  dispatch: 'succeeded',
  work: 'active',
  review: 'pending',
  verify: 'pending',
  outcome: 'pending',
} as const

const terminal = {
  duration_ms: null,
  input_tokens: null,
  output_tokens: null,
  tool_denials: null,
  verification_attempts: null,
  first_pass_verified: null,
  fallback_used: null,
}

function analytics() {
  return {
    window_hours: 24,
    bucket_minutes: 120,
    outcomes: {
      accepted: 0,
      partial: 0,
      rejected: 0,
      incomplete: 0,
      fallback_used: 0,
    },
    outcome_buckets: Array.from({ length: 12 }, (_, offset) => ({
      offset,
      accepted: 0,
      partial: 0,
      rejected: 0,
    })),
    phase_duration_ms: {
      classify: null,
      assign: null,
      attest: null,
      dispatch: null,
      work: null,
      review: null,
      verify: null,
      outcome: null,
    },
  }
}
export function makeProjection(
  overrides: Partial<AutoworkProjection> = {},
): AutoworkProjection {
  return {
    schema: AUTOWORK_SNAPSHOT_SCHEMA,
    generatedAt: '2026-08-02T20:00:00.000Z',
    cursor: 'event-0002',
    source: {
      host: '4070pc',
      state: 'ready',
      lastReceiptAt: '2026-08-02T20:00:00.000Z',
      diagnostics: [],
    },
    summary: {
      active: 1,
      attention: 0,
      terminal24h: 0,
      accepted24h: 0,
      firstPassVerified24h: 0,
    },
    analytics: analytics(),
    runs: [{
      run_id: 'hud-week2-adoption',
      repo: 'lugos',
      source_host: '4070pc',
      agent_address: '4070pc/codex',
      route: 'codex',
      model: 'gpt-5.6',
      effort: 'high',
      current_phase: 'work',
      phases,
      elapsed_ms: 120000,
      liveness: { state: 'active', age_secs: 4 },
      attention: [],
      evidence: [{ kind: 'verification', label: 'operator-api-contract' }],
      terminal,
      outcome: 'unknown',
      landing: 'unknown',
    }],
    ...overrides,
  }
}

export function makeDelta(
  overrides: Partial<AutoworkDelta> = {},
): AutoworkDelta {
  return {
    ...makeProjection(),
    schema: AUTOWORK_DELTA_SCHEMA,
    cursor: 'event-0003',
    ...overrides,
  }
}

export function makeReceipt(
  overrides: Partial<OperatorReceipt> = {},
): OperatorReceipt {
  return {
    schema: OPERATOR_RECEIPT_SCHEMA,
    receipt_id: 'receipt-0001',
    type: 'approval.request',
    idempotency_key: 'mc-command-0001',
    status: 'accepted',
    accepted_at: '2026-08-02T20:01:00.000Z',
    ...overrides,
  }
}

export function makeSnapshot(
  overrides: Partial<OperatorSnapshot> = {},
): OperatorSnapshot {
  return {
    schema: OPERATOR_SNAPSHOT_SCHEMA,
    generatedAt: '2026-08-02T20:00:00.000Z',
    cursor: 'event-0002',
    projections: [{ name: 'autowork', value: makeProjection() }],
    receipts: [],
    ...overrides,
  }
}

export function makeTaskLoopProjection(
  overrides: Partial<TaskLoopProjection> = {},
): TaskLoopProjection {
  return {
    schema: 'lugos-task-loop/v1',
    generatedAt: '2026-08-02T22:00:00.000Z',
    cursor: 'receipt-loop-2',
    source: {
      mail: 'agent-mail',
      artifacts: 'repo-adapter',
      state: 'ready',
      diagnostics: [],
    },
    summary: {
      awaiting_approval: 0,
      artifact_ready: 1,
    },
    loops: [{
      loop_id: 'mail:41',
      state: 'artifact_ready',
      handoff: {
        message_id: 41,
        thread_id: 'a'.repeat(32),
        from_agent: '4070pc/mission-control',
        to_agent: '4070pc/codex',
        subject: 'Week 4 proof',
        sent_at: '2026-08-02T22:00:00.000Z',
      },
      approval: {
        decision: 'approved',
        receipt_id: 'receipt-loop-2',
        accepted_at: '2026-08-02T22:00:01.000Z',
      },
      artifact: {
        repo: 'lugos',
        path: 'week4/task-loop.json',
        revision: 'proof-123456789abc',
        digest: 'b'.repeat(64),
        created_at: '2026-08-02T22:00:01.000Z',
      },
      receipt_ids: ['receipt-loop-1', 'receipt-loop-2'],
    }],
    ...overrides,
  }
}

export function makeReceiptEvent(receipt = makeReceipt()) {
  return {
    schema: OPERATOR_EVENT_SCHEMA,
    cursor: receipt.receipt_id,
    type: 'command.receipt' as const,
    projection: null,
    value: null,
    receipt,
  }
}
