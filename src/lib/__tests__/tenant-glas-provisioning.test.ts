import { expect, it } from 'vitest'

import { buildBootstrapPlan, createTenantAndBootstrapJob } from '@/lib/super-admin'

it('refuses tenant bootstrap before creating an unbound gateway', () => {
  expect(() => createTenantAndBootstrapJob({
    slug: 'sample', display_name: 'Sample', gateway_port: 18789,
  }, 'operator')).toThrow('requires per-tenant GLAS machine-account enrollment')
})

it('does not stage a tenant credential file in the bootstrap plan', () => {
  const plan = buildBootstrapPlan({
    slug: 'sample', linux_user: 'oc-sample', openclaw_home: '/home/oc-sample/.openclaw',
    workspace_root: '/home/oc-sample/workspace', gateway_port: 18789,
  }, {
    templateOpenclawJsonPath: '/srv/seed/openclaw.json',
    gatewaySystemdTemplatePath: '/srv/templates/openclaw-gateway@.service',
  })
  expect(JSON.stringify(plan)).not.toContain('openclaw-gateway.env')
  expect(JSON.stringify(plan)).not.toContain('install-tenant-gateway-env')
})
