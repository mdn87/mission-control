import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTOWORK_DELTA_SCHEMA,
  AUTOWORK_SNAPSHOT_SCHEMA,
  OPERATOR_EVENT_SCHEMA,
  OPERATOR_RESET_SCHEMA,
  type AutoworkProjection,
  type OperatorSnapshot,
} from './operator-contract'
import {
  applyOperatorEvent,
  stateFromSnapshot,
  type LugosOperatorState,
} from './operator-state'
import { useLugosOperator } from './use-lugos-operator'
import {
  makeProjection,
  makeReceipt,
  makeReceiptEvent,
  makeSnapshot,
  makeTaskLoopProjection,
} from './__tests__/fixtures'

// LIP-007 freshness probe. Mounts the real hook with a fake EventSource and a
// queue of deferred fetches so the real apiFetch, reducers and contract run.

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  closed = false
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  private listeners = new Map<string, Array<(message: { data: string }) => void>>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (message: { data: string }) => void) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  close() {
    this.closed = true
  }

  emit(type: string, payload: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(payload) })
    }
  }
}

interface PendingFetch {
  url: string
  settled: boolean
  resolve: (response: Response) => void
}

let fetches: PendingFetch[] = []

function fakeFetch(input: RequestInfo | URL) {
  return new Promise<Response>(resolve => {
    const entry: PendingFetch = {
      url: String(input),
      settled: false,
      resolve: response => {
        entry.settled = true
        resolve(response)
      },
    }
    fetches.push(entry)
  })
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  })
}

async function respond(index: number, body: OperatorSnapshot) {
  await act(async () => {
    fetches[index].resolve(Response.json(body))
  })
  await flush()
}

async function respondStatus(index: number, status: number) {
  await act(async () => {
    fetches[index].resolve(Response.json({ error: 'snapshot unavailable' }, { status }))
  })
  await flush()
}

async function emit(type: string, payload: unknown, source = latestSource()) {
  await act(async () => {
    source.emit(type, payload)
  })
}

async function advancePoll() {
  await act(async () => {
    vi.advanceTimersByTime(30_000)
  })
}

function latestSource() {
  return FakeEventSource.instances[FakeEventSource.instances.length - 1]
}

function counters(label: string) {
  const record = {
    case: label,
    fetchIssued: fetches.length,
    fetchResolved: fetches.filter(entry => entry.settled).length,
    eventSources: FakeEventSource.instances.map(source => ({
      url: source.url,
      closed: source.closed,
    })),
  }
  console.info(`[lip-007 counters] ${JSON.stringify(record)}`)
  return record
}

const baseRun = makeProjection().runs[0]

function run(overrides: Partial<typeof baseRun> = {}) {
  return { ...baseRun, ...overrides }
}

function projection(overrides: Partial<AutoworkProjection> = {}): AutoworkProjection {
  return makeProjection({
    runs: [run(), run({ run_id: 'older-run' })],
    ...overrides,
  })
}

function snapshot(
  cursor: string,
  autowork: AutoworkProjection,
  overrides: Partial<OperatorSnapshot> = {},
): OperatorSnapshot {
  return makeSnapshot({
    cursor,
    projections: [
      { name: 'autowork', value: { ...autowork, cursor } },
      { name: 'task-loop', value: makeTaskLoopProjection() },
    ],
    receipts: [],
    ...overrides,
  })
}

function delta(cursor: string, runs: AutoworkProjection['runs'], extra: Partial<AutoworkProjection> = {}) {
  return {
    schema: OPERATOR_EVENT_SCHEMA,
    cursor,
    type: 'projection.delta' as const,
    projection: 'autowork' as const,
    value: {
      ...projection(),
      ...extra,
      schema: AUTOWORK_DELTA_SCHEMA,
      cursor,
      runs,
    },
    receipt: null,
  }
}

const reset = { schema: OPERATOR_RESET_SCHEMA, reason: 'cursor_expired' }

const S0 = snapshot('evt-m', projection())
const B = delta('evt-n', [run({
  current_phase: 'outcome',
  outcome: 'accepted',
  liveness: { state: 'unknown', age_secs: null },
})])
const R2 = makeReceiptEvent(makeReceipt({
  receipt_id: 'receipt-0002',
  idempotency_key: 'mc-command-0002',
  accepted_at: '2026-08-02T20:02:00.000Z',
}))

function withEvents(base: LugosOperatorState, ...events: unknown[]) {
  return events.reduce<LugosOperatorState>((state, event) => applyOperatorEvent(state, event), base)
}

async function mountWithS0() {
  const hook = renderHook(() => useLugosOperator())
  expect(fetches).toHaveLength(1)
  await respond(0, S0)
  expect(hook.result.current.loading).toBe(false)
  expect(FakeEventSource.instances.map(source => source.url)).toEqual([
    '/api/lugos/events?after=evt-m',
  ])
  return hook
}

beforeEach(() => {
  fetches = []
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})

afterEach(() => {
  counters(expect.getState().currentTestName ?? 'unknown')
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('LIP-007 C1 stale poll after a terminal event', () => {
  it('baseline: poll resolves before the event and receipt', async () => {
    const { result } = await mountWithS0()
    await advancePoll()
    expect(fetches).toHaveLength(2)
    await respond(1, S0)
    await emit('operator', B)
    await emit('operator', R2)
    expect(result.current.operatorState).toEqual(withEvents(stateFromSnapshot(S0), B, R2))
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it('defect: poll issued before B resolves after B and its receipt', async () => {
    const { result } = await mountWithS0()
    await advancePoll()
    expect(fetches).toHaveLength(2)
    await emit('operator', B)
    await emit('operator', R2)
    await respond(1, S0)
    // C1 named assertion: state equals S0 plus B and the receipt.
    expect(result.current.operatorState).toEqual(withEvents(stateFromSnapshot(S0), B, R2))
    expect(FakeEventSource.instances).toHaveLength(1)
  })
})

describe('LIP-007 C2 reverse order', () => {
  const P1 = snapshot('evt-z', projection({ runs: [run({ current_phase: 'review' }), run({ run_id: 'older-run' })] }))
  const P2 = snapshot('evt-a', projection({ runs: [run({ current_phase: 'verify' }), run({ run_id: 'older-run' })] }))

  it('baseline: interval poll resolves before reload', async () => {
    const { result } = await mountWithS0()
    await advancePoll()
    await act(async () => { void result.current.reload() })
    expect(fetches).toHaveLength(3)
    await respond(1, P1)
    await respond(2, P2)
    expect(result.current.operatorState).toEqual(stateFromSnapshot(P2))
  })

  it('defect: older poll P1 resolves after newer reload P2', async () => {
    const { result } = await mountWithS0()
    await advancePoll()
    await act(async () => { void result.current.reload() })
    expect(fetches).toHaveLength(3)
    await respond(2, P2)
    await respond(1, P1)
    // C2 named assertion (state only): state equals P2.
    expect(result.current.operatorState).toEqual(stateFromSnapshot(P2))
  })
})

describe('LIP-007 C3 reset', () => {
  const P = snapshot('evt-p', projection({ runs: [run({ current_phase: 'review' }), run({ run_id: 'older-run' })] }))
  const R = snapshot('evt-r', projection({ runs: [run({ current_phase: 'verify' }), run({ run_id: 'older-run' })] }))

  it('baseline: poll resolves before the reset, then R', async () => {
    const { result } = await mountWithS0()
    await advancePoll()
    await respond(1, P)
    await emit('reset', reset)
    expect(result.current.loading).toBe(true)
    await respond(2, R)
    expect(result.current.operatorState).toEqual(stateFromSnapshot(R))
    // P's cursor is unknown to the stream, so the corrected hook may reopen once
    // for it; the baseline asserts only the final open stream.
    const open = FakeEventSource.instances.filter(source => !source.closed)
    expect(open.map(source => source.url)).toEqual(['/api/lugos/events?after=evt-r'])
  })

  it('3a defect: R resolves, then the stale poll P', async () => {
    const hook = await mountWithS0()
    await advancePoll()
    await emit('reset', reset)
    expect(FakeEventSource.instances[0].closed).toBe(true)
    expect(hook.result.current.loading).toBe(true)
    expect(fetches).toHaveLength(3)
    await respond(2, R)
    await respond(1, P)
    // C3a named assertion: state equals R, one new stream ?after=evt-r.
    expect(hook.result.current.operatorState).toEqual(stateFromSnapshot(R))
    expect(FakeEventSource.instances.map(source => source.url)).toEqual([
      '/api/lugos/events?after=evt-m',
      '/api/lugos/events?after=evt-r',
    ])
  })

  it('3b-1 defect: stale poll P resolves while R is in flight', async () => {
    const hook = await mountWithS0()
    await advancePoll()
    await emit('reset', reset)
    expect(fetches).toHaveLength(3)
    await respond(1, P)
    // C3b-1 named assertion: loading still true, no new stream.
    expect({ loading: hook.result.current.loading, streams: FakeEventSource.instances.length })
      .toEqual({ loading: true, streams: 1 })
  })

  it('3b-2 defect: then R resolves', async () => {
    const hook = await mountWithS0()
    await advancePoll()
    await emit('reset', reset)
    await respond(1, P)
    await respond(2, R)
    // C3b-2 named assertion: state R, exactly one post-reset stream ?after=evt-r.
    expect(hook.result.current.operatorState).toEqual(stateFromSnapshot(R))
    expect(FakeEventSource.instances.map(source => source.url)).toEqual([
      '/api/lugos/events?after=evt-m',
      '/api/lugos/events?after=evt-r',
    ])
  })

  it('3c record: the post-reset snapshot is rejected with 502 (Q2)', async () => {
    const hook = await mountWithS0()
    await emit('reset', reset)
    expect(fetches).toHaveLength(2)
    await respondStatus(1, 502)
    const observed = {
      error: hook.result.current.error,
      loading: hook.result.current.loading,
      urls: FakeEventSource.instances.map(source => source.url),
    }
    console.info(`[lip-007 3c observed] ${JSON.stringify(observed)}`)
    expect(observed.loading).toBe(false)
  })
})

describe('LIP-007 C4 eventual resynchronization', () => {
  it('a later snapshot carrying a change no event carries is applied', async () => {
    const { result } = await mountWithS0()
    await advancePoll()
    await emit('operator', B)
    await emit('operator', R2)
    await respond(1, S0)
    const streamsBefore = FakeEventSource.instances.length
    await advancePoll()
    expect(fetches).toHaveLength(3)
    const C = snapshot('receipt-0002', projection({
      runs: [
        run({ current_phase: 'outcome', outcome: 'accepted', liveness: { state: 'unknown', age_secs: null } }),
        run({ run_id: 'older-run', current_phase: 'review' }),
      ],
    }), {
      receipts: [
        R2.receipt,
        makeReceipt({ receipt_id: 'receipt-0003', idempotency_key: 'mc-command-0003', accepted_at: '2026-08-02T20:03:00.000Z' }),
      ],
    })
    await respond(2, C)
    expect(result.current.operatorState).toEqual(stateFromSnapshot(C))
    expect(FakeEventSource.instances).toHaveLength(streamsBefore)
  })
})

describe('LIP-007 C5 overlap', () => {
  it('5a: continuous overlap, one delta during each of three polls', async () => {
    const { result } = await mountWithS0()
    let body = S0
    for (let index = 1; index <= 3; index += 1) {
      await advancePoll()
      expect(fetches).toHaveLength(index + 1)
      const event = delta(`evt-d${index}`, [run({ elapsed_ms: 120000 + index * 1000 })])
      await emit('operator', event)
      // Each body also carries a change no event carries (older-run elapsed_ms),
      // so a rule that drops the overlapped snapshot is visible.
      const autowork = body.projections.find(item => item.name === 'autowork')!.value as AutoworkProjection
      const served: OperatorSnapshot = {
        ...body,
        projections: [
          {
            name: 'autowork',
            value: {
              ...autowork,
              runs: autowork.runs.map(item => item.run_id === 'older-run'
                ? { ...item, elapsed_ms: 1_000_000 + index }
                : item),
            },
          },
          ...body.projections.filter(item => item.name !== 'autowork'),
        ],
      }
      await respond(index, served)
      const expected = applyOperatorEvent(stateFromSnapshot(served), event)
      // C5a named assertion: snapshot plus its overlapping delta, no reopen.
      expect(result.current.operatorState).toEqual(expected)
      expect(FakeEventSource.instances).toHaveLength(1)
      body = makeSnapshot({
        cursor: event.cursor,
        projections: [
          { name: 'autowork', value: { ...(expected.projection as AutoworkProjection), schema: AUTOWORK_SNAPSHOT_SCHEMA } },
          { name: 'task-loop', value: makeTaskLoopProjection() },
        ],
        receipts: [],
      })
    }
  })

  it('5b: reload overlapped by its own command receipt (control)', async () => {
    const { result } = await mountWithS0()
    await act(async () => { void result.current.reload() })
    expect(fetches).toHaveLength(2)
    const receipt = makeReceipt({ receipt_id: 'receipt-0004', idempotency_key: 'mc-command-0004', accepted_at: '2026-08-02T20:04:00.000Z' })
    await emit('operator', makeReceiptEvent(receipt))
    const body = snapshot('receipt-0004', projection(), {
      projections: [
        { name: 'autowork', value: { ...projection(), cursor: 'receipt-0004' } },
        {
          name: 'task-loop',
          value: makeTaskLoopProjection({
            cursor: 'receipt-0004',
            loops: [],
            summary: { awaiting_approval: 0, artifact_ready: 0 },
          }),
        },
      ],
      receipts: [receipt],
    })
    await respond(1, body)
    expect(result.current.operatorState).toEqual(stateFromSnapshot(body))
  })
})

describe('LIP-007 C6 snapshot fresher than the buffer', () => {
  const fresher = () => snapshot('evt-c', projection({
    generatedAt: '2026-08-02T20:05:00.000Z',
    source: { host: '4070pc', state: 'ready', lastReceiptAt: '2026-08-02T20:05:00.000Z', diagnostics: [] },
    summary: { active: 0, attention: 0, terminal24h: 1, accepted24h: 1, firstPassVerified24h: 1 },
    runs: [run({ current_phase: 'outcome', outcome: 'accepted' }), run({ run_id: 'older-run', current_phase: 'verify' })],
  }))

  async function overlapThenFresher() {
    const hook = await mountWithS0()
    await advancePoll()
    await emit('operator', delta('evt-a', [run({ current_phase: 'review' })]))
    await emit('operator', delta('evt-b', [run({ current_phase: 'verify' })]))
    const P = fresher()
    await respond(1, P)
    return { ...hook, P }
  }

  it('C6-state: state equals the fresher snapshot exactly', async () => {
    const { result, P } = await overlapThenFresher()
    expect(result.current.operatorState).toEqual(stateFromSnapshot(P))
  })

  it('C6-reopen: one new stream ?after=evt-c and the previous closed', async () => {
    await overlapThenFresher()
    // C6-reopen named assertion.
    expect(FakeEventSource.instances.map(source => ({ url: source.url, closed: source.closed }))).toEqual([
      { url: '/api/lugos/events?after=evt-m', closed: true },
      { url: '/api/lugos/events?after=evt-c', closed: false },
    ])
  })
})

describe('LIP-007 C7 reset loop while the snapshot route fails (Q2)', () => {
  // Models lugos-hud events.mjs replayAfter: an unknown cursor gets a reset
  // frame (lines 42-44); no cursor gets the whole ring and never a reset
  // (lines 39-41). evt-m has expired; the ring holds only evt-x1.
  const ring = [delta('evt-x1', [run({ current_phase: 'verify' })])]
  // Rounds of server play per window; reaching it means the client never went quiet.
  const CAP = 25

  function afterOf(source: FakeEventSource) {
    return new URL(source.url, 'http://mc.test').searchParams.get('after')
  }

  // Plays the server for every pending fetch (502) and every new stream (reset
  // or ring replay) until nothing is pending, at most CAP rounds. No fake time
  // passes inside this call.
  async function serveOutage(served: Set<FakeEventSource>) {
    for (let round = 0; round < CAP; round += 1) {
      let progressed = false
      for (const [index, entry] of fetches.entries()) {
        if (entry.settled) continue
        await respondStatus(index, 502)
        progressed = true
      }
      for (const source of [...FakeEventSource.instances]) {
        if (served.has(source) || source.closed) continue
        served.add(source)
        progressed = true
        const after = afterOf(source)
        if (after === null || after === '') {
          for (const event of ring) await emit('operator', event, source)
        } else {
          const index = ring.findIndex(event => event.cursor === after)
          if (index === -1) await emit('reset', reset, source)
          else for (const event of ring.slice(index + 1)) await emit('operator', event, source)
        }
      }
      if (!progressed) return round
    }
    return CAP
  }

  it('C7: stream opens and snapshot fetches stay bounded over 90 s of fake time', async () => {
    const hook = await mountWithS0()
    const served = new Set<FakeEventSource>()
    const windows: Array<{ atMs: number, rounds: number, opens: number, fetches: number }> = []
    for (let tick = 0; tick <= 3; tick += 1) {
      if (tick > 0) await advancePoll()
      const rounds = await serveOutage(served)
      windows.push({ atMs: tick * 30_000, rounds, opens: FakeEventSource.instances.length, fetches: fetches.length })
    }
    const open = FakeEventSource.instances.filter(source => !source.closed).map(source => source.url)
    console.info(`[lip-007 C7 observed] ${JSON.stringify({ windows, distinctUrls: [...new Set(FakeEventSource.instances.map(source => source.url))], open, loading: hook.result.current.loading, error: hook.result.current.error })}`)
    // C7 named assertion: one reset, one full-ring reopen, then only the 30 s polls.
    expect(windows.map(window => window.rounds < CAP)).toEqual([true, true, true, true])
    expect({ opens: FakeEventSource.instances.length, fetches: fetches.length }).toEqual({ opens: 2, fetches: 5 })
    expect(open).toEqual(['/api/lugos/events'])
    expect(hook.result.current.operatorState).toEqual(withEvents(stateFromSnapshot(S0), ring[0]))
    expect(hook.result.current.error).toBe('Lugos operator snapshot is unavailable.')
  }, 30_000)

  it('C7-recovery: the first good poll after the outage resynchronizes', async () => {
    const hook = await mountWithS0()
    const served = new Set<FakeEventSource>()
    await serveOutage(served)
    await advancePoll()
    const recovered = snapshot('evt-x1', projection({ runs: [run({ current_phase: 'verify' }), run({ run_id: 'older-run', current_phase: 'review' })] }))
    await respond(fetches.length - 1, recovered)
    expect(hook.result.current.operatorState).toEqual(stateFromSnapshot(recovered))
    expect(hook.result.current.error).toBeNull()
    const open = FakeEventSource.instances.filter(source => !source.closed).map(source => source.url)
    expect(open).toHaveLength(1)
  }, 30_000)
})
