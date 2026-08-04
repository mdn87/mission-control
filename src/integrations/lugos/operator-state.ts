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
} from './operator-contract'
import type {
  BranReadinessProjection,
  DiagnosticsProjection,
  FleetProjection,
} from './cockpit-contract'

export interface LugosOperatorState {
  cursor: string | null
  projection: AutoworkProjection | null
  taskLoop: TaskLoopProjection | null
  fleet: FleetProjection | null
  diagnostics: DiagnosticsProjection | null
  branReadiness: BranReadinessProjection | null
  receipts: OperatorReceipt[]
}

export const EMPTY_LUGOS_OPERATOR_STATE: LugosOperatorState = {
  cursor: null,
  projection: null,
  taskLoop: null,
  fleet: null,
  diagnostics: null,
  branReadiness: null,
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
