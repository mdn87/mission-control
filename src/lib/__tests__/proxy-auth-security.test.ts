import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

function makeAdminDatabase() {
  const admin = {
    id: 7,
    username: 'admin',
    display_name: 'Administrator',
    role: 'admin',
    workspace_id: 1,
    tenant_id: 1,
    provider: 'local',
    email: null,
    avatar_url: null,
    is_approved: 1,
    created_at: 1,
    updated_at: 1,
    last_login_at: null,
  }

  return {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => {
        if (sql.includes('FROM users u')) return admin
        if (sql.includes('FROM workspaces')) return { id: 1, tenant_id: 1 }
        return undefined
      }),
    })),
  }
}

/** A database in which no user row matches, so proxy identities cannot resolve. */
function makeEmptyDatabase() {
  return {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => (sql.includes('FROM workspaces') ? { id: 1, tenant_id: 1 } : undefined)),
    })),
  }
}

async function loadAuth(options: { database?: unknown } = {}) {
  const database = options.database ?? makeAdminDatabase()
  const logSecurityEvent = vi.fn()
  vi.doMock('@/lib/db', () => ({
    getDatabase: vi.fn(() => database),
  }))
  vi.doMock('@/lib/security-events', () => ({ logSecurityEvent }))
  vi.doMock('@/lib/password', () => ({
    hashPassword: vi.fn((value: string) => `hashed:${value}`),
    verifyPassword: vi.fn(() => false),
    verifyPasswordWithRehashCheck: vi.fn(() => ({ valid: false, needsRehash: false })),
  }))
  const auth = await import('@/lib/auth')
  return { ...auth, logSecurityEvent }
}

/** Reasons passed to logSecurityEvent for a given event_type. */
function rejectionReasons(logSecurityEvent: ReturnType<typeof vi.fn>): string[] {
  return logSecurityEvent.mock.calls
    .map(([event]) => event)
    .filter((event) => event?.event_type === 'proxy_auth_rejected')
    .map((event) => JSON.parse(event.detail).reason)
}

describe('trusted proxy header authentication', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env = {
      ...originalEnv,
      MC_PROXY_AUTH_HEADER: 'X-User-Email',
      MC_PROXY_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
    }
    delete process.env.API_KEY
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('ignores forwarding headers a client can set when claiming an identity', async () => {
    const { requireRole } = await loadAuth()
    const request = new Request('http://localhost/api/auth/users', {
      headers: {
        // Both are client-settable, and neither grants anything on its own.
        'x-real-ip': '127.0.0.1',
        'x-forwarded-for': '127.0.0.1',
        'x-user-email': 'admin',
      },
    })

    const result = requireRole(request, 'admin')

    expect(result).toEqual({ error: 'Authentication required', status: 401 })
  })

  it('accepts the configured proxy identity with the matching attestation secret', async () => {
    const { requireRole } = await loadAuth()
    const request = new Request('http://localhost/api/auth/users', {
      headers: {
        'x-mc-proxy-secret': '0123456789abcdef0123456789abcdef',
        'x-user-email': 'admin',
      },
    })

    const result = requireRole(request, 'admin')

    expect(result.user?.username).toBe('admin')
    expect(result.user?.role).toBe('admin')
  })

  it('rejects a same-length but incorrect attestation secret', async () => {
    const { requireRole } = await loadAuth()
    const request = new Request('http://localhost/api/auth/users', {
      headers: {
        // Same length as the configured secret, so the length guard cannot
        // short-circuit and the constant-time comparison is what rejects it.
        'x-mc-proxy-secret': 'fedcba9876543210fedcba9876543210',
        'x-user-email': 'admin',
      },
    })

    const result = requireRole(request, 'admin')

    expect(result).toEqual({ error: 'Authentication required', status: 401 })
  })

  it('rejects an identity header presented with no attestation secret at all', async () => {
    const { requireRole } = await loadAuth()
    const request = new Request('http://localhost/api/auth/users', {
      headers: { 'x-user-email': 'admin' },
    })

    const result = requireRole(request, 'admin')

    expect(result).toEqual({ error: 'Authentication required', status: 401 })
  })

  it('records a rejection when a valid secret carries an identity that cannot be resolved', async () => {
    // The shape of a leaked-secret probe guessing usernames.
    const { requireRole, logSecurityEvent } = await loadAuth({ database: makeEmptyDatabase() })
    const request = new Request('http://localhost/api/auth/users', {
      headers: {
        'x-mc-proxy-secret': '0123456789abcdef0123456789abcdef',
        'x-user-email': 'nobody',
      },
    })

    const result = requireRole(request, 'admin')

    expect(result).toEqual({ error: 'Authentication required', status: 401 })
    expect(rejectionReasons(logSecurityEvent)).toContain(
      'attested identity did not resolve to an approved user',
    )
  })

  it('records a rejection when a valid secret carries no identity header', async () => {
    const { requireRole, logSecurityEvent } = await loadAuth()
    const request = new Request('http://localhost/api/auth/users', {
      headers: { 'x-mc-proxy-secret': '0123456789abcdef0123456789abcdef' },
    })

    const result = requireRole(request, 'admin')

    expect(result).toEqual({ error: 'Authentication required', status: 401 })
    expect(rejectionReasons(logSecurityEvent)).toContain(
      'attested request carried no identity header',
    )
  })

  it('treats an invalid configured header name as disabled instead of throwing', async () => {
    // Headers.get() throws a TypeError on a non-token name, and this runs before
    // every other authentication method, so a typo here would break session and
    // API-key auth for requests carrying no proxy headers at all.
    process.env.MC_PROXY_AUTH_HEADER = 'X User'
    const { getUserFromRequest } = await loadAuth({ database: makeEmptyDatabase() })

    expect(() => getUserFromRequest(new Request('http://localhost/api/x'))).not.toThrow()
    expect(getUserFromRequest(new Request('http://localhost/api/x'))).toBeNull()
  })

  it('refuses to use the attestation header as the identity header', async () => {
    // Both reads would return the secret, so with auto-provisioning this would
    // persist the credential as a username.
    process.env.MC_PROXY_AUTH_HEADER = 'X-MC-Proxy-Secret'
    process.env.MC_PROXY_AUTH_DEFAULT_ROLE = 'viewer'
    const { requireRole } = await loadAuth({ database: makeEmptyDatabase() })
    const request = new Request('http://localhost/api/auth/users', {
      headers: { 'x-mc-proxy-secret': '0123456789abcdef0123456789abcdef' },
    })

    const result = requireRole(request, 'admin')

    expect(result).toEqual({ error: 'Authentication required', status: 401 })
  })

  it('does not let mismatched-secret noise suppress the post-attestation signal', async () => {
    // A client with no secret can spray a public route. If that shared one reason
    // consumed a single global window, the event that indicates someone actually
    // holds the secret would be silently dropped.
    const { requireRole, logSecurityEvent } = await loadAuth({ database: makeEmptyDatabase() })
    const noise = new Request('http://localhost/api/auth/users', {
      headers: { 'x-mc-proxy-secret': 'wrong', 'x-user-email': 'admin' },
    })
    for (let i = 0; i < 5; i++) requireRole(noise, 'admin')

    requireRole(
      new Request('http://localhost/api/auth/users', {
        headers: {
          'x-mc-proxy-secret': '0123456789abcdef0123456789abcdef',
          'x-user-email': 'nobody',
        },
      }),
      'admin',
    )

    const reasons = rejectionReasons(logSecurityEvent)
    expect(reasons).toContain('attested identity did not resolve to an approved user')
    // The noise itself is still collapsed to one event.
    expect(reasons.filter((r) => r === 'proxy attestation secret mismatch')).toHaveLength(1)
  })

  it('fails closed when the secret is still the public .env.example placeholder', async () => {
    // 42 characters, so it clears the length rule while being published in the repo.
    const placeholder = 'replace-with-at-least-32-random-characters'
    process.env.MC_PROXY_AUTH_SECRET = placeholder
    const { requireRole } = await loadAuth()
    const request = new Request('http://localhost/api/auth/users', {
      headers: {
        'x-mc-proxy-secret': placeholder,
        'x-user-email': 'admin',
      },
    })

    const result = requireRole(request, 'admin')

    expect(result).toEqual({ error: 'Authentication required', status: 401 })
  })

  it('fails closed when proxy authentication is configured with a short secret', async () => {
    process.env.MC_PROXY_AUTH_SECRET = 'too-short'
    const { requireRole } = await loadAuth()
    const request = new Request('http://localhost/api/auth/users', {
      headers: {
        'x-mc-proxy-secret': 'too-short',
        'x-user-email': 'admin',
      },
    })

    const result = requireRole(request, 'admin')

    expect(result).toEqual({ error: 'Authentication required', status: 401 })
  })
})
