import { describe, expect, it } from 'vitest'
import {
  branReadinessProjectionSchema,
  diagnosticsProjectionSchema,
  fleetProjectionSchema,
} from './cockpit-contract'
import { operatorSnapshotSchema } from './operator-contract'
import { stateFromSnapshot } from './operator-state'
import { makeSnapshot } from './__tests__/fixtures'
import {
  makeBranReadinessProjection,
  makeDiagnosticsProjection,
  makeFleetProjection,
} from './__tests__/cockpit-fixtures'

describe('Mission Control cockpit contracts', () => {
  it('accepts the three exact versioned snapshot-only projections', () => {
    const fleet = fleetProjectionSchema.parse(makeFleetProjection())
    const diagnostics = diagnosticsProjectionSchema.parse(makeDiagnosticsProjection())
    const bran = branReadinessProjectionSchema.parse(makeBranReadinessProjection())
    const snapshot = operatorSnapshotSchema.parse(makeSnapshot({
      projections: [
        ...makeSnapshot().projections,
        { name: 'fleet', value: fleet },
        { name: 'cockpit-diagnostics', value: diagnostics },
        { name: 'bran-readiness', value: bran },
      ],
    }))
    const state = stateFromSnapshot(snapshot)
    expect(state.fleet?.summary.connectedAgents).toBe(1)
    expect(state.diagnostics?.governance.warningMultiplier).toBe(1.5)
    expect(state.branReadiness?.packs[0].readyRef).toBe('operator-handbook@2')
  })

  it('rejects unknown fields and private service details at the browser boundary', () => {
    expect(() => fleetProjectionSchema.parse({
      ...makeFleetProjection(),
      agentMailUrl: 'http://127.0.0.1:8490',
    })).toThrow()
    expect(() => diagnosticsProjectionSchema.parse({
      ...makeDiagnosticsProjection(),
      models: {
        ...makeDiagnosticsProjection().models,
        gateway: {
          ...makeDiagnosticsProjection().models.gateway,
          bearer: 'server-secret',
        },
      },
    })).toThrow()
    expect(() => branReadinessProjectionSchema.parse({
      ...makeBranReadinessProjection(),
      packs: [{
        ...makeBranReadinessProjection().packs[0],
        custodyPath: '/srv/lugos/state/bran/packs/operator-handbook',
      }],
    })).toThrow()
  })

  it('does not define cockpit delta event types or command types', () => {
    expect(() => operatorSnapshotSchema.parse({
      ...makeSnapshot(),
      projections: [{
        name: 'fleet',
        value: {
          ...makeFleetProjection(),
          schema: 'lugos-fleet-delta/v1',
        },
      }],
    })).toThrow()
  })
})
