import { describe, expect, it } from 'vitest'

import { privateFilePermissionsAreSafe } from './server'

const SYSTEMD_DIRECTORY = '/run/credentials/lugos-remote-relay.service'
const SYSTEMD_KEY = `${SYSTEMD_DIRECTORY}/relay-signing-key`

describe('relay private-file permissions', () => {
  it('accepts the exact systemd LoadCredential representation', () => {
    expect(privateFilePermissionsAreSafe(
      SYSTEMD_KEY,
      { mode: 0o100440, uid: 0, gid: 0 },
      SYSTEMD_DIRECTORY,
      'linux',
    )).toBe(true)
  })

  it.each([
    ['outside the credential directory', '/tmp/relay-signing-key', 0o100440, 0, 0],
    ['nested below the credential directory', `${SYSTEMD_DIRECTORY}/nested/key`, 0o100440, 0, 0],
    ['owned by a non-root user', SYSTEMD_KEY, 0o100440, 1000, 0],
    ['owned by a non-root group', SYSTEMD_KEY, 0o100440, 0, 1000],
    ['writable by the ACL mask', SYSTEMD_KEY, 0o100460, 0, 0],
    ['accessible to other users', SYSTEMD_KEY, 0o100444, 0, 0],
  ])('rejects a systemd-shaped credential %s', (_label, path, mode, uid, gid) => {
    expect(privateFilePermissionsAreSafe(
      path as string,
      { mode: mode as number, uid: uid as number, gid: gid as number },
      SYSTEMD_DIRECTORY,
      'linux',
    )).toBe(false)
  })

  it('keeps the classic owner-only rule outside systemd credentials', () => {
    expect(privateFilePermissionsAreSafe(
      '/etc/lugos/remote-relay/signing.key',
      { mode: 0o100600, uid: 0, gid: 0 },
      undefined,
      'linux',
    )).toBe(true)
    expect(privateFilePermissionsAreSafe(
      '/etc/lugos/remote-relay/signing.key',
      { mode: 0o100640, uid: 0, gid: 0 },
      undefined,
      'linux',
    )).toBe(false)
  })

  it('rejects a caller-controlled directory that only resembles systemd credentials', () => {
    expect(privateFilePermissionsAreSafe(
      '/tmp/fake-credentials/relay-signing-key',
      { mode: 0o100440, uid: 0, gid: 0 },
      '/tmp/fake-credentials',
      'linux',
    )).toBe(false)
  })
})
