import path from 'node:path'
import { runCommand } from '@/lib/command'
import { config } from '@/lib/config'
import {
  lineageExplanationSchema,
  lineageIndexSchema,
  lineageRequestSchema,
  lineageSummarySchema,
  type LineageExplanation,
  type LineageIndex,
  type LineageRequest,
  type LineageSummary,
} from './torc-contract'

const TORC_TIMEOUT_MS = 10_000
const TORC_TOOL = 'torc.lineage.explain'

export class TorcUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TorcUnavailableError'
  }
}

export class TorcStateDirError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TorcStateDirError'
  }
}

/**
 * Resolve a requested state directory inside the configured TORC state root.
 *
 * The lineage view is read-only, but the state directory still arrives from the
 * request. Containment keeps it from being pointed at arbitrary locations on
 * the host.
 */
export function resolveStateDir(stateDir: string): string {
  const root = config.torcStateRoot
  if (!root) {
    throw new TorcUnavailableError('LUGOS_TORC_STATE_ROOT is not configured')
  }
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, stateDir)
  const relative = path.relative(resolvedRoot, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new TorcStateDirError('State directory is outside the TORC state root')
  }
  return resolved
}

/**
 * Read the operator-configured lineage index.
 *
 * Entries are `lineage:stateDir` or `lineage:stateDir:label`. Malformed or
 * out-of-root entries are dropped rather than surfaced, so a typo in the env
 * cannot present a lineage the explain call would refuse anyway.
 */
export function listLineages(): LineageIndex {
  const lineages: LineageSummary[] = []
  for (const entry of config.torcLineages.split(',')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const [lineage, stateDir, ...rest] = trimmed.split(':')
    const candidate = {
      lineage: (lineage ?? '').trim(),
      stateDir: (stateDir ?? '').trim(),
      ...(rest.length ? { label: rest.join(':').trim() } : {}),
    }
    const parsed = lineageSummarySchema.safeParse(candidate)
    if (!parsed.success) continue
    try {
      resolveStateDir(parsed.data.stateDir)
    } catch {
      continue
    }
    lineages.push(parsed.data)
  }
  return lineageIndexSchema.parse({ stub: true, lineages })
}

function stdoutOf(error: unknown): string {
  const stdout = (error as { stdout?: unknown })?.stdout
  return typeof stdout === 'string' ? stdout : ''
}

/**
 * Fetch one lineage explanation through the published Lugos tool catalog.
 *
 * An untrusted explanation is a valid response, not a failure: TORC reports
 * `trusted: false` with warnings and asserts no authority timeline. It is
 * returned to the caller intact so the panel can show the refusal.
 */
export async function fetchLineageExplanation(
  input: LineageRequest,
): Promise<LineageExplanation> {
  const request = lineageRequestSchema.parse(input)
  const stateDir = resolveStateDir(request.stateDir)

  const args = [
    TORC_TOOL,
    '--arguments',
    JSON.stringify({ lineage: request.lineage, state_dir: stateDir }),
  ]

  let stdout: string
  try {
    const result = await runCommand(config.lugosToolCallBin, args, {
      timeoutMs: TORC_TIMEOUT_MS,
    })
    stdout = result.stdout
  } catch (error) {
    stdout = stdoutOf(error)
    if (!stdout.trim()) {
      throw new TorcUnavailableError(
        error instanceof Error ? error.message : 'TORC lineage tool failed',
      )
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    // The adapter returns a plain-text message when TORC itself could not run.
    throw new TorcUnavailableError(stdout.trim().slice(0, 300) || 'TORC returned no output')
  }

  const explanation = lineageExplanationSchema.safeParse(parsed)
  if (!explanation.success) {
    throw new TorcUnavailableError('TORC returned an unrecognized lineage payload')
  }
  return explanation.data
}
