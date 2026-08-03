import { describe, expect, it } from 'vitest'
import {
  operatorEventSchema,
  operatorSnapshotSchema,
} from './operator-contract'
import {
  EMPTY_LUGOS_OPERATOR_STATE,
  applyOperatorEvent,
  stateFromSnapshot,
} from './operator-state'
import {
  makeDelta,
  makeProjection,
  makeReceipt,
  makeReceiptEvent,
  makeSnapshot,
  makeTaskLoopProjection,
} from './__tests__/fixtures'

describe('Lugos operator contract', () => {
  it('maps Lugos identity fields without translating them into Mission Control IDs', () => {
    const state = stateFromSnapshot(makeSnapshot({
      projections: [
        { name: 'autowork', value: makeProjection() },
        { name: 'task-loop', value: makeTaskLoopProjection() },
      ],
    }))
    expect(state.projection?.runs[0]).toMatchObject({
      source_host: '4070pc',
      agent_address: '4070pc/codex',
      run_id: 'hud-week2-adoption',
      repo: 'lugos',
    })
    expect(state.taskLoop?.loops[0]).toMatchObject({
      loop_id: 'mail:41',
      handoff: { message_id: 41 },
      approval: { receipt_id: 'receipt-loop-2' },
      artifact: { path: 'week4/task-loop.json' },
      receipt_ids: ['receipt-loop-1', 'receipt-loop-2'],
    })
  })

  it('fails closed when the upstream adds an unversioned field', () => {
    const snapshot = makeSnapshot() as unknown as Record<string, unknown>
    snapshot.missionControlOwner = true
    expect(() => operatorSnapshotSchema.parse(snapshot)).toThrow()
  })

  it('merges a replayed delta by Lugos run_id and preserves other runs', () => {
    const initial = stateFromSnapshot(makeSnapshot({
      projections: [{
        name: 'autowork',
        value: makeProjection({
          runs: [
            makeProjection().runs[0],
            { ...makeProjection().runs[0], run_id: 'older-run' },
          ],
        }),
      }],
    }))
    const delta = makeDelta({
      runs: [{
        ...makeProjection().runs[0],
        current_phase: 'review',
        phases: { ...makeProjection().runs[0].phases, work: 'succeeded', review: 'active' },
      }],
    })
    const next = applyOperatorEvent(initial, {
      schema: 'lugos-operator-event/v1',
      cursor: 'event-0003',
      type: 'projection.delta',
      projection: 'autowork',
      value: delta,
      receipt: null,
    })
    expect(next.projection?.runs).toHaveLength(2)
    expect(next.projection?.runs.find(run => run.run_id === 'hud-week2-adoption')?.current_phase)
      .toBe('review')
  })

  it('keeps Lugos receipt identity authoritative during event replay', () => {
    const receipt = makeReceipt()
    expect(operatorEventSchema.parse(makeReceiptEvent(receipt)).receipt).toEqual(receipt)
    const state = applyOperatorEvent(EMPTY_LUGOS_OPERATOR_STATE, makeReceiptEvent(receipt))
    expect(state.cursor).toBe(receipt.receipt_id)
    expect(state.receipts).toEqual([receipt])
  })

  it('replaces the bounded task-loop projection during replay', () => {
    const initial = stateFromSnapshot(makeSnapshot({
      projections: [
        { name: 'autowork', value: makeProjection() },
        { name: 'task-loop', value: makeTaskLoopProjection() },
      ],
    }))
    const nextProjection = makeTaskLoopProjection({
      schema: 'lugos-task-loop/v1',
      cursor: 'receipt-loop-3',
      loops: [],
      summary: { awaiting_approval: 0, artifact_ready: 0 },
    })
    const next = applyOperatorEvent(initial, {
      schema: 'lugos-operator-event/v1',
      cursor: 'receipt-loop-3',
      type: 'projection.delta',
      projection: 'task-loop',
      value: { ...nextProjection, schema: 'lugos-task-loop-delta/v1' },
      receipt: null,
    })
    expect(next.taskLoop?.loops).toEqual([])
    expect(next.taskLoop?.cursor).toBe('receipt-loop-3')
    expect(next.projection).toEqual(initial.projection)
  })
})
