import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

import { loadRelayConfig } from './server'

it('rejects private-key file paths for the relay service', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mc-relay-glas-'))
  const deviceFile = join(directory, 'devices.json')
  try {
    writeFileSync(deviceFile, JSON.stringify({
      schema: 'lugos.remote-relay-devices/v1',
      devices: [{ device_id: 'test-device', transport_principal: 'test',
        certificate_sha256: 'a'.repeat(64) }],
    }))
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      LUGOS_RELAY_ISSUER_ENABLED: 'true',
      LUGOS_RELAY_LISTEN_HOST: '10.0.1.33',
      LUGOS_RELAY_DEVICES_FILE: deviceFile,
      LUGOS_RELAY_INTERNAL_TOKEN: 'x'.repeat(32),
      LUGOS_RELAY_TLS_KEY: join(directory, 'server.key'),
      LUGOS_RELAY_TLS_KEY_PEM: 'synthetic-private-key',
      LUGOS_RELAY_SIGNING_KEY_PEM: 'synthetic-signing-key',
    }
    expect(() => loadRelayConfig(env)).toThrow('relay_private_key_file_unsupported')
    delete env.LUGOS_RELAY_TLS_KEY
    expect(() => loadRelayConfig(env)).toThrow('relay_config_missing:LUGOS_RELAY_DB_PATH')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
