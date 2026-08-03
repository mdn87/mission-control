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
    const panelSource = readFileSync(
      resolve(process.cwd(), 'src/integrations/lugos/lugos-panel.tsx'),
      'utf8',
    )
    const hookSource = readFileSync(
      resolve(process.cwd(), 'src/integrations/lugos/use-lugos-operator.ts'),
      'utf8',
    )
    const source = `${panelSource}\n${hookSource}`
    expect(hookSource).toContain("'/api/lugos/snapshot'")
    expect(panelSource).toContain("'/api/lugos/commands'")
    expect(hookSource).toContain('new EventSource(`/api/lugos/events')
    expect(panelSource).toContain("type: 'mail.handoff'")
    expect(panelSource).toContain("type: 'task.approve'")
    expect(panelSource).toContain('Agent Mail owns the handoff')
    expect(source).not.toContain('LUGOS_OPERATOR_API_TOKEN')
    expect(source).not.toContain('Authorization')
  })

  it('registers the dense panel and replaces the overview at one explicit router seam', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/app/[[...panel]]/page.tsx'),
      'utf8',
    )
    expect(source).toContain("import '@/integrations/lugos/register'")
    expect(source).toContain("import { LugosSpatialOverview } from '@/integrations/lugos/lugos-spatial-overview'")
    expect(source).toMatch(/case 'overview':\s+return <LugosSpatialOverview \/>/)
  })

  it('keeps map placement derived and limits motion to active state', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/integrations/lugos/lugos-spatial-overview.tsx'),
      'utf8',
    )
    expect(source).toContain('Automatic semantic layout')
    expect(source).toContain("entity.status === 'active'")
    expect(source).toContain('motion-reduce:animate-none')
    expect(source).not.toContain('draggable')
    expect(source).not.toContain('localStorage')
    expect(source).not.toContain('onDrag')
  })
})
