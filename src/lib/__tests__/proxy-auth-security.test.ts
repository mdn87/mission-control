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

async function loadAuth() {
  const database = makeAdminDatabase()
  vi.doMock('@/lib/db', () => ({
    getDatabase: vi.fn(() => database),
  }))
  vi.doMock('@/lib/security-events', () => ({
    logSecurityEvent: vi.fn(),
  }))
  vi.doMock('@/lib/password', () => ({
    hashPassword: vi.fn((value: string) => `hashed:${value}`),
    verifyPassword: vi.fn(() => false),
    verifyPasswordWithRehashCheck: vi.fn(() => ({ valid: false, needsRehash: false })),
  }))
  return import('@/lib/auth')
}

describe('trusted proxy header authentication', () => {
  beforeEach(() => {
    vi.resetModules()
    process.env = {
      ...originalEnv,
      MC_PROXY_AUTH_HEADER: 'X-User-Email',
      MC_PROXY_AUTH_TRUSTED_IPS: '127.0.0.1',
      MC_PROXY_AUTH_SECRET: '0123456789abcdef0123456789abcdef',
    }
    delete process.env.API_KEY
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('rejects a spoofed trusted IP and admin identity without proxy attestation', async () => {
    const { requireRole } = await loadAuth()
    const request = new Request('http://localhost/api/auth/users', {
      headers: {
        'x-real-ip': '127.0.0.1',
        'x-user-email': 'admin',
      },
    })

    const result = requireRole(request, 'admin')

    expect(result).toEqual({ error: 'Authentication required', status: 401 })
  })

  it('accepts the configured proxy identity only with the matching attestation secret', async () => {
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
