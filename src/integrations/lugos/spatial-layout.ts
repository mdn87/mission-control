import type {
  AutoworkProjection,
  AutoworkRun,
} from './operator-contract'

export type SpatialEntityKind = 'machine' | 'service' | 'agent'
export type SpatialStatus =
  | 'attention'
  | 'degraded'
  | 'stale'
  | 'active'
  | 'terminal'
  | 'idle'

export interface SpatialEntity {
  id: string
  kind: SpatialEntityKind
  label: string
  secondary: string
  status: SpatialStatus
  x: number
  y: number
  runIds: string[]
}

export interface SpatialEdge {
  id: string
  from: string
  to: string
  active: boolean
}

export interface AttentionItem {
  id: string
  code: string
  runId: string
  sourceHost: string
  agentAddress: string
  targetEntityId: string
}

export interface SpatialLayout {
  entities: SpatialEntity[]
  edges: SpatialEdge[]
  attention: AttentionItem[]
}

const STATUS_WEIGHT: Record<SpatialStatus, number> = {
  idle: 0,
  terminal: 1,
  active: 2,
  stale: 3,
  degraded: 4,
  attention: 5,
}

function runStatus(run: AutoworkRun): SpatialStatus {
  if (run.attention.length > 0) return 'attention'
  if (Object.values(run.phases).some(state => state === 'failed' || state === 'blocked')) {
    return 'degraded'
  }
  if (run.liveness.state === 'stale') return 'stale'
  if (run.outcome && run.outcome !== 'unknown') return 'terminal'
  if (Object.values(run.phases).includes('active') && run.liveness.state === 'active') {
    return 'active'
  }
  return 'idle'
}

function aggregateStatus(runs: AutoworkRun[]): SpatialStatus {
  return runs
    .map(runStatus)
    .sort((left, right) => STATUS_WEIGHT[right] - STATUS_WEIGHT[left])[0] ?? 'idle'
}

function evenlySpaced(index: number, count: number, start = 12, end = 88): number {
  if (count <= 1) return (start + end) / 2
  return start + (index * (end - start)) / (count - 1)
}

function positionAgents(
  host: string,
  hostIndex: number,
  hostCount: number,
  runs: AutoworkRun[],
): SpatialEntity[] {
  const byAgent = new Map<string, AutoworkRun[]>()
  for (const run of runs) {
    const address = run.agent_address || `${host}/unaddressed`
    const bucket = byAgent.get(address) ?? []
    bucket.push(run)
    byAgent.set(address, bucket)
  }
  const groups = [...byAgent.entries()].sort(([left], [right]) => left.localeCompare(right))
  const bandHeight = 76 / Math.max(hostCount, 1)
  const bandStart = 12 + hostIndex * bandHeight
  const rows = Math.min(5, Math.max(1, Math.ceil(Math.sqrt(groups.length))))
  const columns = Math.ceil(groups.length / rows)

  return groups.map(([address, agentRuns], index) => {
    const column = Math.floor(index / rows)
    const row = index % rows
    const yPadding = Math.min(3, bandHeight / 8)
    return {
      id: `agent:${address}`,
      kind: 'agent',
      label: address.includes('/') ? address.split('/').at(-1) ?? address : address,
      secondary: host,
      status: aggregateStatus(agentRuns),
      x: columns <= 1 ? 84 : evenlySpaced(column, columns, 73, 93),
      y: evenlySpaced(row, Math.min(rows, groups.length), bandStart + yPadding, bandStart + bandHeight - yPadding),
      runIds: agentRuns.map(run => run.run_id).sort(),
    }
  })
}

export function buildSpatialLayout(projection: AutoworkProjection): SpatialLayout {
  const runs = [...projection.runs].sort((left, right) =>
    `${left.source_host}/${left.agent_address}/${left.run_id}`.localeCompare(
      `${right.source_host}/${right.agent_address}/${right.run_id}`,
    ),
  )
  const byHost = new Map<string, AutoworkRun[]>()
  const byRoute = new Map<string, AutoworkRun[]>()

  for (const run of runs) {
    const host = run.source_host || projection.source.host
    const hostRuns = byHost.get(host) ?? []
    hostRuns.push(run)
    byHost.set(host, hostRuns)

    const route = run.route || 'unrouted'
    const routeRuns = byRoute.get(route) ?? []
    routeRuns.push(run)
    byRoute.set(route, routeRuns)
  }

  if (byHost.size === 0) byHost.set(projection.source.host, [])

  const hosts = [...byHost.entries()].sort(([left], [right]) => left.localeCompare(right))
  const machines: SpatialEntity[] = hosts.map(([host, hostRuns], index) => ({
    id: `machine:${host}`,
    kind: 'machine',
    label: host,
    secondary: `${hostRuns.length} run${hostRuns.length === 1 ? '' : 's'}`,
    status: aggregateStatus(hostRuns),
    x: 10,
    y: evenlySpaced(index, hosts.length),
    runIds: hostRuns.map(run => run.run_id).sort(),
  }))

  const routes = [...byRoute.entries()].sort(([left], [right]) => left.localeCompare(right))
  const services: SpatialEntity[] = routes.map(([route, routeRuns], index) => ({
    id: `service:${route}`,
    kind: 'service',
    label: route,
    secondary: 'derived route',
    status: aggregateStatus(routeRuns),
    x: 48,
    y: evenlySpaced(index, routes.length),
    runIds: routeRuns.map(run => run.run_id).sort(),
  }))

  const agents = hosts.flatMap(([host, hostRuns], index) =>
    positionAgents(host, index, hosts.length, hostRuns),
  )
  const entityById = new Map(
    [...machines, ...services, ...agents].map(entity => [entity.id, entity]),
  )
  const edgeById = new Map<string, SpatialEdge>()

  for (const run of runs) {
    const host = run.source_host || projection.source.host
    const address = run.agent_address || `${host}/unaddressed`
    const route = run.route || 'unrouted'
    const active = runStatus(run) === 'active'
    for (const [from, to] of [
      [`machine:${host}`, `agent:${address}`],
      [`agent:${address}`, `service:${route}`],
    ]) {
      const id = `${from}->${to}`
      const previous = edgeById.get(id)
      edgeById.set(id, { id, from, to, active: previous?.active === true || active })
    }
  }

  const attention = runs.flatMap(run =>
    run.attention.map((code, index) => ({
      id: `${run.run_id}:${code}:${index}`,
      code,
      runId: run.run_id,
      sourceHost: run.source_host || projection.source.host,
      agentAddress: run.agent_address,
      targetEntityId: entityById.has(`agent:${run.agent_address}`)
        ? `agent:${run.agent_address}`
        : `machine:${run.source_host || projection.source.host}`,
    })),
  ).sort((left, right) =>
    `${left.code}/${left.runId}`.localeCompare(`${right.code}/${right.runId}`),
  )

  return {
    entities: [...machines, ...services, ...agents],
    edges: [...edgeById.values()].sort((left, right) => left.id.localeCompare(right.id)),
    attention,
  }
}
