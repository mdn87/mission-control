import { describe, expect, it } from 'vitest'
import type { AutoworkRun } from './operator-contract'
import { buildSpatialLayout } from './spatial-layout'
import { makeProjection } from './__tests__/fixtures'

function makeRun(overrides: Partial<AutoworkRun>): AutoworkRun {
  const base = makeProjection().runs[0]
  return {
    ...base,
    ...overrides,
    phases: { ...base.phases, ...overrides.phases },
    liveness: { ...base.liveness, ...overrides.liveness },
    terminal: { ...base.terminal, ...overrides.terminal },
  }
}

describe('Lugos semantic spatial layout', () => {
  it('groups machines, route-derived services, and agents without persisted coordinates', () => {
    const projection = makeProjection({
      runs: [
        makeRun({
          run_id: 'run-b',
          source_host: 'applemac',
          agent_address: 'applemac/claude-code',
          route: 'claude-code',
        }),
        makeRun({
          run_id: 'run-a',
          source_host: '4070pc',
          agent_address: '4070pc/codex',
          route: 'codex',
        }),
      ],
    })
    const layout = buildSpatialLayout(projection)

    expect(layout.entities.filter(entity => entity.kind === 'machine').map(entity => entity.label))
      .toEqual(['4070pc', 'applemac'])
    expect(layout.entities.filter(entity => entity.kind === 'service').map(entity => entity.label))
      .toEqual(['claude-code', 'codex'])
    expect(layout.entities.filter(entity => entity.kind === 'agent').map(entity => entity.secondary))
      .toEqual(['4070pc', 'applemac'])
    expect(layout.edges.map(edge => edge.id)).toEqual([
      'agent:4070pc/codex->service:codex',
      'agent:applemac/claude-code->service:claude-code',
      'machine:4070pc->agent:4070pc/codex',
      'machine:applemac->agent:applemac/claude-code',
    ])
  })

  it('is deterministic when run input order changes', () => {
    const runs = [
      makeRun({ run_id: 'run-c', source_host: '3060pc', agent_address: '3060pc/codex' }),
      makeRun({ run_id: 'run-a', source_host: '4070pc', agent_address: '4070pc/codex' }),
      makeRun({ run_id: 'run-b', source_host: 'applemac', agent_address: 'applemac/claude-code' }),
    ]
    const forward = buildSpatialLayout(makeProjection({ runs }))
    const reversed = buildSpatialLayout(makeProjection({ runs: [...runs].reverse() }))
    expect(reversed).toEqual(forward)
  })

  it('keeps attention linear and gives it precedence over liveness and terminal state', () => {
    const layout = buildSpatialLayout(makeProjection({
      runs: [
        makeRun({
          run_id: 'attention-run',
          attention: ['verification_failed', 'approval_required'],
          liveness: { state: 'stale', age_secs: 90 },
          outcome: 'rejected',
        }),
      ],
    }))
    expect(layout.entities.find(entity => entity.kind === 'agent')?.status).toBe('attention')
    expect(layout.attention.map(item => item.code)).toEqual([
      'approval_required',
      'verification_failed',
    ])
    expect(layout.attention.every(item => item.targetEntityId === 'agent:4070pc/codex')).toBe(true)
  })

  it('lays out forty agents inside the fleet canvas without coordinate collisions', () => {
    const runs = Array.from({ length: 40 }, (_, index) => makeRun({
      run_id: `scale-run-${index}`,
      source_host: `host-${Math.floor(index / 10)}`,
      agent_address: `host-${Math.floor(index / 10)}/agent-${index}`,
      route: index % 2 === 0 ? 'codex' : 'claude-code',
    }))
    const agents = buildSpatialLayout(makeProjection({ runs }))
      .entities.filter(entity => entity.kind === 'agent')
    const coordinates = new Set(agents.map(entity => `${entity.x}:${entity.y}`))

    expect(agents).toHaveLength(40)
    expect(coordinates).toHaveLength(40)
    expect(agents.every(entity =>
      entity.x >= 0 && entity.x <= 100 && entity.y >= 0 && entity.y <= 100,
    )).toBe(true)
  })
})
