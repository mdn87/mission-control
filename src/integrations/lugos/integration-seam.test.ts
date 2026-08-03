import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getPluginNavItems, getPluginPanel } from '@/lib/plugins'
import './register'

describe('Lugos Mission Control adoption seam', () => {
  it('registers through the upstream plugin surface', () => {
    expect(getPluginPanel('lugos')).toBeDefined()
    expect(getPluginNavItems()).toContainEqual(expect.objectContaining({
      id: 'lugos',
      groupId: 'observe',
    }))
  })

  it('uses same-origin browser routes and never references the Lugos bearer', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/integrations/lugos/lugos-panel.tsx'),
      'utf8',
    )
    expect(source).toContain("'/api/lugos/snapshot'")
    expect(source).toContain("'/api/lugos/commands'")
    expect(source).toContain('new EventSource(`/api/lugos/events')
    expect(source).not.toContain('LUGOS_OPERATOR_API_TOKEN')
    expect(source).not.toContain('Authorization')
  })

  it('requires only one routine import in the upstream panel router', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/app/[[...panel]]/page.tsx'),
      'utf8',
    )
    expect(source).toContain("import '@/integrations/lugos/register'")
  })
})
