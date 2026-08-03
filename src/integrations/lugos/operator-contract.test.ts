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
} from './__tests__/fixtures'

describe('Lugos operator contract', () => {
  it('maps Lugos identity fields without translating them into Mission Control IDs', () => {
    const state = stateFromSnapshot(makeSnapshot())
    expect(state.projection?.runs[0]).toMatchObject({
      source_host: '4070pc',
      agent_address: '4070pc/codex',
      run_id: 'hud-week2-adoption',
      repo: 'lugos',
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
})
