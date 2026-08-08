import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'

const mocks = vi.hoisted(() => ({
  port: 19876,
  connectFrames: [] as any[],
  requestFrames: [] as any[],
  sendChallenge: true,
}))

vi.mock('@/lib/config', () => ({
  config: {
    gatewayHost: '127.0.0.1',
    gatewayPort: mocks.port,
  },
}))

vi.mock('@/lib/gateway-runtime', () => ({
  getDetectedGatewayToken: () => 'test-token',
}))

import { callOpenClawGateway, parseGatewayJsonOutput, isUnknownMethodError } from '@/lib/openclaw-gateway'

let server: WebSocketServer

beforeAll(async () => {
  server = new WebSocketServer({ host: '127.0.0.1', port: mocks.port })
  server.on('connection', (ws) => {
    if (mocks.sendChallenge) {
      ws.send(JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'nonce-1' },
      }))
    }

    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString())
      if (frame.method === 'connect') {
        mocks.connectFrames.push(frame)
        ws.send(JSON.stringify({
          type: 'res',
          id: frame.id,
          ok: true,
          result: { protocol: 3 },
        }))
        return
      }

      mocks.requestFrames.push(frame)
      ws.send(JSON.stringify({
        type: 'res',
        id: frame.id,
        ok: true,
        result: { ok: true, echo: frame.params, expectFinal: frame.expectFinal === true },
      }))
    })
  })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('isUnknownMethodError (issue #645)', () => {
  it('detects the sessions_spawn removal error from newer gateways', () => {
    expect(isUnknownMethodError(new Error('unknown method: sessions_spawn'))).toBe(true)
    expect(isUnknownMethodError(new Error('Gateway error: method not found'))).toBe(true)
    expect(isUnknownMethodError('no such method: sessions_spawn')).toBe(true)
    expect(isUnknownMethodError(new Error('unsupported method'))).toBe(true)
  })

  it('does not misclassify unrelated gateway errors', () => {
    expect(isUnknownMethodError(new Error('connection refused'))).toBe(false)
    expect(isUnknownMethodError(new Error('unknown field: tools.profile'))).toBe(false)
    expect(isUnknownMethodError(new Error('timeout after 15000ms'))).toBe(false)
    expect(isUnknownMethodError(null)).toBe(false)
    expect(isUnknownMethodError(undefined)).toBe(false)
  })
})

describe('parseGatewayJsonOutput', () => {
  it('parses embedded object payloads', () => {
    expect(parseGatewayJsonOutput('warn\n{"status":"started","runId":"abc"}\n')).toEqual({
      status: 'started',
      runId: 'abc',
    })
  })

  it('parses embedded array payloads', () => {
    expect(parseGatewayJsonOutput('note\n[{"id":1},{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('returns null for non-json output', () => {
    expect(parseGatewayJsonOutput('plain text only')).toBeNull()
  })
})

describe('callOpenClawGateway', () => {
  beforeEach(() => {
    mocks.connectFrames = []
    mocks.requestFrames = []
    mocks.sendChallenge = true
  })

  it('sends params over the programmatic websocket RPC path', async () => {
    const result = await callOpenClawGateway(
      'agent',
      { message: 'hello', deliver: false },
      5000,
      { expectFinal: true },
    )

    expect(result).toEqual({
      ok: true,
      expectFinal: true,
      echo: {
        message: 'hello',
        deliver: false,
      },
    })
    expect(mocks.connectFrames).toHaveLength(1)
    expect(mocks.connectFrames[0].params).toMatchObject({
      minProtocol: 4,
      maxProtocol: 4,
    })
    expect(mocks.requestFrames).toHaveLength(1)
    expect(mocks.requestFrames[0]).toMatchObject({
      type: 'req',
      method: 'agent',
      expectFinal: true,
      params: {
        message: 'hello',
        deliver: false,
      },
    })
  })

  it('does not depend on constructor static ready-state properties after bundling', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/lib/openclaw-gateway.ts'),
      'utf8',
    )

    expect(source).toContain('const WEBSOCKET_OPEN = 1')
    expect(source).not.toContain('WebSocket.OPEN')
    expect(source).not.toContain('WebSocket.CONNECTING')
  })

  it('rejects gateway RPC errors', async () => {
    server.once('connection', (ws) => {
      ws.removeAllListeners('message')
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString())
        if (frame.method === 'connect') {
          ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, result: {} }))
        } else {
          ws.send(JSON.stringify({ type: 'res', id: frame.id, ok: false, error: { message: 'boom' } }))
        }
      })
    })

    await expect(callOpenClawGateway('agent', {
      message: 'hello',
      deliver: false,
    }, 5000)).rejects.toThrow('boom')
  })

  it('connects to gateways that do not send a challenge', async () => {
    mocks.sendChallenge = false

    const result = await callOpenClawGateway('sessions_send', {
      sessionKey: 'agent:test:main',
      message: 'hello',
    }, 5000)

    expect(result).toMatchObject({
      ok: true,
      echo: {
        sessionKey: 'agent:test:main',
        message: 'hello',
      },
    })
  })
})
