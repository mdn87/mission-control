import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  operatorEventSchema,
  operatorResetSchema,
  operatorSnapshotSchema,
} from './operator-contract'
import {
  applyOperatorEvent,
  stateFromSnapshot,
} from './operator-state'
import {
  makeProjection,
  makeSnapshot,
  makeTaskLoopProjection,
} from './__tests__/fixtures'
import {
  makeBranReadinessProjection,
  makeDiagnosticsProjection,
  makeFleetProjection,
} from './__tests__/cockpit-fixtures'

const FIXTURE_PATH = join(
  process.cwd(),
  'src/integrations/lugos/__tests__/weir-projection-v1.json',
)
const EXPECTED_FIXTURE_SHA256 = '72437efadc23754040e6de43f94193eb6dd110c4db2f34ddb26da7a25313b60d'

interface HudWeirFixture {
  fixture_schema: string
  operator_snapshot: unknown
  snapshot_event: unknown
  delta_event: unknown
  reset_event: unknown
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(
      key => `${JSON.stringify(key)}:${canonical(record[key])}`,
    ).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function fixture(): HudWeirFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as HudWeirFixture
}

function weirProjection() {
  const parsed = operatorSnapshotSchema.parse(fixture().operator_snapshot)
  const projection = parsed.projections.find(item => item.name === 'weir')
  if (!projection || projection.name !== 'weir') throw new Error('WEIR fixture is missing')
  return projection.value
}

describe('HUD WEIR fixture parity', () => {
  it('pins the exact canonical HUD fixture including snapshot, events, and reset', () => {
    const input = fixture()
    const digest = createHash('sha256').update(canonical(input)).digest('hex')
    expect(digest).toBe(EXPECTED_FIXTURE_SHA256)
    expect(input.fixture_schema).toBe('lugos-hud-weir-fixture/v1')
    expect(operatorSnapshotSchema.parse(input.operator_snapshot)).toBeDefined()
    expect(operatorEventSchema.parse(input.snapshot_event)).toBeDefined()
    expect(operatorEventSchema.parse(input.delta_event)).toBeDefined()
    expect(operatorResetSchema.parse(input.reset_event)).toEqual({
      schema: 'lugos-operator-reset/v1',
      reason: 'cursor_expired',
    })
  })

  it('accepts the WEIR projection as the sixth member of a complete HUD snapshot', () => {
    const snapshot = operatorSnapshotSchema.parse(makeSnapshot({
      projections: [
        { name: 'autowork', value: makeProjection() },
        { name: 'task-loop', value: makeTaskLoopProjection() },
        { name: 'fleet', value: makeFleetProjection() },
        { name: 'cockpit-diagnostics', value: makeDiagnosticsProjection() },
        { name: 'bran-readiness', value: makeBranReadinessProjection() },
        { name: 'weir', value: weirProjection() },
      ],
    }))

    const state = stateFromSnapshot(snapshot)
    expect(snapshot.projections).toHaveLength(6)
    expect(state.weir?.actions[0]).toMatchObject({
      run_id: 'run-fixture-1',
      assignment_id: 'assignment-fixture-1',
      correlation_id: 'request-fixture-1',
      action_id: 'action-fixture-1',
      state: 'proposed',
    })
  })

  it('applies WEIR snapshots and deltas without degrading the independent projections', () => {
    const input = fixture()
    const base = stateFromSnapshot(makeSnapshot({
      projections: [
        { name: 'autowork', value: makeProjection() },
        { name: 'task-loop', value: makeTaskLoopProjection() },
      ],
    }))
    const initial = applyOperatorEvent(base, input.snapshot_event)
    const next = applyOperatorEvent(initial, input.delta_event)

    expect(initial.weir?.actions[0].state).toBe('proposed')
    expect(next.weir?.actions[0]).toMatchObject({
      state: 'outcome_unknown',
      reason_code: 'transport_timeout',
    })
    expect(next.weir?.summary).toMatchObject({ attention: 1, outcome_unknown: 1 })
    expect(next.cursor).toBe('event-fixture-2')
    expect(next.projection).toBe(base.projection)
    expect(next.taskLoop).toBe(base.taskLoop)
  })

  it('rejects mismatched cursors, duplicate rows, malformed summaries, and authority data', () => {
    const input = fixture()
    const projection = weirProjection()
    const action = projection.actions[0]

    expect(() => operatorEventSchema.parse({
      ...(input.delta_event as Record<string, unknown>),
      cursor: 'event-other',
    })).toThrow()
    expect(() => operatorSnapshotSchema.parse({
      ...(input.operator_snapshot as Record<string, unknown>),
      projections: [{
        name: 'weir',
        value: {
          ...projection,
          actions: [action, action],
          summary: { ...projection.summary, total: 2, proposed: 2 },
        },
      }],
    })).toThrow()
    expect(() => operatorSnapshotSchema.parse({
      ...(input.operator_snapshot as Record<string, unknown>),
      projections: [{
        name: 'weir',
        value: { ...projection, summary: { ...projection.summary, completed: 1 } },
      }],
    })).toThrow()
    expect(() => operatorSnapshotSchema.parse({
      ...(input.operator_snapshot as Record<string, unknown>),
      projections: [{
        name: 'weir',
        value: {
          ...projection,
          actions: [{ ...action, parameters: { value: 'must-not-cross-boundary' } }],
        },
      }],
    })).toThrow()
  })

  it('contains none of the forbidden unauthenticated projection fields', () => {
    const encoded = JSON.stringify(fixture())
    for (const key of [
      'parameters',
      'form_values',
      'dom',
      'page_content',
      'profile_id',
      'permit',
      'cookie',
      'credential',
      'secret',
      'token',
      'authorization',
    ]) {
      expect(encoded).not.toContain(`"${key}"`)
    }
  })
})
