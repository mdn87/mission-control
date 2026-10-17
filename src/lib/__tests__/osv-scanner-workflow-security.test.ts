import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const OSV_ACTION_SHA = '8dc09193bb540e09b23da07ad7e30bd33bf87018'

describe('OSV-Scanner workflow security contract', () => {
  it('compares the pnpm lockfile on pull requests with pinned OSV actions', () => {
    const source = readFileSync(
      join(process.cwd(), '.github/workflows/osv-scanner.yml'),
      'utf8',
    )

    expect(source).toContain('pull_request:')
    expect(source).toContain('merge_group:')
    expect(source).not.toContain('push:')
    expect(source).toContain('actions: read')
    expect(source).toContain('contents: read')
    expect(source).toContain('security-events: write')
    expect(source).not.toContain('contents: write')
    expect(source).not.toContain('pull-requests: write')
    expect(source).toContain('--lockfile=./pnpm-lock.yaml')
    expect(source).toContain('--old=old-results.json')
    expect(source).toContain('--new=new-results.json')
    expect(source).toContain('--fail-on-vuln=true')
    expect(source).toContain('github/codeql-action/upload-sarif@')
    // Full scan results exceed the 1 MB job-output limit.
    expect(source).not.toContain('GITHUB_OUTPUT')

    const actionRefs = [...source.matchAll(/uses:\s+(\S+)@(\S+)/g)].map((match) => ({
      action: match[1],
      ref: match[2],
    }))
    expect(actionRefs.length).toBeGreaterThan(0)
    for (const { ref } of actionRefs) expect(ref).toMatch(/^[0-9a-f]{40}$/)
    const osvRefs = actionRefs.filter(({ action }) => action.startsWith('google/osv-scanner-action/'))
    expect(osvRefs.map(({ action }) => action)).toEqual([
      'google/osv-scanner-action/osv-scanner-action',
      'google/osv-scanner-action/osv-scanner-action',
      'google/osv-scanner-action/osv-reporter-action',
    ])
    for (const { ref } of osvRefs) expect(ref).toBe(OSV_ACTION_SHA)
  })
})
