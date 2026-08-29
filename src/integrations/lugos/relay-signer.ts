import {
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto'
import {
  assertParameterFreeRemoteDecision,
  canonicalJson,
  MAX_REMOTE_DECISION_LIFETIME_SECONDS,
  REMOTE_DECISION_CAPSULE_SCHEMA,
  remoteDecisionCapsuleSchema,
  remoteRelayEnqueueSchema,
  type RemoteDecisionCapsule,
  type RemoteRelayEnqueueInput,
  type UnsignedRemoteDecisionCapsule,
} from './remote-decision-contract'

export interface RelaySigningKey {
  key_id: string
  issuer_id: string
  private_key: KeyObject
}

export interface RelayKeyProvider {
  activeSigningKey(): RelaySigningKey
}

export class RelaySignerUnavailableError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'RelaySignerUnavailableError'
  }
}

export function relayIssuerEnabled(): boolean {
  return process.env.LUGOS_RELAY_ISSUER_ENABLED === 'true'
}

export class RemoteRelaySigner {
  constructor(
    private readonly provider: RelayKeyProvider,
    private readonly options: {
      enabled?: () => boolean
      clock?: () => Date
      nonce?: () => string
      capsuleId?: () => string
      lifetimeSeconds?: number
    } = {},
  ) {
    const lifetime = options.lifetimeSeconds ?? 60
    if (!Number.isSafeInteger(lifetime)
      || lifetime < 1
      || lifetime > MAX_REMOTE_DECISION_LIFETIME_SECONDS) {
      throw new TypeError('Remote relay lifetime is invalid')
    }
  }

  sign(input: RemoteRelayEnqueueInput): RemoteDecisionCapsule {
    if (!(this.options.enabled ?? relayIssuerEnabled)()) {
      throw new RelaySignerUnavailableError('relay_issuer_disabled')
    }
    const request = remoteRelayEnqueueSchema.parse(input)
    assertParameterFreeRemoteDecision(request)
    const key = this.provider.activeSigningKey()
    if (key.private_key.type !== 'private'
      || key.private_key.asymmetricKeyType !== 'ed25519') {
      throw new RelaySignerUnavailableError('relay_signing_key_invalid')
    }
    const issuedAt = (this.options.clock ?? (() => new Date()))()
    if (!Number.isFinite(issuedAt.getTime())) {
      throw new RelaySignerUnavailableError('relay_clock_invalid')
    }
    const lifetime = this.options.lifetimeSeconds ?? 60
    const unsigned: UnsignedRemoteDecisionCapsule = {
      schema: REMOTE_DECISION_CAPSULE_SCHEMA,
      key_id: key.key_id,
      issuer_id: key.issuer_id,
      capsule_id: (this.options.capsuleId ?? (
        () => `capsule-${randomBytes(18).toString('hex')}`
      ))(),
      command_id: request.command_id,
      actor_id: request.actor_id,
      audience: request.audience,
      device_id: request.device_id,
      decision: request.decision,
      proposal_hash: request.proposal_hash,
      action_id: request.action_id,
      work_context_hash: request.work_context_hash,
      issued_at: issuedAt.toISOString(),
      expires_at: new Date(issuedAt.getTime() + lifetime * 1000).toISOString(),
      nonce: (this.options.nonce ?? (() => randomBytes(16).toString('base64url')))(),
      step_up_ref: request.step_up_ref,
    }
    const signature = sign(
      null,
      Buffer.from(canonicalJson(unsigned), 'utf8'),
      key.private_key,
    ).toString('base64url')
    return remoteDecisionCapsuleSchema.parse({ ...unsigned, signature })
  }
}
