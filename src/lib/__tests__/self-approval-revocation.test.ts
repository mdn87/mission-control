import { describe, expect, it, vi } from 'vitest'

/**
 * Revoking a user takes two steps — unapprove, then destroy their sessions —
 * and `validateSession` does not check approval, so between those steps the
 * user still holds a fully authorized session. If they can re-approve
 * themselves in that window, the procedure documented in SECURITY.md does not
 * revoke anything.
 */
async function loadRoute(currentUser: Record<string, unknown>) {
  vi.resetModules()
  const updateUser = vi.fn((_id: number, updates: Record<string, unknown>) => ({
    id: 9, username: 'revoked-user', ...updates,
  }))
  vi.doMock('@/lib/auth', () => ({
    getUserFromRequest: vi.fn(() => currentUser),
    getUserById: vi.fn(() => ({ id: 9, username: 'revoked-user', workspace_id: 1, is_approved: 0 })),
    updateUser,
    getAllUsers: vi.fn(() => []),
    createUser: vi.fn(),
    deleteUser: vi.fn(),
    requireRole: vi.fn(() => ({ user: currentUser })),
  }))
  vi.doMock('@/lib/db', () => ({ logAuditEvent: vi.fn() }))
  vi.doMock('@/lib/rate-limit', () => ({ identitySecurityMutationLimiter: vi.fn(() => null) }))
  vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
  vi.doMock('@/lib/validation', () => ({ validateBody: vi.fn(), createUserSchema: {} }))
  const route = await import('@/app/api/auth/users/route')
  return { route, updateUser }
}

function putRequest(body: unknown) {
  return { json: async () => body, headers: new Headers() } as never
}

describe('a user cannot approve themselves', () => {
  const revokedAdmin = {
    id: 9, username: 'revoked-user', role: 'admin', workspace_id: 1, tenant_id: 1,
    is_approved: 0,
  }

  it('refuses an unapproved admin restoring their own approval', async () => {
    const { route, updateUser } = await loadRoute(revokedAdmin)

    const response = await route.PUT(putRequest({ id: 9, is_approved: 1 }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({
      error: 'Cannot change your own approval',
    })
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('still allows an ordinary self-edit that resends the unchanged value', async () => {
    // The dashboard sends the whole user object back; a no-op must not 400.
    const { route, updateUser } = await loadRoute(revokedAdmin)

    const response = await route.PUT(putRequest({ id: 9, is_approved: 0, display_name: 'New Name' }))

    expect(response.status).not.toBe(400)
    expect(updateUser).toHaveBeenCalled()
  })

  it('refuses when the request began before the operator unapproved the account', async () => {
    // The authenticated snapshot is taken before `await request.json()`, so a
    // request started while still approved carries is_approved 1. Comparing
    // against that snapshot would read 1 -> 1 as unchanged and let the update
    // through, reapproving the account after the operator unapproved it. The
    // comparison is against the row read after parsing, so this is refused.
    const stillApprovedSnapshot = { ...revokedAdmin, is_approved: 1 }
    const { route, updateUser } = await loadRoute(stillApprovedSnapshot)

    const response = await route.PUT(putRequest({ id: 9, is_approved: 1 }))

    expect(response.status).toBe(400)
    expect(updateUser).not.toHaveBeenCalled()
  })

  it('still allows an admin to approve someone else', async () => {
    const approver = { ...revokedAdmin, id: 1, username: 'admin', is_approved: 1 }
    const { route, updateUser } = await loadRoute(approver)

    const response = await route.PUT(putRequest({ id: 9, is_approved: 1 }))

    expect(response.status).not.toBe(400)
    expect(updateUser).toHaveBeenCalledWith(9, expect.objectContaining({ is_approved: 1 }))
  })
})

describe('a user cannot approve their own access request', () => {
  async function loadApprovalRoute(admin: Record<string, unknown>, reqEmail: string, resolvesToId: number | null) {
    vi.resetModules()
    const run = vi.fn()
    vi.doMock('@/lib/auth', () => ({
      getUserFromRequest: vi.fn(() => admin),
      createUser: vi.fn(() => ({ id: 42, username: 'someone-else', role: 'admin' })),
      requireRole: vi.fn(() => ({ user: admin })),
    }))
    vi.doMock('@/lib/db', () => ({
      getDatabase: vi.fn(() => ({
        prepare: vi.fn((sql: string) => ({
          get: vi.fn(() => {
            if (sql.includes('FROM access_requests')) return { id: 1, email: reqEmail, status: 'pending' }
            // The guard's own lookup: email OR provider identity.
            if (sql.includes('provider_user_id = ?')) return resolvesToId ? { id: resolvesToId } : undefined
            return undefined
          }),
          run,
        })),
        transaction: vi.fn((fn: () => unknown) => fn),
      })),
      logAuditEvent: vi.fn(),
    }))
    vi.doMock('@/lib/rate-limit', () => ({ identitySecurityMutationLimiter: vi.fn(() => null) }))
    vi.doMock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))
    vi.doMock('@/lib/validation', () => ({
      validateBody: vi.fn(async () => ({ data: { request_id: 1, action: 'approve', role: 'admin' } })),
      accessRequestActionSchema: {},
    }))
    const route = await import('@/app/api/auth/access-requests/route')
    return { route, run }
  }

  const revokedAdmin = {
    id: 9, username: 'revoked-user', role: 'admin', email: 'revoked@example.com',
    workspace_id: 1, tenant_id: 1, is_approved: 0,
  }

  it('refuses when the request resolves to the acting admin by email', async () => {
    // The bypass: an unapproved admin fails a Google login to create a pending
    // request, then approves it, which sets is_approved = 1 without ever going
    // through the guard on PUT /api/auth/users.
    const { route, run } = await loadApprovalRoute(revokedAdmin, 'revoked@example.com', 9)

    const response = await route.POST({ json: async () => ({}), headers: new Headers() } as never)

    expect(response.status).toBe(400)
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses when only the provider identity resolves to the acting admin', async () => {
    // The bypass an email-only guard missed: the admin's email changed, so the
    // request carries a different address, but the stable provider_user_id still
    // resolves to their existing row and the approval would reapprove it.
    const { route, run } = await loadApprovalRoute(revokedAdmin, 'new-address@example.com', 9)

    const response = await route.POST({ json: async () => ({}), headers: new Headers() } as never)

    expect(response.status).toBe(400)
    expect(run).not.toHaveBeenCalled()
  })

  it('still allows approving a request for someone else', async () => {
    const { route } = await loadApprovalRoute(revokedAdmin, 'someone-else@example.com', 42)

    const response = await route.POST({ json: async () => ({}), headers: new Headers() } as never)

    expect(response.status).not.toBe(400)
  })
})
