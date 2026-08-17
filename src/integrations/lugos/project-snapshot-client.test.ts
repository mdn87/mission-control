import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PROJECT_SNAPSHOT_VIEW } from './__tests__/project-snapshot-view.fixture'

const runCommand = vi.fn()
const config = {
  torcBin: 'torc',
  torcArtifactStore: '',
}

vi.mock('@/lib/command', () => ({ runCommand }))
vi.mock('@/lib/config', () => ({ config }))

beforeEach(() => {
  runCommand.mockReset()
  config.torcArtifactStore = path.resolve('/lugos/torc/.lugos/artifacts/project-snapshot')
})

describe('fetchCurrentProjectSnapshot', () => {
  it('invokes only the TORC read command with a single configured store argument', async () => {
    runCommand.mockResolvedValue({ stdout: JSON.stringify(PROJECT_SNAPSHOT_VIEW), stderr: '', code: 0 })
    const { fetchCurrentProjectSnapshot } = await import('./project-snapshot-client')

    const result = await fetchCurrentProjectSnapshot()

    expect(result.artifact.scope.name).toBe('Lugos snapshot')
    expect(runCommand).toHaveBeenCalledWith(
      'torc',
      ['artifact', 'view', '--store', config.torcArtifactStore, '--json'],
      { timeoutMs: 10_000 },
    )
  })

  it('is unavailable when the artifact store is not configured', async () => {
    config.torcArtifactStore = ''
    const { fetchCurrentProjectSnapshot, ProjectSnapshotUnavailableError } = await import(
      './project-snapshot-client'
    )

    await expect(fetchCurrentProjectSnapshot()).rejects.toBeInstanceOf(
      ProjectSnapshotUnavailableError,
    )
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('rejects output that is not a trusted project snapshot view', async () => {
    runCommand.mockResolvedValue({ stdout: JSON.stringify({ ok: false }), stderr: '', code: 0 })
    const { fetchCurrentProjectSnapshot, ProjectSnapshotUnavailableError } = await import(
      './project-snapshot-client'
    )

    await expect(fetchCurrentProjectSnapshot()).rejects.toBeInstanceOf(
      ProjectSnapshotUnavailableError,
    )
  })
})
