import { describe, expect, it } from 'vitest'
import { applyCockpitRuntimeGate, isLugosCockpitEnabled } from './cockpit-mode'
import { makeSnapshot } from './__tests__/fixtures'
import {
  makeBranReadinessProjection,
  makeDiagnosticsProjection,
  makeFleetProjection,
} from './__tests__/cockpit-fixtures'

function cockpitSnapshot() {
  return makeSnapshot({
    projections: [
      ...makeSnapshot().projections,
      { name: 'fleet', value: makeFleetProjection() },
      { name: 'cockpit-diagnostics', value: makeDiagnosticsProjection() },
      { name: 'bran-readiness', value: makeBranReadinessProjection() },
    ],
  })
}

describe('Mission Control cockpit runtime gate', () => {
  it('is a server runtime flag, disabled unless explicitly set to 1', () => {
    expect(isLugosCockpitEnabled({})).toBe(false)
    expect(isLugosCockpitEnabled({ MC_LUGOS_COCKPIT: '0' })).toBe(false)
    expect(isLugosCockpitEnabled({ MC_LUGOS_COCKPIT: '1' })).toBe(true)
  })

  it('removes only cockpit projections when disabled', () => {
    const filtered = applyCockpitRuntimeGate(cockpitSnapshot(), false)
    expect(filtered.projections.map(item => item.name)).toEqual(['autowork'])
    expect(filtered.cursor).toBe(cockpitSnapshot().cursor)
    expect(filtered.receipts).toEqual(cockpitSnapshot().receipts)
  })

  it('returns the immutable release snapshot unchanged when enabled', () => {
    const snapshot = cockpitSnapshot()
    expect(applyCockpitRuntimeGate(snapshot, true)).toBe(snapshot)
  })
})
