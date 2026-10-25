import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { ogmiRunSummary, ogmiViewSchema, type OgmiView } from './ogmi-contract'

const execute = promisify(execFile)

/** Fixed, server-configured read only. No browser-supplied path or command. */
export async function fetchOgmiProjection(): Promise<OgmiView> {
  const root = process.env.LUGOS_OGMI_PROJECT
  const snapshot = process.env.LUGOS_OGMI_SNAPSHOT
  if (!root || !snapshot) throw new Error('OGMI projection is not configured')
  const project = path.resolve(root)
  const file = path.resolve(project, snapshot)
  const relative = path.relative(project, file)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('OGMI snapshot must be inside its configured project')
  }
  // execFile rejects nonzero exits even if stdout contains plausible JSON.
  // The OGMI command returns the same captured bytes it verified, not a reread.
  const { stdout } = await execute(process.env.LUGOS_OGMI_BIN || 'ogmi', [
    'read-projection-snapshot', project, file, `${file}.artifact-ref.json`, '--json',
  ], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, encoding: 'utf8' })
  const view = ogmiViewSchema.parse(JSON.parse(stdout))
  ogmiRunSummary(view)
  return view
}
