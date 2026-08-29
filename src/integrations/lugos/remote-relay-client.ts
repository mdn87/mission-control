import type {
  RemoteDecisionCapsule,
} from './remote-decision-contract'
import {
  MAX_REMOTE_DECISION_CAPSULE_BYTES,
  remoteDecisionCapsuleSchema,
} from './remote-decision-contract'
import {
  RemoteDecisionUnavailableError,
  type RemoteRelayEnqueueInput,
} from './remote-relay-service'

export async function enqueueRemoteDecision(
  input: RemoteRelayEnqueueInput,
): Promise<RemoteDecisionCapsule> {
  const config = relayClientConfig()
  let response: Response
  try {
    response = await fetch(`${config.baseUrl}/internal/v1/enqueue`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    throw new RemoteDecisionUnavailableError('remote_relay_issuer_unavailable')
  }
  if (response.status !== 202) {
    throw new RemoteDecisionUnavailableError('remote_relay_issuer_rejected')
  }
  try {
    const body = await readBoundedResponse(
      response,
      MAX_REMOTE_DECISION_CAPSULE_BYTES,
    )
    return remoteDecisionCapsuleSchema.parse(JSON.parse(body))
  } catch {
    throw new RemoteDecisionUnavailableError('remote_relay_issuer_invalid_response')
  }
}

function relayClientConfig(env: NodeJS.ProcessEnv = process.env): {
  baseUrl: string
  token: string
} {
  const rawUrl = (env.LUGOS_RELAY_INTERNAL_URL || '').trim()
  const token = (env.LUGOS_RELAY_INTERNAL_TOKEN || '').trim()
  if (!rawUrl || !/^[A-Za-z0-9._~-]{32,256}$/.test(token)) {
    throw new RemoteDecisionUnavailableError('remote_relay_issuer_unconfigured')
  }
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new RemoteDecisionUnavailableError('remote_relay_issuer_unconfigured')
  }
  if (url.protocol !== 'http:'
    || !['127.0.0.1', '[::1]', '::1'].includes(url.hostname)
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash) {
    throw new RemoteDecisionUnavailableError('remote_relay_issuer_unconfigured')
  }
  return { baseUrl: url.origin, token }
}

async function readBoundedResponse(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') || 0)
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > limit) {
    throw new Error('response_too_large')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new Error('response_too_large')
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(merged)
}
