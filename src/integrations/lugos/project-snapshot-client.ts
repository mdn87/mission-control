import path from 'node:path'
import { runCommand } from '@/lib/command'
import { config } from '@/lib/config'
import {
  projectSnapshotViewSchema,
  type ProjectSnapshotView,
} from './project-snapshot-contract'

const TORC_TIMEOUT_MS = 10_000

export class ProjectSnapshotUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectSnapshotUnavailableError'
  }
}

function stdoutOf(error: unknown): string {
  const stdout = (error as { stdout?: unknown })?.stdout
  return typeof stdout === 'string' ? stdout : ''
}

/** Fetch the accepted current snapshot through TORC's read-only CLI contract. */
export async function fetchCurrentProjectSnapshot(): Promise<ProjectSnapshotView> {
  if (!config.torcArtifactStore) {
    throw new ProjectSnapshotUnavailableError(
      'LUGOS_TORC_ARTIFACT_STORE is not configured',
    )
  }
  const store = path.resolve(config.torcArtifactStore)
  let stdout: string
  try {
    const result = await runCommand(
      config.torcBin,
      ['artifact', 'view', '--store', store, '--json'],
      { timeoutMs: TORC_TIMEOUT_MS },
    )
    stdout = result.stdout
  } catch (error) {
    stdout = stdoutOf(error)
    if (!stdout.trim()) {
      throw new ProjectSnapshotUnavailableError(
        error instanceof Error ? error.message : 'TORC snapshot view failed',
      )
    }
  }

  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new ProjectSnapshotUnavailableError('TORC returned no JSON snapshot view')
  }
  const parsed = projectSnapshotViewSchema.safeParse(value)
  if (!parsed.success) {
    throw new ProjectSnapshotUnavailableError(
      'TORC returned an unrecognized snapshot payload',
    )
  }
  return parsed.data
}
