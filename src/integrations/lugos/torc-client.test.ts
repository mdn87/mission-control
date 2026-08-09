import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runCommand = vi.fn()
const config = { lugosToolCallBin: 'lugos-tool-call', torcStateRoot: '', torcLineages: '' }

vi.mock('@/lib/command', () => ({ runCommand }))
vi.mock('@/lib/config', () => ({ config }))

const STATE_ROOT = path.resolve('/lugos/torc/.torc')

const TRUSTED = {
  report_kind: 'lineage_explanation',
  derived: true,
  canonical: false,
  trusted: true,
  explanation_complete: true,
  warnings: [],
  lineage: { lineage_id: 'torc-dev' },
  authority_changes: [
    {
      sequence: 1,
      kind: 'lineage_created',
      summary: 'Initial authority was acquired.',
      occurred_at: '2026-08-08T22:37:33.907659Z',
      transition_id: 'transition-1',
    },
  ],
  handoffs: [],
  continuity_events: [],
  fit_decisions: [],
}

const UNTRUSTED = {
  ...TRUSTED,
  trusted: false,
  explanation_complete: false,
  warnings: ['Stored provenance is invalid; no authority explanation is asserted.'],
  authority_changes: [],
}

async function importClient() {
  return import('./torc-client')
}

beforeEach(() => {
  vi.resetModules()
  runCommand.mockReset()
  config.torcStateRoot = STATE_ROOT
  config.torcLineages = ''
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('fetchLineageExplanation', () => {
  it('returns a trusted explanation through the lugos tool catalog', async () => {
    runCommand.mockResolvedValue({ stdout: JSON.stringify(TRUSTED), stderr: '', code: 0 })
    const { fetchLineageExplanation } = await importClient()

    const result = await fetchLineageExplanation({ lineage: 'torc-dev', stateDir: 'p2-pilot' })

    expect(result.trusted).toBe(true)
    expect(result.authority_changes).toHaveLength(1)
    const [bin, args] = runCommand.mock.calls[0]
    expect(bin).toBe('lugos-tool-call')
    expect(args[0]).toBe('torc.lineage.explain')
    expect(JSON.parse(args[2])).toEqual({
      lineage: 'torc-dev',
      state_dir: path.join(STATE_ROOT, 'p2-pilot'),
    })
  })

  it('returns an untrusted explanation intact instead of raising', async () => {
    runCommand.mockResolvedValue({ stdout: JSON.stringify(UNTRUSTED), stderr: '', code: 0 })
    const { fetchLineageExplanation } = await importClient()

    const result = await fetchLineageExplanation({ lineage: 'torc-dev', stateDir: 'p2-pilot' })

    expect(result.trusted).toBe(false)
    expect(result.explanation_complete).toBe(false)
    expect(result.warnings).toHaveLength(1)
  })

  it('recovers the payload when the tool exits nonzero', async () => {
    const failure = Object.assign(new Error('Command failed'), {
      stdout: JSON.stringify(UNTRUSTED),
      stderr: '',
    })
    runCommand.mockRejectedValue(failure)
    const { fetchLineageExplanation } = await importClient()

    const result = await fetchLineageExplanation({ lineage: 'torc-dev', stateDir: 'p2-pilot' })

    expect(result.trusted).toBe(false)
  })

  it('rejects a state directory outside the configured root', async () => {
    const { fetchLineageExplanation, TorcStateDirError } = await importClient()

    await expect(
      fetchLineageExplanation({ lineage: 'torc-dev', stateDir: '../../etc' }),
    ).rejects.toBeInstanceOf(TorcStateDirError)
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('is unavailable when no state root is configured', async () => {
    config.torcStateRoot = ''
    const { fetchLineageExplanation, TorcUnavailableError } = await importClient()

    await expect(
      fetchLineageExplanation({ lineage: 'torc-dev', stateDir: 'p2-pilot' }),
    ).rejects.toBeInstanceOf(TorcUnavailableError)
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('treats a plain-text adapter message as unavailable', async () => {
    runCommand.mockResolvedValue({
      stdout: 'lugos.torc failed to start torc: No module named torc',
      stderr: '',
      code: 0,
    })
    const { fetchLineageExplanation, TorcUnavailableError } = await importClient()

    await expect(
      fetchLineageExplanation({ lineage: 'torc-dev', stateDir: 'p2-pilot' }),
    ).rejects.toBeInstanceOf(TorcUnavailableError)
  })

  it('rejects a payload that is not a lineage explanation', async () => {
    runCommand.mockResolvedValue({
      stdout: JSON.stringify({ report_kind: 'something_else' }),
      stderr: '',
      code: 0,
    })
    const { fetchLineageExplanation, TorcUnavailableError } = await importClient()

    await expect(
      fetchLineageExplanation({ lineage: 'torc-dev', stateDir: 'p2-pilot' }),
    ).rejects.toBeInstanceOf(TorcUnavailableError)
  })

  it('rejects a lineage identifier that is not an opaque token', async () => {
    const { fetchLineageExplanation } = await importClient()

    await expect(
      fetchLineageExplanation({ lineage: '../../secrets', stateDir: 'p2-pilot' }),
    ).rejects.toThrow()
    expect(runCommand).not.toHaveBeenCalled()
  })
})

describe('listLineages', () => {
  it('is empty and still flagged a stub when nothing is configured', async () => {
    const { listLineages } = await importClient()

    expect(listLineages()).toEqual({ stub: true, lineages: [] })
  })

  it('parses configured entries with and without labels', async () => {
    config.torcLineages = 'torc-dev:p2-pilot:P2 pilot, torc-demo:demo'
    const { listLineages } = await importClient()

    expect(listLineages()).toEqual({
      stub: true,
      lineages: [
        { lineage: 'torc-dev', stateDir: 'p2-pilot', label: 'P2 pilot' },
        { lineage: 'torc-demo', stateDir: 'demo' },
      ],
    })
  })

  it('drops malformed and out-of-root entries instead of surfacing them', async () => {
    config.torcLineages = [
      'no-state-dir',
      '../../escape:p2-pilot',
      'torc-escape:../../etc',
      'torc-ok:demo',
    ].join(',')
    const { listLineages } = await importClient()

    expect(listLineages()).toEqual({
      stub: true,
      lineages: [{ lineage: 'torc-ok', stateDir: 'demo' }],
    })
  })

  it('yields nothing when the state root is unconfigured', async () => {
    config.torcStateRoot = ''
    config.torcLineages = 'torc-dev:p2-pilot'
    const { listLineages } = await importClient()

    expect(listLineages()).toEqual({ stub: true, lineages: [] })
  })
})
