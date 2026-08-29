import { timingSafeEqual } from 'node:crypto'
import {
  remoteDecisionAcknowledgementSchema,
  remoteRelayEnqueueSchema,
  type RemoteDecisionAcknowledgement,
  type RemoteDecisionCapsule,
  type RemoteDecisionRevocation,
  type RemoteRelayEnqueueInput,
} from '../integrations/lugos/remote-decision-contract'
import { RemoteRelayIssuer } from '../integrations/lugos/relay-issuer'
import {
  RemoteRelayQueue,
  type ClaimedRemoteDecision,
  type RelayMaintenanceResult,
} from '../integrations/lugos/relay-queue'

export interface RelayDeviceIdentity {
  device_id: string
  transport_principal: string
  certificate_sha256: string
}

export class RelayRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code)
    this.name = 'RelayRequestError'
  }
}

export class RemoteRelayApplication {
  constructor(
    private readonly issuer: RemoteRelayIssuer,
    private readonly queue: RemoteRelayQueue,
    private readonly internalToken: string,
  ) {
    if (!/^[A-Za-z0-9._~-]{32,256}$/.test(internalToken)) {
      throw new TypeError('Remote relay internal token is invalid')
    }
  }

  enqueue(
    authorization: string | undefined,
    rawInput: unknown,
  ): RemoteDecisionCapsule {
    this.authorizeInternal(authorization)
    const input: RemoteRelayEnqueueInput = remoteRelayEnqueueSchema.parse(rawInput)
    return this.issuer.enqueue(input)
  }

  claim(
    identity: RelayDeviceIdentity,
    rawInput: unknown,
  ): ClaimedRemoteDecision | null {
    const input = requireExactObject(rawInput, ['device_id'])
    if (input.device_id !== identity.device_id) {
      throw new RelayRequestError('relay_device_mismatch', 403)
    }
    return this.queue.claimNext(identity.device_id)
  }

  getRevocation(
    identity: RelayDeviceIdentity,
    capsuleId: string,
    commandId: string,
  ): RemoteDecisionRevocation | null {
    if (this.queue.targetDevice(capsuleId) !== identity.device_id) {
      throw new RelayRequestError('relay_device_mismatch', 403)
    }
    return this.queue.revocation(capsuleId, commandId)
  }

  acknowledge(
    identity: RelayDeviceIdentity,
    rawInput: unknown,
  ): ReturnType<RemoteRelayQueue['acknowledge']> {
    const acknowledgement: RemoteDecisionAcknowledgement = (
      remoteDecisionAcknowledgementSchema.parse(rawInput)
    )
    if (acknowledgement.device_id !== identity.device_id
      || acknowledgement.transport_principal !== identity.transport_principal) {
      throw new RelayRequestError('relay_acknowledgement_identity_mismatch', 403)
    }
    return this.queue.acknowledge(acknowledgement)
  }

  maintain(): RelayMaintenanceResult {
    return this.queue.maintain()
  }

  private authorizeInternal(authorization: string | undefined): void {
    const prefix = 'Bearer '
    if (!authorization?.startsWith(prefix)) {
      throw new RelayRequestError('relay_internal_unauthorized', 401)
    }
    const presented = Buffer.from(authorization.slice(prefix.length), 'utf8')
    const expected = Buffer.from(this.internalToken, 'utf8')
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      throw new RelayRequestError('relay_internal_unauthorized', 401)
    }
  }
}

function requireExactObject(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RelayRequestError('relay_request_invalid', 400)
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const expected = [...fields].sort()
  if (keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])) {
    throw new RelayRequestError('relay_request_invalid', 400)
  }
  return record
}
