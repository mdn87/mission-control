import {
  createPrivateKey,
  type KeyObject,
} from 'node:crypto'
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { resolve } from 'node:path'
import type {
  RelayKeyProvider,
  RelaySigningKey,
} from '../integrations/lugos/relay-signer'
import { privateFilePermissionsAreSafe } from './private-file-permissions'

export class FileRelayKeyProvider implements RelayKeyProvider {
  private readonly key: RelaySigningKey

  constructor(input: {
    keyPath: string
    keyId: string
    issuerId: string
    credentialsDirectory?: string
  }) {
    const keyPath = resolve(input.keyPath)
    const metadata = lstatSync(keyPath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('relay_signing_key_path_unsafe')
    }
    if (!privateFilePermissionsAreSafe(
      realpathSync(keyPath),
      metadata,
      input.credentialsDirectory,
    )) {
      throw new Error('relay_signing_key_permissions_unsafe')
    }
    const privateKey = createPrivateKey(readFileSync(keyPath))
    assertIdentifier(input.keyId, 'key ID')
    assertIdentifier(input.issuerId, 'issuer ID')
    assertEd25519PrivateKey(privateKey)
    this.key = {
      key_id: input.keyId,
      issuer_id: input.issuerId,
      private_key: privateKey,
    }
  }

  activeSigningKey(): RelaySigningKey {
    return this.key
  }
}

function assertEd25519PrivateKey(key: KeyObject): void {
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('relay_signing_key_invalid')
  }
}

function assertIdentifier(value: string, label: string): void {
  if (!value || value.length > 128) {
    throw new Error(`relay_${label.replaceAll(' ', '_')}_invalid`)
  }
}
