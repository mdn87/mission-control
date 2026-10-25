// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OGMI_VIEW } from './__tests__/ogmi-view.fixture'
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('node:util', () => ({ promisify: () => execute }))
import { fetchOgmiProjection } from './ogmi-client'
beforeEach(() => {
  execute.mockReset(); execute.mockResolvedValue({ stdout: JSON.stringify(OGMI_VIEW) })
  vi.stubEnv('LUGOS_OGMI_PROJECT', process.cwd())
  vi.stubEnv('LUGOS_OGMI_SNAPSHOT', 'projections/run.json')
  vi.stubEnv('LUGOS_OGMI_BIN', 'ogmi')
})
afterEach(() => vi.unstubAllEnvs())
it('uses a bounded no-shell verified reader command', async () => {
  expect((await fetchOgmiProjection()).snapshot.run_id).toBe('run-proof')
  expect(execute).toHaveBeenCalledWith('ogmi', [
    'read-projection-snapshot', process.cwd(), expect.stringContaining('run.json'),
    expect.stringContaining('run.json.artifact-ref.json'), '--json',
  ], { timeout: 10000, maxBuffer: 2097152, windowsHide: true, encoding: 'utf8' })
})
it('rejects a failed verifier even when its stdout looks valid', async () => {
  execute.mockRejectedValue(Object.assign(new Error('verification failed'), { stdout: JSON.stringify(OGMI_VIEW) }))
  await expect(fetchOgmiProjection()).rejects.toThrow('verification failed')
})
it('rejects an unconfigured project and escaping snapshot before spawning', async () => {
  vi.stubEnv('LUGOS_OGMI_PROJECT', '')
  await expect(fetchOgmiProjection()).rejects.toThrow('not configured')
  vi.stubEnv('LUGOS_OGMI_PROJECT', process.cwd())
  vi.stubEnv('LUGOS_OGMI_SNAPSHOT', '../secret.json')
  await expect(fetchOgmiProjection()).rejects.toThrow('inside')
  expect(execute).not.toHaveBeenCalled()
})
it('rejects malformed payloads and absent required built-in gates', async () => {
  execute.mockResolvedValue({ stdout: JSON.stringify({ ...OGMI_VIEW, schema: 'bogus' }) })
  await expect(fetchOgmiProjection()).rejects.toThrow()
  execute.mockResolvedValue({ stdout: JSON.stringify({ ...OGMI_VIEW, snapshot: { ...OGMI_VIEW.snapshot, built_in_claims: [] } }) })
  await expect(fetchOgmiProjection()).rejects.toThrow()
})
