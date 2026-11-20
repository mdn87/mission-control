import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { API_KEY_HEADER } from './helpers'

test('Hermes setup cannot persist provider credentials', async ({ request }) => {
  const credentialFile = join(process.cwd(), '.tmp', 'e2e-openclaw', 'local', 'data', '.hermes', '.env')
  expect(existsSync(credentialFile)).toBe(false)

  const response = await request.post('/api/hermes', {
    headers: API_KEY_HEADER,
    data: { action: 'set-env', key: 'OPENAI_API_KEY', value: 'synthetic-hermes-test-key' },
  })

  expect(response.status()).toBe(400)
  expect(existsSync(credentialFile)).toBe(false)
})
