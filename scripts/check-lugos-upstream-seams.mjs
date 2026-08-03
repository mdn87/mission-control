import { execFileSync } from 'node:child_process'

const refs = ['v2.2.0', 'v2.3.0']
const assertions = {
  'src/lib/plugins.ts': [
    'export function registerNavItems',
    'export function registerPanel',
    'export function getPluginPanel',
  ],
  'src/app/[[...panel]]/page.tsx': [
    "import { getPluginPanel } from '@/lib/plugins'",
    'return renderPluginPanel(tab)',
  ],
  'src/components/layout/nav-rail.tsx': [
    "import { getPluginNavItems } from '@/lib/plugins'",
    'const mergedGroups = navGroups.map',
  ],
  'src/lib/auth.ts': [
    'export function requireRole',
    'viewer < operator < admin',
  ],
}

for (const ref of refs) {
  for (const [path, needles] of Object.entries(assertions)) {
    const source = execFileSync('git', ['show', `${ref}:${path}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const needle of needles) {
      if (!source.includes(needle)) {
        throw new Error(`${ref}:${path} is missing the Lugos seam: ${needle}`)
      }
    }
  }
}

console.log(`Lugos integration seams verified against ${refs.join(' and ')}`)
