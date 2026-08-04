import { describe, expect, it } from 'vitest'
import { loadCockpitDestinations } from './cockpit-destinations'

describe('cockpit specialist destinations', () => {
  it('publishes only approved public HTTPS routes from server configuration', () => {
    const value = loadCockpitDestinations({
      MC_LUGOS_FILES_PUBLIC_URL: 'https://files.newman.foo',
    })
    expect(value.destinations.find(item => item.id === 'files')?.href)
      .toBe('https://files.newman.foo/')
    expect(value.destinations.find(item => item.id === 'traces')?.href).toBeNull()
  })

  it.each([
    'http://files.newman.foo',
    'https://127.0.0.1:8487',
    'https://10.0.1.33:8487',
    'https://user:secret@files.newman.foo',
    'https://files.newman.foo/?token=secret',
  ])('rejects private, insecure, or credential-bearing destination %s', value => {
    expect(() => loadCockpitDestinations({
      MC_LUGOS_FILES_PUBLIC_URL: value,
    })).toThrow(/public HTTPS URL/)
  })
})
