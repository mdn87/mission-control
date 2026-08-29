import {
  createHash,
  randomBytes,
} from 'node:crypto'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import type { User } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { verifyPassword } from '@/lib/password'
import { canonicalDigest } from '@/integrations/lugos/remote-decision-contract'
import {
  configuredRemoteDecisionDeviceId,
  RemoteDecisionUnavailableError,
} from '@/integrations/lugos/remote-relay-service'

const CHALLENGE_LIFETIME_SECONDS = 5 * 60
const STEP_UP_GRANT_LIFETIME_SECONDS = 60
const MAX_PASSKEYS_PER_USER = 8
const DIGEST = /^sha256:[a-f0-9]{64}$/

interface PasskeyRow {
  credential_id: string
  user_id: number
  public_key: Buffer
  counter: number
  transports: string
  device_type: 'singleDevice' | 'multiDevice'
  backed_up: number
  created_at: number
  last_used_at: number | null
}

interface ChallengeRow {
  challenge_id: string
  user_id: number
  kind: 'registration' | 'authentication'
  challenge: string
  binding_digest: string | null
  expires_at: number
  consumed_at: number | null
}

interface StepUpGrantRow {
  token_hash: string
  user_id: number
  binding_digest: string
  step_up_ref: string
  expires_at: number
  consumed_at: number | null
}

export function remoteWebAuthnEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MC_REMOTE_WEBAUTHN_ENABLED === 'true'
}

function webAuthnConfig(env: NodeJS.ProcessEnv = process.env): {
  rpID: string
  origin: string
  rpName: string
} {
  if (!remoteWebAuthnEnabled(env)) {
    throw new RemoteDecisionUnavailableError('remote_step_up_provider_disabled')
  }
  const rpID = (env.MC_WEBAUTHN_RP_ID || '').trim().toLowerCase()
  const rawOrigin = (env.MC_WEBAUTHN_ORIGIN || '').trim()
  const rpName = (env.MC_WEBAUTHN_RP_NAME || 'Lugos Mission Control').trim()
  let origin: URL
  try {
    origin = new URL(rawOrigin)
  } catch {
    throw new RemoteDecisionUnavailableError('remote_step_up_provider_unconfigured')
  }
  if (!rpID
    || rpID.length > 253
    || origin.protocol !== 'https:'
    || origin.hostname.toLowerCase() !== rpID
    || origin.username
    || origin.password
    || origin.pathname !== '/'
    || origin.search
    || origin.hash
    || !rpName
    || rpName.length > 64) {
    throw new RemoteDecisionUnavailableError('remote_step_up_provider_unconfigured')
  }
  return { rpID, origin: origin.origin, rpName }
}

export function assertRemoteDecisionRequestOrigin(request: Request): void {
  const config = webAuthnConfig()
  const origin = request.headers.get('origin') || ''
  const forwardedProto = (request.headers.get('x-forwarded-proto') || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
  const forwardedHost = (request.headers.get('x-forwarded-host')
    || request.headers.get('host')
    || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
  let requestProtocol = ''
  try {
    requestProtocol = new URL(request.url).protocol
  } catch {
    // Fail closed below.
  }
  if (origin !== config.origin
    || !['https', 'https:'].includes(forwardedProto || requestProtocol)
    || forwardedHost.replace(/:443$/, '') !== config.rpID) {
    throw new RemoteDecisionUnavailableError('remote_step_up_origin_invalid')
  }
}

function requireHumanUser(user: User): void {
  if (!Number.isSafeInteger(user.id) || user.id <= 0 || user.provider !== 'local') {
    throw new RemoteDecisionUnavailableError('remote_step_up_identity_unsupported')
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000)
}

function cleanupExpired(now: number): void {
  const database = getDatabase()
  database.prepare(`
    DELETE FROM remote_decision_webauthn_challenges
    WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)
  `).run(now - CHALLENGE_LIFETIME_SECONDS, now - CHALLENGE_LIFETIME_SECONDS)
  database.prepare(`
    DELETE FROM remote_decision_step_up_grants
    WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)
  `).run(now - STEP_UP_GRANT_LIFETIME_SECONDS, now - STEP_UP_GRANT_LIFETIME_SECONDS)
}

function parseTransports(value: string): AuthenticatorTransportFuture[] {
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
      return parsed as AuthenticatorTransportFuture[]
    }
  } catch {
    // Corrupt passkey rows fail closed below.
  }
  throw new RemoteDecisionUnavailableError('remote_passkey_record_corrupt')
}

function passkeysForUser(userId: number): PasskeyRow[] {
  return getDatabase().prepare(`
    SELECT * FROM remote_decision_passkeys
    WHERE user_id = ? ORDER BY created_at, credential_id
  `).all(userId) as PasskeyRow[]
}

function verifyCurrentPassword(user: User, currentPassword: string): void {
  if (typeof currentPassword !== 'string' || currentPassword.length > 512) {
    throw new RemoteDecisionUnavailableError('remote_passkey_password_invalid')
  }
  const password = getDatabase().prepare(
    'SELECT password_hash FROM users WHERE id = ?',
  ).get(user.id) as { password_hash: string } | undefined
  if (!password || !verifyPassword(currentPassword, password.password_hash)) {
    throw new RemoteDecisionUnavailableError('remote_passkey_password_invalid')
  }
}

function consumeChallenge(
  challengeId: string,
  userId: number,
  kind: ChallengeRow['kind'],
): ChallengeRow {
  if (!/^challenge-[a-f0-9]{32}$/.test(challengeId)) {
    throw new RemoteDecisionUnavailableError('remote_step_up_challenge_invalid')
  }
  const database = getDatabase()
  const now = nowSeconds()
  return database.transaction(() => {
    const row = database.prepare(`
      SELECT * FROM remote_decision_webauthn_challenges
      WHERE challenge_id = ? AND user_id = ? AND kind = ?
    `).get(challengeId, userId, kind) as ChallengeRow | undefined
    if (!row || row.consumed_at !== null || row.expires_at < now) {
      throw new RemoteDecisionUnavailableError('remote_step_up_challenge_invalid')
    }
    const update = database.prepare(`
      UPDATE remote_decision_webauthn_challenges SET consumed_at = ?
      WHERE challenge_id = ? AND consumed_at IS NULL
    `).run(now, challengeId)
    if (update.changes !== 1) {
      throw new RemoteDecisionUnavailableError('remote_step_up_challenge_invalid')
    }
    return row
  })()
}

export async function registrationOptions(
  user: User,
  currentPassword: string,
): Promise<{ challenge_id: string; options: Awaited<ReturnType<typeof generateRegistrationOptions>> }> {
  requireHumanUser(user)
  const database = getDatabase()
  verifyCurrentPassword(user, currentPassword)
  const existing = passkeysForUser(user.id)
  if (existing.length >= MAX_PASSKEYS_PER_USER) {
    throw new RemoteDecisionUnavailableError('remote_passkey_limit_reached')
  }
  const config = webAuthnConfig()
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userID: new Uint8Array(Buffer.from(`mc-user:${user.id}`, 'utf8')),
    userName: user.username,
    userDisplayName: user.display_name,
    timeout: 60_000,
    attestationType: 'none',
    excludeCredentials: existing.map(passkey => ({
      id: passkey.credential_id,
      transports: parseTransports(passkey.transports),
    })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
  })
  const challengeId = `challenge-${randomBytes(16).toString('hex')}`
  const now = nowSeconds()
  cleanupExpired(now)
  database.prepare(`
    INSERT INTO remote_decision_webauthn_challenges (
      challenge_id, user_id, kind, challenge, binding_digest,
      expires_at, consumed_at, created_at
    ) VALUES (?, ?, 'registration', ?, NULL, ?, NULL, ?)
  `).run(challengeId, user.id, options.challenge, now + CHALLENGE_LIFETIME_SECONDS, now)
  return { challenge_id: challengeId, options }
}

export async function verifyPasskeyRegistration(
  user: User,
  challengeId: string,
  rawResponse: unknown,
): Promise<{ verified: true; credential_id: string }> {
  requireHumanUser(user)
  const config = webAuthnConfig()
  const challenge = consumeChallenge(challengeId, user.id, 'registration')
  if (!isCredentialResponse(rawResponse)) {
    throw new RemoteDecisionUnavailableError('remote_passkey_response_invalid')
  }
  let verification
  try {
    verification = await verifyRegistrationResponse({
      response: rawResponse as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserPresence: true,
      requireUserVerification: true,
    })
  } catch {
    throw new RemoteDecisionUnavailableError('remote_passkey_verification_failed')
  }
  if (!verification.verified || !verification.registrationInfo) {
    throw new RemoteDecisionUnavailableError('remote_passkey_verification_failed')
  }
  const { credential, credentialDeviceType, credentialBackedUp } = (
    verification.registrationInfo
  )
  const now = nowSeconds()
  try {
    getDatabase().prepare(`
      INSERT INTO remote_decision_passkeys (
        credential_id, user_id, public_key, counter, transports,
        device_type, backed_up, created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      credential.id,
      user.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      credentialDeviceType,
      credentialBackedUp ? 1 : 0,
      now,
      now,
    )
  } catch {
    throw new RemoteDecisionUnavailableError('remote_passkey_registration_conflict')
  }
  return { verified: true, credential_id: credential.id }
}

export async function authenticationOptions(
  user: User,
  bindingDigest: string,
): Promise<{ challenge_id: string; options: Awaited<ReturnType<typeof generateAuthenticationOptions>> }> {
  requireHumanUser(user)
  if (!DIGEST.test(bindingDigest)) {
    throw new RemoteDecisionUnavailableError('remote_step_up_binding_invalid')
  }
  const passkeys = passkeysForUser(user.id)
  if (passkeys.length === 0) {
    throw new RemoteDecisionUnavailableError('remote_passkey_not_enrolled')
  }
  const config = webAuthnConfig()
  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    timeout: 60_000,
    userVerification: 'required',
    allowCredentials: passkeys.map(passkey => ({
      id: passkey.credential_id,
      transports: parseTransports(passkey.transports),
    })),
  })
  const challengeId = `challenge-${randomBytes(16).toString('hex')}`
  const now = nowSeconds()
  cleanupExpired(now)
  getDatabase().prepare(`
    INSERT INTO remote_decision_webauthn_challenges (
      challenge_id, user_id, kind, challenge, binding_digest,
      expires_at, consumed_at, created_at
    ) VALUES (?, ?, 'authentication', ?, ?, ?, NULL, ?)
  `).run(
    challengeId,
    user.id,
    options.challenge,
    bindingDigest,
    now + CHALLENGE_LIFETIME_SECONDS,
    now,
  )
  return { challenge_id: challengeId, options }
}

export async function verifyPasskeyAuthentication(
  user: User,
  challengeId: string,
  rawResponse: unknown,
): Promise<{ step_up_token: string; expires_at: string }> {
  requireHumanUser(user)
  const config = webAuthnConfig()
  const challenge = consumeChallenge(challengeId, user.id, 'authentication')
  if (!challenge.binding_digest || !DIGEST.test(challenge.binding_digest)
    || !isCredentialResponse(rawResponse)) {
    throw new RemoteDecisionUnavailableError('remote_passkey_response_invalid')
  }
  const response = rawResponse as AuthenticationResponseJSON
  const passkey = getDatabase().prepare(`
    SELECT * FROM remote_decision_passkeys
    WHERE credential_id = ? AND user_id = ?
  `).get(response.id, user.id) as PasskeyRow | undefined
  if (!passkey) {
    throw new RemoteDecisionUnavailableError('remote_passkey_not_found')
  }
  let verification
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserVerification: true,
      credential: {
        id: passkey.credential_id,
        publicKey: new Uint8Array(passkey.public_key),
        counter: passkey.counter,
        transports: parseTransports(passkey.transports),
      },
    })
  } catch {
    throw new RemoteDecisionUnavailableError('remote_passkey_verification_failed')
  }
  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    throw new RemoteDecisionUnavailableError('remote_passkey_verification_failed')
  }
  const now = nowSeconds()
  const rawToken = randomBytes(32).toString('base64url')
  const tokenHash = sha256(rawToken)
  const stepUpRef = canonicalDigest({
    schema: 'mc.remote-decision-step-up/v1',
    challenge_id: challenge.challenge_id,
    user_id: user.id,
    credential_id: passkey.credential_id,
    binding_digest: challenge.binding_digest,
    verified_at: new Date(now * 1_000).toISOString(),
  })
  const database = getDatabase()
  database.transaction(() => {
    database.prepare(`
      UPDATE remote_decision_passkeys
      SET counter = ?, device_type = ?, backed_up = ?, updated_at = ?, last_used_at = ?
      WHERE credential_id = ? AND user_id = ?
    `).run(
      verification.authenticationInfo.newCounter,
      verification.authenticationInfo.credentialDeviceType,
      verification.authenticationInfo.credentialBackedUp ? 1 : 0,
      now,
      now,
      passkey.credential_id,
      user.id,
    )
    database.prepare(`
      INSERT INTO remote_decision_step_up_grants (
        token_hash, user_id, binding_digest, step_up_ref,
        expires_at, consumed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?)
    `).run(
      tokenHash,
      user.id,
      challenge.binding_digest,
      stepUpRef,
      now + STEP_UP_GRANT_LIFETIME_SECONDS,
      now,
    )
  })()
  return {
    step_up_token: rawToken,
    expires_at: new Date((now + STEP_UP_GRANT_LIFETIME_SECONDS) * 1_000).toISOString(),
  }
}

export function consumeStepUpGrant(
  user: User,
  bindingDigest: string,
  rawToken: string,
): { step_up_ref: string } {
  requireHumanUser(user)
  if (!DIGEST.test(bindingDigest) || !/^[A-Za-z0-9_-]{43}$/.test(rawToken)) {
    throw new RemoteDecisionUnavailableError('remote_step_up_invalid')
  }
  const database = getDatabase()
  const now = nowSeconds()
  const tokenHash = sha256(rawToken)
  return database.transaction(() => {
    const grant = database.prepare(`
      SELECT * FROM remote_decision_step_up_grants
      WHERE token_hash = ? AND user_id = ? AND binding_digest = ?
    `).get(tokenHash, user.id, bindingDigest) as StepUpGrantRow | undefined
    if (!grant || grant.consumed_at !== null || grant.expires_at < now) {
      throw new RemoteDecisionUnavailableError('remote_step_up_invalid')
    }
    const update = database.prepare(`
      UPDATE remote_decision_step_up_grants SET consumed_at = ?
      WHERE token_hash = ? AND consumed_at IS NULL
    `).run(now, tokenHash)
    if (update.changes !== 1) {
      throw new RemoteDecisionUnavailableError('remote_step_up_invalid')
    }
    return { step_up_ref: grant.step_up_ref }
  })()
}

export function passkeyStatus(user: User): {
  enabled: boolean
  device_id: string
  passkeys: Array<{
    credential_id: string
    device_type: string
    backed_up: boolean
    created_at: string
    last_used_at: string | null
  }>
} {
  requireHumanUser(user)
  webAuthnConfig()
  return {
    enabled: true,
    device_id: configuredRemoteDecisionDeviceId(),
    passkeys: passkeysForUser(user.id).map(passkey => ({
      credential_id: passkey.credential_id,
      device_type: passkey.device_type,
      backed_up: passkey.backed_up === 1,
      created_at: new Date(passkey.created_at * 1_000).toISOString(),
      last_used_at: passkey.last_used_at === null
        ? null
        : new Date(passkey.last_used_at * 1_000).toISOString(),
    })),
  }
}

export function deletePasskey(
  user: User,
  credentialId: string,
  currentPassword: string,
): void {
  requireHumanUser(user)
  webAuthnConfig()
  if (!credentialId || credentialId.length > 2_048) {
    throw new RemoteDecisionUnavailableError('remote_passkey_not_found')
  }
  verifyCurrentPassword(user, currentPassword)
  const database = getDatabase()
  database.transaction(() => {
    const removed = database.prepare(`
      DELETE FROM remote_decision_passkeys
      WHERE credential_id = ? AND user_id = ?
    `).run(credentialId, user.id)
    if (removed.changes !== 1) {
      throw new RemoteDecisionUnavailableError('remote_passkey_not_found')
    }
    database.prepare(`
      DELETE FROM remote_decision_webauthn_challenges WHERE user_id = ?
    `).run(user.id)
    database.prepare(`
      DELETE FROM remote_decision_step_up_grants WHERE user_id = ?
    `).run(user.id)
  })()
}

function isCredentialResponse(value: unknown): value is { id: string } {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { id?: unknown }).id === 'string'
    && (value as { id: string }).id.length > 0
    && (value as { id: string }).id.length <= 2_048
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}
