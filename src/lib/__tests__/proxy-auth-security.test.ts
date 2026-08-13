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


/**
 * A database where the session cookie resolves to one user and the proxy
 * identity lookup resolves to another (or nobody), so the two paths are
 * distinguishable in the result.
 */
function makeSplitDatabase(options: { proxyUser?: string | null } = {}) {
  const base = {
    display_name: 'X', role: 'admin' as const, workspace_id: 1, tenant_id: 1,
    provider: 'local', email: null, avatar_url: null, is_approved: 1,
    created_at: 1, updated_at: 1, last_login_at: null,
  }
  const cookieUser = { ...base, id: 3, username: 'cookie-user', session_id: 1 }
  const proxyUser = options.proxyUser ? { ...base, id: 4, username: options.proxyUser } : undefined

  return {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => {
        if (sql.includes('FROM user_sessions')) return cookieUser
        if (sql.includes('FROM workspaces')) return { id: 1, tenant_id: 1 }
        if (sql.includes('FROM users u')) return proxyUser
        return undefined
      }),
      run: vi.fn(),
    })),
  }
}

async function loadAuth(options: { database?: unknown; passwordValid?: boolean } = {}) {
  const database = options.database ?? makeAdminDatabase()
  const logSecurityEvent = vi.fn()
  // Defaults to an always-failing verifier. A test asserting that some *other*
  // gate rejects a login must pass passwordValid: true, or the password branch
  // rejects first and the assertion proves nothing.
  const passwordValid = options.passwordValid ?? false
  vi.doMock('@/lib/db', () => ({
    getDatabase: vi.fn(() => database),
  }))
  vi.doMock('@/lib/security-events', () => ({ logSecurityEvent }))
  vi.doMock('@/lib/password', () => ({
    hashPassword: vi.fn((value: string) => `hashed:${value}`),
    verifyPassword: vi.fn(() => passwordValid),
    verifyPasswordWithRehashCheck: vi.fn(() => ({ valid: passwordValid, needsRehash: false })),
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
  // The precedence contract, asserted rather than described. Every one of these
  // corresponds to a sentence in the comment above getUserFromRequest; three
  // earlier attempts at stating it in prose were wrong.
  describe('precedence between proxy identity and the session cookie', () => {
    const SECRET = '0123456789abcdef0123456789abcdef'
    const COOKIE = `${'__Host-mc-session'}=sometoken`

    it('a resolvable proxy identity wins over a session cookie', async () => {
      const { getUserFromRequest } = await loadAuth({
        database: makeSplitDatabase({ proxyUser: 'gateway-user' }),
      })
      const user = getUserFromRequest(new Request('http://localhost/api/x', {
        headers: { 'x-mc-proxy-secret': SECRET, 'x-user-email': 'gateway-user', cookie: COOKIE },
      }))
      expect(user?.username).toBe('gateway-user')
    })

    it('an unresolvable proxy identity falls through to the cookie', async () => {
      // The hybrid: the gateway named someone we cannot resolve, and the request
      // is still authenticated — as the cookie's owner, not the named identity.
      const { getUserFromRequest } = await loadAuth({
        database: makeSplitDatabase({ proxyUser: null }),
      })
      const user = getUserFromRequest(new Request('http://localhost/api/x', {
        headers: { 'x-mc-proxy-secret': SECRET, 'x-user-email': 'ghost', cookie: COOKIE },
      }))
      expect(user?.username).toBe('cookie-user')
    })

    it('an unresolvable proxy identity with no other credential resolves to nobody', async () => {
      const { getUserFromRequest } = await loadAuth({ database: makeEmptyDatabase() })
      const user = getUserFromRequest(new Request('http://localhost/api/x', {
        headers: { 'x-mc-proxy-secret': SECRET, 'x-user-email': 'ghost' },
      }))
      expect(user).toBeNull()
    })

    it('the cookie is used normally when proxy auth is not configured', async () => {
      delete process.env.MC_PROXY_AUTH_HEADER
      const { getUserFromRequest } = await loadAuth({
        database: makeSplitDatabase({ proxyUser: 'gateway-user' }),
      })
      const user = getUserFromRequest(new Request('http://localhost/api/x', {
        headers: { 'x-mc-proxy-secret': SECRET, 'x-user-email': 'gateway-user', cookie: COOKIE },
      }))
      expect(user?.username).toBe('cookie-user')
    })
    it('a live session survives the account being unapproved', async () => {
      // The revocation guidance in SECURITY.md and docs/deployment.md rests on
      // this: validateSession selects is_approved but does not gate on it, so
      // unapproving an account is not sufficient to remove access. If this ever
      // starts failing, that guidance needs rewriting, not this test.
      const unapproved = {
        id: 9, username: 'revoked-user', display_name: 'X', role: 'admin' as const,
        provider: 'local', email: null, avatar_url: null,
        is_approved: 0,
        workspace_id: 1, tenant_id: 1,
        created_at: 1, updated_at: 1, last_login_at: null, session_id: 1,
      }
      const { validateSession } = await loadAuth({
        database: {
          prepare: vi.fn((sql: string) => ({
            get: vi.fn(() => (sql.includes('FROM user_sessions') ? unapproved
              : sql.includes('FROM workspaces') ? { id: 1, tenant_id: 1 } : undefined)),
            run: vi.fn(),
          })),
        },
      })

      expect(validateSession('sometoken')?.username).toBe('revoked-user')
    })
    it('login refuses an unapproved user, which is why unapproval must come first', async () => {
      // The revocation order in SECURITY.md depends on this asymmetry:
      // authenticateUser gates on is_approved, validateSession does not. So
      // unapproving blocks new credentials while leaving existing ones alive,
      // and the sessions must be destroyed after it rather than before.
      const row = {
        id: 9, username: 'revoked-user', display_name: 'X', role: 'admin' as const,
        provider: 'local', email: null, avatar_url: null,
        is_approved: 0, workspace_id: 1, tenant_id: 1,
        created_at: 1, updated_at: 1, last_login_at: null,
        password_hash: 'hashed:pw',
      }
      // passwordValid: true is load-bearing. With the default failing verifier
      // this assertion would hold even if the approval gate were deleted, since
      // the password branch would reject first.
      const { authenticateUser } = await loadAuth({
        passwordValid: true,
        database: {
          prepare: vi.fn((sql: string) => ({
            get: vi.fn(() => (sql.includes('FROM workspaces') ? { id: 1, tenant_id: 1 } : row)),
            run: vi.fn(),
          })),
        },
      })

      expect(authenticateUser('revoked-user', 'pw')).toBeNull()
    })
  })
})
