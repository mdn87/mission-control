import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

async function loadConfigWithEnv(env: Record<string, string | undefined>) {
  vi.resetModules()

  const original = {
    MISSION_CONTROL_DATA_DIR: process.env.MISSION_CONTROL_DATA_DIR,
    MISSION_CONTROL_BUILD_DATA_DIR: process.env.MISSION_CONTROL_BUILD_DATA_DIR,
    MISSION_CONTROL_BUILD_DB_PATH: process.env.MISSION_CONTROL_BUILD_DB_PATH,
    MISSION_CONTROL_BUILD_TOKENS_PATH: process.env.MISSION_CONTROL_BUILD_TOKENS_PATH,
    MISSION_CONTROL_DB_PATH: process.env.MISSION_CONTROL_DB_PATH,
    MISSION_CONTROL_TOKENS_PATH: process.env.MISSION_CONTROL_TOKENS_PATH,
    NEXT_PHASE: process.env.NEXT_PHASE,
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  const mod = await import('./config')

  if (original.MISSION_CONTROL_DATA_DIR === undefined) delete process.env.MISSION_CONTROL_DATA_DIR
  else process.env.MISSION_CONTROL_DATA_DIR = original.MISSION_CONTROL_DATA_DIR

  if (original.MISSION_CONTROL_BUILD_DATA_DIR === undefined) delete process.env.MISSION_CONTROL_BUILD_DATA_DIR
  else process.env.MISSION_CONTROL_BUILD_DATA_DIR = original.MISSION_CONTROL_BUILD_DATA_DIR

  if (original.MISSION_CONTROL_BUILD_DB_PATH === undefined) delete process.env.MISSION_CONTROL_BUILD_DB_PATH
  else process.env.MISSION_CONTROL_BUILD_DB_PATH = original.MISSION_CONTROL_BUILD_DB_PATH

  if (original.MISSION_CONTROL_BUILD_TOKENS_PATH === undefined) delete process.env.MISSION_CONTROL_BUILD_TOKENS_PATH
  else process.env.MISSION_CONTROL_BUILD_TOKENS_PATH = original.MISSION_CONTROL_BUILD_TOKENS_PATH

  if (original.MISSION_CONTROL_DB_PATH === undefined) delete process.env.MISSION_CONTROL_DB_PATH
  else process.env.MISSION_CONTROL_DB_PATH = original.MISSION_CONTROL_DB_PATH

  if (original.MISSION_CONTROL_TOKENS_PATH === undefined) delete process.env.MISSION_CONTROL_TOKENS_PATH
  else process.env.MISSION_CONTROL_TOKENS_PATH = original.MISSION_CONTROL_TOKENS_PATH

  if (original.NEXT_PHASE === undefined) delete process.env.NEXT_PHASE
  else process.env.NEXT_PHASE = original.NEXT_PHASE

  return mod.config
}

describe('config data paths', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('derives db and token paths from MISSION_CONTROL_DATA_DIR', async () => {
    const dataDir = path.join(os.tmpdir(), 'mission-control-data')
    const config = await loadConfigWithEnv({
      MISSION_CONTROL_DATA_DIR: dataDir,
      MISSION_CONTROL_DB_PATH: undefined,
      MISSION_CONTROL_TOKENS_PATH: undefined,
    })

    expect(config.dataDir).toBe(dataDir)
    expect(config.dbPath).toBe(path.join(dataDir, 'mission-control.db'))
    expect(config.tokensPath).toBe(path.join(dataDir, 'mission-control-tokens.json'))
  })

  it('respects explicit db and token path overrides', async () => {
    const dataDir = path.join(os.tmpdir(), 'mission-control-data')
    const dbPath = path.join(os.tmpdir(), 'custom.db')
    const tokensPath = path.join(os.tmpdir(), 'custom-tokens.json')
    const config = await loadConfigWithEnv({
      MISSION_CONTROL_DATA_DIR: dataDir,
      MISSION_CONTROL_DB_PATH: dbPath,
      MISSION_CONTROL_TOKENS_PATH: tokensPath,
    })

    expect(config.dataDir).toBe(dataDir)
    expect(config.dbPath).toBe(dbPath)
    expect(config.tokensPath).toBe(tokensPath)
  })

  it('uses a build-scoped worker data dir during next build', async () => {
    const runtimeDir = path.join(os.tmpdir(), 'runtime-data')
    const buildDir = path.join(os.tmpdir(), 'build-scratch')
    const config = await loadConfigWithEnv({
      NEXT_PHASE: 'phase-production-build',
      MISSION_CONTROL_DATA_DIR: runtimeDir,
      MISSION_CONTROL_BUILD_DATA_DIR: buildDir,
      MISSION_CONTROL_DB_PATH: undefined,
      MISSION_CONTROL_TOKENS_PATH: undefined,
    })

    expect(config.dataDir.startsWith(`${buildDir}${path.sep}worker-`)).toBe(true)
    expect(path.basename(config.dataDir)).toMatch(/^worker-.+$/)
    expect(config.dbPath).toBe(path.join(config.dataDir, 'mission-control.db'))
    expect(config.tokensPath).toBe(path.join(config.dataDir, 'mission-control-tokens.json'))
  })

  it('allocates a distinct private scratch directory for each build worker', async () => {
    const env = {
      NEXT_PHASE: 'phase-production-build',
      MISSION_CONTROL_BUILD_DATA_DIR: path.join(os.tmpdir(), 'build-scratch'),
      MISSION_CONTROL_BUILD_DB_PATH: undefined,
      MISSION_CONTROL_BUILD_TOKENS_PATH: undefined,
    }

    const first = await loadConfigWithEnv(env)
    const second = await loadConfigWithEnv(env)

    expect(first.dataDir).not.toBe(second.dataDir)
  })

  it('prefers build-specific db and token overrides during next build', async () => {
    const runtimeDir = path.join(os.tmpdir(), 'runtime-data')
    const runtimeDb = path.join(os.tmpdir(), 'runtime.db')
    const runtimeTokens = path.join(os.tmpdir(), 'runtime-tokens.json')
    const buildDb = path.join(os.tmpdir(), 'build.db')
    const buildTokens = path.join(os.tmpdir(), 'build-tokens.json')
    const config = await loadConfigWithEnv({
      NEXT_PHASE: 'phase-production-build',
      MISSION_CONTROL_DATA_DIR: runtimeDir,
      MISSION_CONTROL_DB_PATH: runtimeDb,
      MISSION_CONTROL_TOKENS_PATH: runtimeTokens,
      MISSION_CONTROL_BUILD_DB_PATH: buildDb,
      MISSION_CONTROL_BUILD_TOKENS_PATH: buildTokens,
    })

    const expectedBuildRoot = path.join(os.tmpdir(), 'mission-control-build')
    expect(config.dataDir.startsWith(`${expectedBuildRoot}${path.sep}worker-`)).toBe(true)
    expect(config.dbPath).toBe(buildDb)
    expect(config.tokensPath).toBe(buildTokens)
  })
})
