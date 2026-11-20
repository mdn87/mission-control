import { afterEach, describe, expect, it } from 'vitest'
import { getEffectiveEnvValue } from '../runtime-env'

describe('getEffectiveEnvValue', () => {
  afterEach(() => {
    delete process.env.TEST_RUNTIME_ENV
  })

  it('reads the GLAS-injected process value', async () => {
    process.env.TEST_RUNTIME_ENV = 'from-process'
    await expect(getEffectiveEnvValue('TEST_RUNTIME_ENV')).resolves.toBe('from-process')
  })

  it('returns an empty string when the key is missing', async () => {
    await expect(getEffectiveEnvValue('TEST_RUNTIME_ENV')).resolves.toBe('')
  })
})
