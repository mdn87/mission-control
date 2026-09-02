import { describe, expect, it } from 'vitest'
import {
  branReadinessProjectionSchema,
  diagnosticsProjectionSchema,
  fleetProjectionSchema,
  networkDevicesProjectionSchema,
} from './cockpit-contract'
import { operatorCommandSchema, operatorSnapshotSchema } from './operator-contract'
import { stateFromSnapshot } from './operator-state'
import { makeSnapshot } from './__tests__/fixtures'
import {
  makeBranReadinessProjection,
  makeDiagnosticsProjection,
  makeFleetProjection,
  makeNetworkDevicesProjection,
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

describe('Mission Control network-devices contract', () => {
  it('accepts the read-only network-devices projection and exposes it on operator state', () => {
    const projection = networkDevicesProjectionSchema.parse(makeNetworkDevicesProjection())
    const snapshot = operatorSnapshotSchema.parse(makeSnapshot({
      projections: [
        ...makeSnapshot().projections,
        { name: 'network-devices', value: projection },
      ],
    }))
    const state = stateFromSnapshot(snapshot)
    expect(state.networkDevices?.summary.new).toBe(2)
    expect(state.networkDevices?.devices[2].targetSlug).toBe('4070pc')
  })

  it('rejects any mutation claim, unknown field, or private notes at the browser boundary', () => {
    const base = makeNetworkDevicesProjection()
    expect(() => networkDevicesProjectionSchema.parse({
      ...base,
      adapter: { ...base.adapter, mutation: 'apply' },
    })).toThrow()
    expect(() => networkDevicesProjectionSchema.parse({
      ...base,
      routerCredential: 'secret',
    })).toThrow()
    expect(() => networkDevicesProjectionSchema.parse({
      ...base,
      devices: [{ ...base.devices[0], notes: 'private' }],
    })).toThrow()
  })

  it('closes the device.add and device.merge command schemas', () => {
    const add = operatorCommandSchema.parse({
      schema: 'lugos-operator-command/v1',
      type: 'device.add',
      idempotency_key: 'mc-1',
      payload: {
        source_device_id: 'dev-00005e005301',
        device_id: 'label-printer',
        name: 'Label printer',
        category: 'printer',
        manufacturer: null,
        model: null,
        location: 'office',
        roles: [],
        notes: null,
        target_slug: null,
      },
    })
    expect(add.type).toBe('device.add')
    expect(() => operatorCommandSchema.parse({
      schema: 'lugos-operator-command/v1',
      type: 'device.add',
      idempotency_key: 'mc-2',
      payload: { source_device_id: 'dev-1', device_id: 'x', name: 'x', category: 'server', manufacturer: null, model: null, location: null, roles: [], notes: null, target_slug: null },
    })).toThrow()
    expect(() => operatorCommandSchema.parse({
      schema: 'lugos-operator-command/v1',
      type: 'device.merge',
      idempotency_key: 'mc-3',
      payload: { source_device_id: 'same', into_device_id: 'same' },
    })).toThrow()
    expect(() => operatorCommandSchema.parse({
      schema: 'lugos-operator-command/v1',
      type: 'reservation.apply',
      idempotency_key: 'mc-4',
      payload: { device_id: 'x', address: '10.0.1.9' },
    })).toThrow()
  })
})
