import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OPERATOR_COMMAND_SCHEMA,
  type ApprovalRequestCommand,
} from './operator-contract'
import {
  fetchOperatorSnapshot,
  openOperatorEventStream,
  sendOperatorCommand,
} from './operator-client'
import { makeReceipt, makeSnapshot } from './__tests__/fixtures'

const command: ApprovalRequestCommand = {
  schema: OPERATOR_COMMAND_SCHEMA,
  type: 'approval.request',
  idempotency_key: 'mc-command-0001',
  payload: {
    subject: 'week-2-adoption',
    summary: 'Prove server-side receipt custody.',
  },
}

describe('Lugos operator server client', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      LUGOS_OPERATOR_API_URL: 'http://127.0.0.1:3231',
      LUGOS_OPERATOR_API_TOKEN: 'local-test-token-12345',
    }
  })

  afterEach(() => {
    process.env = originalEnv
    vi.unstubAllGlobals()
  })

  it('reads the snapshot without sending the command bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(makeSnapshot()))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchOperatorSnapshot()).resolves.toEqual(makeSnapshot())
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers).toEqual({ Accept: 'application/json' })
    expect(JSON.stringify(init)).not.toContain('local-test-token-12345')
  })

  it('keeps the Lugos bearer server-side when forwarding a typed command', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(makeReceipt(), { status: 202 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(sendOperatorCommand(command)).resolves.toEqual(makeReceipt())
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('http://127.0.0.1:3231/operator/v1/commands')
    expect(init.headers.Authorization).toBe('Bearer local-test-token-12345')
    expect(JSON.parse(init.body)).toEqual(command)
  })

  it('opens replay from the supplied cursor without attaching the command bearer', async () => {
    const stream = new ReadableStream()
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, {
      headers: { 'content-type': 'text/event-stream' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const controller = new AbortController()
    await expect(openOperatorEventStream('event-0002', controller.signal))
      .resolves.toBeInstanceOf(Response)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('after=event-0002')
    expect(init.headers['Last-Event-ID']).toBe('event-0002')
    expect(JSON.stringify(init)).not.toContain('local-test-token-12345')
  })

  it('rejects an incompatible receipt instead of accepting schema churn', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      ...makeReceipt(),
      mission_control_id: 42,
    }, { status: 202 })))

    await expect(sendOperatorCommand(command)).rejects.toThrow()
  })
})
