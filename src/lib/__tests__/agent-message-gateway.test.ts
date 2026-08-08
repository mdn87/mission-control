import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('Agent message gateway contract', () => {
  it('sends agent messages through the authenticated gateway client', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/app/api/agents/message/route.ts'),
      'utf8',
    )

    expect(source).toContain("import { callOpenClawGateway } from '@/lib/openclaw-gateway'")
    expect(source).toContain("'sessions.send'")
    expect(source).toContain('key: agent.session_key')
    expect(source).not.toContain('runOpenClaw')
  })
})
