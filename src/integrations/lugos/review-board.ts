import { randomBytes } from 'node:crypto'
import { hashSessionToken, lookupSessionHash } from '@/lib/auth'
import { parseMcSessionCookieHeader } from '@/lib/session-cookie'
import { reportOwner } from './web-reports'

type Grant = { sessionHash: string; owner: string; expires: number }
const state = globalThis as typeof globalThis & { weirReviewGrants?: Map<string, Grant> }
const grants = (state.weirReviewGrants ??= new Map<string, Grant>())

function sessionHash(request: Request) {
  const token = parseMcSessionCookieHeader(request.headers.get('cookie') || '')
  return token ? hashSessionToken(token) : null
}

export function reviewViewer(request: Request) {
  const digest = sessionHash(request)
  const user = digest ? lookupSessionHash(digest) : null
  return user && reportOwner(user) ? user : null
}

function operator(digest: string, owner: string) {
  const user = lookupSessionHash(digest)
  return user && ['operator', 'admin'].includes(user.role) && reportOwner(user) === owner ? user : null
}

export function issueReviewGrant(request: Request, owner: string) {
  const digest = sessionHash(request)
  if (!digest || !operator(digest, owner)) return null
  const now = Date.now()
  for (const [token, grant] of grants) if (grant.expires <= now) grants.delete(token)
  if (grants.size >= 512) return null
  const token = randomBytes(32).toString('hex')
  grants.set(token, { sessionHash: digest, owner, expires: now + 90_000 })
  return token
}

export function revokeReviewGrant(token: string) {
  grants.delete(token)
}

export function redeemReviewGrant(token: string, owner: string | null) {
  const grant = grants.get(token)
  grants.delete(token)
  if (!grant || grant.owner !== owner || grant.expires <= Date.now()) return null
  return operator(grant.sessionHash, grant.owner)
}
