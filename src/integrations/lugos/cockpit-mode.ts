import type { OperatorSnapshot } from './operator-contract'

const COCKPIT_PROJECTIONS = new Set([
  'fleet',
  'cockpit-diagnostics',
  'bran-readiness',
])

export function isLugosCockpitEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.MC_LUGOS_COCKPIT === '1'
}

export function applyCockpitRuntimeGate(
  snapshot: OperatorSnapshot,
  enabled = isLugosCockpitEnabled(),
): OperatorSnapshot {
  if (enabled) return snapshot
  return {
    ...snapshot,
    projections: snapshot.projections.filter(
      projection => !COCKPIT_PROJECTIONS.has(projection.name),
    ),
  }
}
