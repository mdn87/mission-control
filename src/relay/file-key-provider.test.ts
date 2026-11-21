import { generateKeyPairSync } from 'node:crypto'
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

vi.mock('./private-file-permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./private-file-permissions')>()
  return {
    ...actual,
    privateFilePermissionsAreSafe: vi.fn(actual.privateFilePermissionsAreSafe),
  }
})

import { FileRelayKeyProvider, MemoryRelayKeyProvider } from './file-key-provider'
import { privateFilePermissionsAreSafe } from './private-file-permissions'

const permissionCheck = vi.mocked(privateFilePermissionsAreSafe)

describe('FileRelayKeyProvider private-file validation', () => {
  let directory: string
  let keyPath: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'relay-key-provider-'))
    keyPath = join(directory, 'signing.key')
    const { privateKey } = generateKeyPairSync('ed25519')
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    permissionCheck.mockReturnValue(true)
  })

  afterEach(() => {
    permissionCheck.mockReset()
    rmSync(directory, { recursive: true, force: true })
  })

  it('reuses the shared permission policy with the resolved key and credential directory', () => {
    const credentialsDirectory = '/run/credentials/lugos-remote-relay.service'

    expect(() => new FileRelayKeyProvider({
      keyPath,
      keyId: 'relay-key-v1',
      issuerId: 'lugos-host',
      credentialsDirectory,
    })).not.toThrow()

    expect(permissionCheck).toHaveBeenCalledOnce()
    expect(permissionCheck).toHaveBeenCalledWith(
      realpathSync(keyPath),
      expect.objectContaining({ mode: expect.any(Number) }),
      credentialsDirectory,
    )
  })

  it('fails closed when the shared permission policy rejects the key', () => {
    permissionCheck.mockReturnValue(false)

    expect(() => new FileRelayKeyProvider({
      keyPath,
      keyId: 'relay-key-v1',
      issuerId: 'lugos-host',
    })).toThrow('relay_signing_key_permissions_unsafe')
  })
})

describe('MemoryRelayKeyProvider', () => {
  it('accepts a GLAS-injected Ed25519 PEM without opening a key file', () => {
    const { privateKey } = generateKeyPairSync('ed25519')
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const provider = new MemoryRelayKeyProvider({ pem, keyId: 'relay-key-v1', issuerId: 'lugos-host' })
    expect(provider.activeSigningKey().private_key.asymmetricKeyType).toBe('ed25519')
    expect(permissionCheck).not.toHaveBeenCalled()
  })
})
