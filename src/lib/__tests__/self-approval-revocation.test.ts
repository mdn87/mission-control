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

  it('still allows an admin to approve someone else', async () => {
    const approver = { ...revokedAdmin, id: 1, username: 'admin', is_approved: 1 }
    const { route, updateUser } = await loadRoute(approver)

    const response = await route.PUT(putRequest({ id: 9, is_approved: 1 }))

    expect(response.status).not.toBe(400)
    expect(updateUser).toHaveBeenCalledWith(9, expect.objectContaining({ is_approved: 1 }))
  })
})
