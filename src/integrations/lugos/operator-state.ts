import {
  operatorEventSchema,
  operatorSnapshotSchema,
  type AutoworkDelta,
  type AutoworkProjection,
  type OperatorEvent,
  type OperatorReceipt,
  type OperatorSnapshot,
  type TaskLoopDelta,
  type TaskLoopProjection,
  type WeirAction,
  type WeirDelta,
  type WeirProjection,
} from './operator-contract'
import type {
  BranReadinessProjection,
  DiagnosticsProjection,
  FleetProjection,
  NetworkDevicesProjection,
} from './cockpit-contract'

export interface LugosOperatorState {
  cursor: string | null
  projection: AutoworkProjection | null
  taskLoop: TaskLoopProjection | null
  fleet: FleetProjection | null
  diagnostics: DiagnosticsProjection | null
  branReadiness: BranReadinessProjection | null
  weir: WeirProjection | null
  networkDevices: NetworkDevicesProjection | null
  receipts: OperatorReceipt[]
}

export const EMPTY_LUGOS_OPERATOR_STATE: LugosOperatorState = {
  cursor: null,
  projection: null,
  taskLoop: null,
  fleet: null,
  diagnostics: null,
  branReadiness: null,
  weir: null,
  networkDevices: null,
  receipts: [],
}

function asSnapshot(
  value: AutoworkProjection | AutoworkDelta,
): AutoworkProjection {
  return { ...value, schema: 'lugos-hud-autowork/v1' }
}

function asTaskLoopSnapshot(
  value: TaskLoopProjection | TaskLoopDelta,
): TaskLoopProjection {
  return { ...value, schema: 'lugos-task-loop/v1' }
}

function summarizeWeirActions(actions: WeirAction[]): WeirProjection['summary'] {
  return {
    total: actions.length,
    proposed: actions.filter(action => action.state === 'proposed').length,
    permit_received: actions.filter(action => action.state === 'permit_received').length,
    completed: actions.filter(action => action.state === 'completed').length,
    attention: actions.filter(action => (
      action.state === 'failed'
      || action.state === 'blocked'
      || action.state === 'outcome_unknown'
    )).length,
    outcome_unknown: actions.filter(action => action.state === 'outcome_unknown').length,
  }
}

function asWeirSnapshot(
  value: WeirProjection | WeirDelta,
): WeirProjection {
  return { ...value, schema: 'lugos-hud-weir/v1' }
}

function mergeReceipts(
  current: OperatorReceipt[],
  incoming: OperatorReceipt[],
): OperatorReceipt[] {
  const byId = new Map(current.map(receipt => [receipt.receipt_id, receipt]))
  for (const receipt of incoming) byId.set(receipt.receipt_id, receipt)
  return [...byId.values()].sort((left, right) =>
    right.accepted_at.localeCompare(left.accepted_at),
  )
}

export function stateFromSnapshot(input: unknown): LugosOperatorState {
  const snapshot: OperatorSnapshot = operatorSnapshotSchema.parse(input)
  return {
    cursor: snapshot.cursor,
    projection: snapshot.projections.find(item => item.name === 'autowork')?.value ?? null,
    taskLoop: snapshot.projections.find(item => item.name === 'task-loop')?.value ?? null,
    fleet: snapshot.projections.find(item => item.name === 'fleet')?.value ?? null,
    diagnostics: snapshot.projections.find(item => item.name === 'cockpit-diagnostics')?.value ?? null,
    branReadiness: snapshot.projections.find(item => item.name === 'bran-readiness')?.value ?? null,
    weir: snapshot.projections.find(item => item.name === 'weir')?.value ?? null,
    networkDevices: snapshot.projections.find(item => item.name === 'network-devices')?.value ?? null,
    receipts: mergeReceipts([], snapshot.receipts),
  }
}

export function applyOperatorEvent(
  state: LugosOperatorState,
  input: unknown,
): LugosOperatorState {
  const event: OperatorEvent = operatorEventSchema.parse(input)
  if (event.type === 'command.receipt') {
    return {
      ...state,
      cursor: event.cursor,
      receipts: mergeReceipts(state.receipts, [event.receipt]),
    }
  }
  if (event.projection === 'task-loop') {
    return {
      ...state,
      cursor: event.cursor,
      taskLoop: asTaskLoopSnapshot(event.value),
    }
  }
  if (event.projection === 'weir') {
    if (event.type === 'projection.snapshot' || state.weir === null) {
      return { ...state, cursor: event.cursor, weir: asWeirSnapshot(event.value) }
    }
    const actions = new Map(state.weir.actions.map(action => [action.proposal_hash, action]))
    for (const action of event.value.actions) actions.set(action.proposal_hash, action)
    const merged = [...actions.values()].sort((left, right) =>
      right.occurred_at.localeCompare(left.occurred_at)
      || left.proposal_hash.localeCompare(right.proposal_hash),
    ).slice(0, 256)
    return {
      ...state,
      cursor: event.cursor,
      weir: {
        ...asWeirSnapshot(event.value),
        summary: summarizeWeirActions(merged),
        actions: merged,
      },
    }
  }
  if (event.type === 'projection.snapshot' || state.projection === null) {
    return { ...state, cursor: event.cursor, projection: asSnapshot(event.value) }
  }

  const runs = new Map(state.projection.runs.map(run => [run.run_id, run]))
  for (const run of event.value.runs) runs.set(run.run_id, run)
  return {
    ...state,
    cursor: event.cursor,
    projection: { ...asSnapshot(event.value), runs: [...runs.values()] },
  }
}

export function addOperatorReceipt(
  state: LugosOperatorState,
  receipt: OperatorReceipt,
): LugosOperatorState {
  return {
    ...state,
    cursor: receipt.receipt_id,
    receipts: mergeReceipts(state.receipts, [receipt]),
  }
}
