import { describe, expect, it, vi } from 'vitest'

function setNodeEnv(value: string) {
  ;(process.env as Record<string, string | undefined>).NODE_ENV = value
}

describe('proxy host matching', () => {
  it('fails closed to implicit hosts when MC_ALLOWED_HOSTS is unset in production', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))

    const { proxy } = await import('./proxy')
    const request = {
      headers: new Headers({ host: 'evil.example.com' }),
      nextUrl: { host: 'evil.example.com', hostname: 'evil.example.com', pathname: '/login', clone: () => ({ pathname: '/login' }) },
      method: 'GET',
      cookies: { get: () => undefined },
    } as any

    setNodeEnv('production')
    delete process.env.MC_ALLOWED_HOSTS
    delete process.env.MC_ALLOW_ANY_HOST

    expect(proxy(request).status).toBe(403)
  })

  it('keeps IPv6 loopback available under the implicit production allowlist', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))

    const { proxy } = await import('./proxy')
    const request = {
      headers: new Headers({ host: '[::1]:3000' }),
      nextUrl: { host: '[::1]:3000', hostname: '::1', pathname: '/login', clone: () => ({ pathname: '/login' }) },
      method: 'GET',
      cookies: { get: () => undefined },
    } as any

    setNodeEnv('production')
    delete process.env.MC_ALLOWED_HOSTS
    delete process.env.MC_ALLOW_ANY_HOST

    expect(proxy(request).status).not.toBe(403)
  })

  it('allows the system hostname implicitly', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))

    const { proxy } = await import('./proxy')
    const request = {
      headers: new Headers({ host: 'hetzner-jarv' }),
      nextUrl: { host: 'hetzner-jarv', hostname: 'hetzner-jarv', pathname: '/login', clone: () => ({ pathname: '/login' }) },
      method: 'GET',
      cookies: { get: () => undefined },
    } as any

    setNodeEnv('production')
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST

    const response = proxy(request)
    expect(response.status).not.toBe(403)
  })

  it('keeps blocking unrelated hosts in production', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))

    const { proxy } = await import('./proxy')
    const request = {
      headers: new Headers({ host: 'evil.example.com' }),
      nextUrl: { host: 'evil.example.com', hostname: 'evil.example.com', pathname: '/login', clone: () => ({ pathname: '/login' }) },
      method: 'GET',
      cookies: { get: () => undefined },
    } as any

    setNodeEnv('production')
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST

    const response = proxy(request)
    expect(response.status).toBe(403)
  })

  it('rejects an untrusted Host header even when Next reports an allowed socket host', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'lugos-host' },
      hostname: () => 'lugos-host',
    }))

    const { proxy } = await import('./proxy')
    const request = {
      headers: new Headers({ host: 'evil.example.com:3230' }),
      nextUrl: {
        host: '10.0.1.33:3230',
        hostname: '10.0.1.33',
        pathname: '/login',
        clone: () => ({ pathname: '/login' }),
      },
      method: 'GET',
      cookies: { get: () => undefined },
    } as any

    setNodeEnv('production')
    process.env.MC_ALLOWED_HOSTS = '10.0.1.33,lugos-host'
    delete process.env.MC_ALLOW_ANY_HOST

    const response = proxy(request)
    expect(response.status).toBe(403)
  })

  it('fails closed for Lugos commands on an allowlisted public origin', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'lugos-host' },
      hostname: () => 'lugos-host',
    }))

    const { proxy } = await import('./proxy')
    const request = {
      headers: new Headers({
        host: 'knot.newman.foo',
        'x-forwarded-host': 'knot.newman.foo',
      }),
      nextUrl: {
        host: 'knot.newman.foo',
        hostname: 'knot.newman.foo',
        pathname: '/api/lugos/commands',
        searchParams: new URLSearchParams(),
        clone: () => ({ pathname: '/api/lugos/commands' }),
      },
      method: 'POST',
      cookies: { get: () => ({ value: 'authenticated-session' }) },
    } as any

    setNodeEnv('production')
    process.env.MC_ALLOWED_HOSTS = '10.0.1.33,lugos-host,knot.newman.foo'
    process.env.MC_LUGOS_PUBLIC_READ_ONLY_HOSTS = 'knot.newman.foo'

    const response = proxy(request)
    delete process.env.MC_LUGOS_PUBLIC_READ_ONLY_HOSTS
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: 'Lugos commands are disabled on the public origin',
    })
  })

  it('keeps authenticated Lugos commands available on the LAN origin', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'lugos-host' },
      hostname: () => 'lugos-host',
    }))

    const { proxy } = await import('./proxy')
    const request = {
      headers: new Headers({ host: '10.0.1.33:3230' }),
      nextUrl: {
        host: '10.0.1.33:3230',
        hostname: '10.0.1.33',
        pathname: '/api/lugos/commands',
        searchParams: new URLSearchParams(),
        clone: () => ({ pathname: '/api/lugos/commands' }),
      },
      method: 'POST',
      cookies: { get: () => ({ value: 'authenticated-session' }) },
    } as any

    setNodeEnv('production')
    process.env.MC_ALLOWED_HOSTS = '10.0.1.33,lugos-host,knot.newman.foo'
    process.env.MC_LUGOS_PUBLIC_READ_ONLY_HOSTS = 'knot.newman.foo'

    const response = proxy(request)
    delete process.env.MC_LUGOS_PUBLIC_READ_ONLY_HOSTS
    expect(response.status).not.toBe(403)
  })

  it('allows unauthenticated health probe for /api/status?action=health', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))

    const { proxy } = await import('./proxy')
    const request = {
      headers: new Headers({ host: 'localhost:3000' }),
      nextUrl: {
        host: 'localhost:3000',
        hostname: 'localhost',
        pathname: '/api/status',
        searchParams: new URLSearchParams('action=health'),
        clone: () => ({ pathname: '/api/status' }),
      },
      method: 'GET',
      cookies: { get: () => undefined },
    } as any

    setNodeEnv('production')
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST

    const response = proxy(request)
    expect(response.status).not.toBe(401)
  })

  it('still blocks unauthenticated non-health status API calls', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))

    const { proxy } = await import('./proxy')
    const request = {
      headers: new Headers({ host: 'localhost:3000' }),
      nextUrl: {
        host: 'localhost:3000',
        hostname: 'localhost',
        pathname: '/api/status',
        searchParams: new URLSearchParams('action=overview'),
        clone: () => ({ pathname: '/api/status' }),
      },
      method: 'GET',
      cookies: { get: () => undefined },
    } as any

    setNodeEnv('production')
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST

    const response = proxy(request)
    expect(response.status).toBe(401)
  })

  it.each([
    ['dashboard-rotated mc_ key', 'mc_' + 'a1b2c3d4'.repeat(6)],
    ['agent-scoped mca_ key', 'mca_' + 'a1b2c3d4'.repeat(6)],
  ])('lets a %s through to route auth (issue #733)', async (_label, key) => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))

    const { proxy } = await import('./proxy')
    const request = {
      headers: new Headers({ host: 'localhost:3000', 'x-api-key': key }),
      nextUrl: {
        host: 'localhost:3000',
        hostname: 'localhost',
        pathname: '/api/tasks',
        searchParams: new URLSearchParams(),
        clone: () => ({ pathname: '/api/tasks' }),
      },
      method: 'GET',
      cookies: { get: () => undefined },
    } as any

    setNodeEnv('production')
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST
    delete process.env.API_KEY

    const response = proxy(request)
    expect(response.status).not.toBe(401)
  })

  it('still rejects malformed API keys at the proxy gate', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'hetzner-jarv' },
      hostname: () => 'hetzner-jarv',
    }))

    const { proxy } = await import('./proxy')
    const request = {
      headers: new Headers({ host: 'localhost:3000', 'x-api-key': 'mc_not-hex-and-too-short' }),
      nextUrl: {
        host: 'localhost:3000',
        hostname: 'localhost',
        pathname: '/api/tasks',
        searchParams: new URLSearchParams(),
        clone: () => ({ pathname: '/api/tasks' }),
      },
      method: 'GET',
      cookies: { get: () => undefined },
    } as any

    setNodeEnv('production')
    process.env.MC_ALLOWED_HOSTS = 'localhost,127.0.0.1'
    delete process.env.MC_ALLOW_ANY_HOST
    delete process.env.API_KEY

    const response = proxy(request)
    expect(response.status).toBe(401)
  })
})
