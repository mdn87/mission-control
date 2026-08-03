import {
  approvalRequestCommandSchema,
  operatorReceiptSchema,
  operatorSnapshotSchema,
  type ApprovalRequestCommand,
  type OperatorReceipt,
  type OperatorSnapshot,
} from './operator-contract'

const OPERATOR_TIMEOUT_MS = 5000

export class LugosOperatorUpstreamError extends Error {
  readonly status: number

  constructor(status: number) {
    super('Lugos operator API request failed')
    this.name = 'LugosOperatorUpstreamError'
    this.status = status
  }
}

function operatorBaseUrl(): URL {
  const raw = process.env.LUGOS_OPERATOR_API_URL
  if (!raw) throw new Error('LUGOS_OPERATOR_API_URL is not configured')
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash) {
    throw new Error('LUGOS_OPERATOR_API_URL is invalid')
  }
  return url
}

function operatorUrl(pathname: string): URL {
  const base = operatorBaseUrl()
  base.pathname = `${base.pathname.replace(/\/+$/, '')}${pathname}`
  return base
}

function commandToken(): string {
  const token = process.env.LUGOS_OPERATOR_API_TOKEN
  if (!token || token.length < 16) {
    throw new Error('LUGOS_OPERATOR_API_TOKEN is not configured')
  }
  return token
}

async function checkedJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new LugosOperatorUpstreamError(response.status)
  }
  return response.json()
}

export async function fetchOperatorSnapshot(): Promise<OperatorSnapshot> {
  const response = await fetch(operatorUrl('/operator/v1/snapshot'), {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(OPERATOR_TIMEOUT_MS),
  })
  return operatorSnapshotSchema.parse(await checkedJson(response))
}

export async function openOperatorEventStream(
  cursor: string | null,
  signal: AbortSignal,
): Promise<Response> {
  const url = operatorUrl('/operator/v1/events')
  if (cursor) url.searchParams.set('after', cursor)
  const response = await fetch(url, {
    headers: {
      Accept: 'text/event-stream',
      ...(cursor ? { 'Last-Event-ID': cursor } : {}),
    },
    cache: 'no-store',
    signal,
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {})
    throw new LugosOperatorUpstreamError(response.status)
  }
  return response
}

export async function sendOperatorCommand(
  input: ApprovalRequestCommand,
): Promise<OperatorReceipt> {
  const command = approvalRequestCommandSchema.parse(input)
  const response = await fetch(operatorUrl('/operator/v1/commands'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${commandToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
    cache: 'no-store',
    signal: AbortSignal.timeout(OPERATOR_TIMEOUT_MS),
  })
  return operatorReceiptSchema.parse(await checkedJson(response))
}
