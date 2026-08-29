import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '@/lib/auth'
import { runMigrations } from '@/lib/migrations'

const {
  generateAuthenticationOptionsMock,
  generateRegistrationOptionsMock,
  getDatabaseMock,
  verifyAuthenticationResponseMock,
  verifyPasswordMock,
  verifyRegistrationResponseMock,
} = vi.hoisted(() => ({
  generateAuthenticationOptionsMock: vi.fn(),
  generateRegistrationOptionsMock: vi.fn(),
  getDatabaseMock: vi.fn(),
  verifyAuthenticationResponseMock: vi.fn(),
  verifyPasswordMock: vi.fn(),
  verifyRegistrationResponseMock: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ getDatabase: getDatabaseMock }))
vi.mock('@/lib/password', () => ({ verifyPassword: verifyPasswordMock }))
vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: generateAuthenticationOptionsMock,
  generateRegistrationOptions: generateRegistrationOptionsMock,
  verifyAuthenticationResponse: verifyAuthenticationResponseMock,
  verifyRegistrationResponse: verifyRegistrationResponseMock,
}))

import {
  assertRemoteDecisionRequestOrigin,
  authenticationOptions,
  consumeStepUpGrant,
  deletePasskey,
  passkeyStatus,
  registrationOptions,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from './remote-passkeys'

const user = {
  id: 1,
  username: 'operator',
  display_name: 'Operator',
  role: 'admin',
  workspace_id: 1,
  tenant_id: 1,
  provider: 'local',
  created_at: 0,
  updated_at: 0,
  last_login_at: null,
} satisfies User
const bindingDigest = 'sha256:' + 'a'.repeat(64)

describe('remote decision passkey step-up', () => {
  const originalEnv = process.env
  let database: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    process.env = {
      ...originalEnv,
      MC_REMOTE_WEBAUTHN_ENABLED: 'true',
      MC_WEBAUTHN_RP_ID: 'knot.newman.foo',
      MC_WEBAUTHN_ORIGIN: 'https://knot.newman.foo',
      MC_REMOTE_DEVICE_ID: 'workstation-4070pc',
    }
    database = new Database(':memory:')
    database.pragma('foreign_keys = ON')
    runMigrations(database)
    database.prepare(`
      INSERT INTO users (
        id, username, display_name, password_hash, role, provider,
        is_approved, workspace_id
      ) VALUES (1, 'operator', 'Operator', 'stored', 'admin', 'local', 1, 1)
    `).run()
    getDatabaseMock.mockReturnValue(database)
    verifyPasswordMock.mockReturnValue(true)
    generateRegistrationOptionsMock.mockResolvedValue({
      challenge: 'registration-challenge',
      rp: { id: 'knot.newman.foo', name: 'Lugos Mission Control' },
      user: { id: 'bWMtdXNlcjox', name: 'operator', displayName: 'Operator' },
      pubKeyCredParams: [],
      timeout: 60_000,
      attestation: 'none',
      excludeCredentials: [],
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    })
    verifyRegistrationResponseMock.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'credential-fixture-1',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports: ['internal'],
        },
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
      },
    })
    generateAuthenticationOptionsMock.mockResolvedValue({
      challenge: 'authentication-challenge',
      rpId: 'knot.newman.foo',
      timeout: 60_000,
      userVerification: 'required',
      allowCredentials: [{ id: 'credential-fixture-1', type: 'public-key' }],
    })
    verifyAuthenticationResponseMock.mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: 'credential-fixture-1',
        newCounter: 1,
        userVerified: true,
        credentialDeviceType: 'singleDevice',
        credentialBackedUp: false,
        origin: 'https://knot.newman.foo',
        rpID: 'knot.newman.foo',
      },
    })
  })

  afterEach(() => {
    database.close()
    process.env = originalEnv
  })

  it('requires the configured HTTPS operator origin', () => {
    expect(() => assertRemoteDecisionRequestOrigin(new Request(
      'https://knot.newman.foo/api/lugos/remote-decisions',
      { headers: { origin: 'https://knot.newman.foo', host: 'knot.newman.foo' } },
    ))).not.toThrow()
    expect(() => assertRemoteDecisionRequestOrigin(new Request(
      'http://10.0.1.33:3230/api/lugos/remote-decisions',
      { headers: { origin: 'http://10.0.1.33:3230', host: '10.0.1.33:3230' } },
    ))).toThrow(/remote_step_up_origin_invalid/)
  })

  it('enrolls a verified passkey only after password reauthentication', async () => {
    verifyPasswordMock.mockReturnValueOnce(false)
    await expect(registrationOptions(user, 'wrong'))
      .rejects.toMatchObject({ code: 'remote_passkey_password_invalid' })

    const generated = await registrationOptions(user, 'correct')
    await expect(verifyPasskeyRegistration(user, generated.challenge_id, {
      id: 'credential-fixture-1',
    })).resolves.toEqual({
      verified: true,
      credential_id: 'credential-fixture-1',
    })
    expect(passkeyStatus(user)).toMatchObject({
      device_id: 'workstation-4070pc',
      passkeys: [{ credential_id: 'credential-fixture-1' }],
    })
  })

  it('issues a short-lived grant bound to one decision and consumes it once', async () => {
    const registration = await registrationOptions(user, 'correct')
    await verifyPasskeyRegistration(user, registration.challenge_id, {
      id: 'credential-fixture-1',
    })
    const authentication = await authenticationOptions(user, bindingDigest)
    const grant = await verifyPasskeyAuthentication(user, authentication.challenge_id, {
      id: 'credential-fixture-1',
    })
    expect(() => consumeStepUpGrant(
      user,
      'sha256:' + 'b'.repeat(64),
      grant.step_up_token,
    )).toThrow(/remote_step_up_invalid/)
    expect(consumeStepUpGrant(user, bindingDigest, grant.step_up_token).step_up_ref)
      .toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(() => consumeStepUpGrant(user, bindingDigest, grant.step_up_token))
      .toThrow(/remote_step_up_invalid/)
  })

  it('password-authenticated recovery removes the passkey and outstanding grants', async () => {
    const registration = await registrationOptions(user, 'correct')
    await verifyPasskeyRegistration(user, registration.challenge_id, {
      id: 'credential-fixture-1',
    })
    const authentication = await authenticationOptions(user, bindingDigest)
    const grant = await verifyPasskeyAuthentication(user, authentication.challenge_id, {
      id: 'credential-fixture-1',
    })
    deletePasskey(user, 'credential-fixture-1', 'correct')
    expect(passkeyStatus(user).passkeys).toEqual([])
    expect(() => consumeStepUpGrant(user, bindingDigest, grant.step_up_token))
      .toThrow(/remote_step_up_invalid/)
  })
})
