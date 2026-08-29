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

  it('allows only the explicit remote-decision exception on the HTTPS public origin', async () => {
    vi.resetModules()
    vi.doMock('node:os', () => ({
      default: { hostname: () => 'lugos-host' },
      hostname: () => 'lugos-host',
    }))
    const { proxy } = await import('./proxy')
    const request = (pathname: string) => ({
      headers: new Headers({
        host: 'knot.newman.foo',
        origin: 'https://knot.newman.foo',
        'x-forwarded-host': 'knot.newman.foo',
      }),
      nextUrl: {
        host: 'knot.newman.foo',
        hostname: 'knot.newman.foo',
        pathname,
        searchParams: new URLSearchParams(),
        clone: () => ({ pathname }),
      },
      method: 'POST',
      cookies: { get: () => ({ value: 'authenticated-session' }) },
    } as any)

    setNodeEnv('production')
    process.env.MC_ALLOWED_HOSTS = '10.0.1.33,lugos-host,knot.newman.foo'
    process.env.MC_LUGOS_PUBLIC_READ_ONLY_HOSTS = 'knot.newman.foo'
    process.env.MC_LUGOS_REMOTE_DECISION_HOSTS = 'knot.newman.foo'

    expect(proxy(request('/api/lugos/remote-decisions/step-up/options')).status)
      .not.toBe(403)
    expect(proxy(request('/api/lugos/model-budgets')).status).toBe(403)

    delete process.env.MC_LUGOS_PUBLIC_READ_ONLY_HOSTS
    delete process.env.MC_LUGOS_REMOTE_DECISION_HOSTS
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

describe('proxy attestation at the edge gate', () => {
  const SECRET = '0123456789abcdef0123456789abcdef'

  function request(pathname: string, headers: Record<string, string>) {
    return {
      headers: new Headers({ host: 'localhost', ...headers }),
      nextUrl: {
        host: 'localhost', hostname: 'localhost', pathname,
        searchParams: new URLSearchParams(),
        // A real URL: NextResponse.redirect rejects anything else, and the
        // no-session page path redirects.
        clone: () => new URL(`http://localhost${pathname}`),
      },
      method: 'GET',
      cookies: { get: () => undefined },
    } as any
  }

  async function loadProxy(env: Record<string, string | undefined>) {
    vi.resetModules()
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    return (await import('./proxy')).proxy
  }

  it('admits an attested API request that has no session or API key', async () => {
    const proxy = await loadProxy({
      MC_PROXY_AUTH_HEADER: 'X-User-Email',
      MC_PROXY_AUTH_SECRET: SECRET,
    })
    const res = proxy(request('/api/agents', {
      'x-mc-proxy-secret': SECRET,
      'x-user-email': 'admin',
    }))
    expect(res.status).not.toBe(401)
  })

  it('admits an attested page request instead of redirecting to /login', async () => {
    const proxy = await loadProxy({
      MC_PROXY_AUTH_HEADER: 'X-User-Email',
      MC_PROXY_AUTH_SECRET: SECRET,
    })
    const res = proxy(request('/dashboard', {
      'x-mc-proxy-secret': SECRET,
      'x-user-email': 'admin',
    }))
    expect(res.status).toBe(200)
  })

  it('does not admit an identity header without the attestation secret', async () => {
    const proxy = await loadProxy({
      MC_PROXY_AUTH_HEADER: 'X-User-Email',
      MC_PROXY_AUTH_SECRET: SECRET,
    })
    expect(proxy(request('/api/agents', { 'x-user-email': 'admin' })).status).toBe(401)
    expect(proxy(request('/dashboard', { 'x-user-email': 'admin' })).status).toBe(307)
  })

  it('does not admit a same-length but incorrect secret', async () => {
    const proxy = await loadProxy({
      MC_PROXY_AUTH_HEADER: 'X-User-Email',
      MC_PROXY_AUTH_SECRET: SECRET,
    })
    const res = proxy(request('/api/agents', {
      'x-mc-proxy-secret': 'fedcba9876543210fedcba9876543210',
      'x-user-email': 'admin',
    }))
    expect(res.status).toBe(401)
  })

  it('does not admit anything when proxy auth is misconfigured', async () => {
    // The .env.example placeholder is public, so it must not gate the edge either.
    const placeholder = 'replace-with-at-least-32-random-characters'
    const proxy = await loadProxy({
      MC_PROXY_AUTH_HEADER: 'X-User-Email',
      MC_PROXY_AUTH_SECRET: placeholder,
    })
    const res = proxy(request('/api/agents', {
      'x-mc-proxy-secret': placeholder,
      'x-user-email': 'admin',
    }))
    expect(res.status).toBe(401)
  })

  it('does not admit when proxy auth is switched off entirely', async () => {
    const proxy = await loadProxy({
      MC_PROXY_AUTH_HEADER: undefined,
      MC_PROXY_AUTH_SECRET: SECRET,
    })
    const res = proxy(request('/api/agents', {
      'x-mc-proxy-secret': SECRET,
      'x-user-email': 'admin',
    }))
    expect(res.status).toBe(401)
  })
})
