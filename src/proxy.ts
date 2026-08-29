import crypto from 'node:crypto'
import os from 'node:os'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { buildMissionControlCsp, buildNonceRequestHeaders } from '@/lib/csp'
import { hasValidProxyAttestation, safeCompare } from '@/lib/proxy-auth-config'
import { MC_SESSION_COOKIE_NAME, LEGACY_MC_SESSION_COOKIE_NAME } from '@/lib/session-cookie'

function envFlag(name: string): boolean {
  const raw = process.env[name]
  if (raw === undefined) return false
  const v = String(raw).trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

function normalizeHostname(raw: string): string {
  const value = raw.trim().toLowerCase()
  if (!value) return ''

  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']')
    if (closingBracket <= 1) return ''
    return value.slice(1, closingBracket).replace(/\.$/, '')
  }

  const colonCount = (value.match(/:/g) || []).length
  const hostname = colonCount === 1 ? value.slice(0, value.lastIndexOf(':')) : value
  return hostname.replace(/\.$/, '')
}

function parseForwardedHost(forwarded: string | null): string[] {
  if (!forwarded) return []
  const hosts: string[] = []
  for (const part of forwarded.split(',')) {
    const match = /(?:^|;)\s*host="?([^";]+)"?/i.exec(part)
    if (match?.[1]) hosts.push(match[1])
  }
  return hosts
}

function getRequestHostCandidates(request: NextRequest): string[] {
  const rawCandidates = [
    ...(request.headers.get('x-forwarded-host') || '').split(','),
    ...(request.headers.get('x-original-host') || '').split(','),
    ...(request.headers.get('x-forwarded-server') || '').split(','),
    ...parseForwardedHost(request.headers.get('forwarded')),
    request.headers.get('host') || '',
    request.nextUrl.host || '',
    request.nextUrl.hostname || '',
  ]

  const candidates = rawCandidates
    .map(normalizeHostname)
    .filter(Boolean)

  return [...new Set(candidates)]
}

function getImplicitAllowedHosts(): string[] {
  const candidates = [
    'localhost',
    '127.0.0.1',
    '::1',
    normalizeHostname(os.hostname()),
  ].filter(Boolean)

  return [...new Set(candidates)]
}

function hostMatches(pattern: string, hostname: string): boolean {
  const p = normalizeHostname(pattern)
  const h = normalizeHostname(hostname)
  if (!p || !h) return false

  // "*.example.com" matches "a.example.com" (but not bare "example.com")
  if (p.startsWith('*.')) {
    const suffix = p.slice(2)
    return h.endsWith(`.${suffix}`)
  }

  // "100.*" matches "100.64.0.1"
  if (p.endsWith('.*')) {
    const prefix = p.slice(0, -1)
    return h.startsWith(prefix)
  }

  return h === p
}

/** Normalize a host:port string by stripping default ports (80 for http, 443 for https). */
function stripDefaultPort(host: string): string {
  const h = host.toLowerCase()
  if (h.endsWith(':443')) return h.slice(0, -4)
  if (h.endsWith(':80')) return h.slice(0, -3)
  return h
}

/**
 * Compare a request host candidate with the Origin host for CSRF validation.
 * Handles port mismatches caused by reverse proxies (e.g. Origin includes :8443
 * but the Host header may have been rewritten or stripped by the proxy).
 */
function hostsMatchForCsrf(requestHost: string, originHost: string): boolean {
  const a = normalizeHostname(requestHost)
  const b = normalizeHostname(originHost)
  if (!a || !b) return false
  // Exact match first
  if (a === b) return true
  // Match after stripping default ports
  return stripDefaultPort(a) === stripDefaultPort(b)
}

function nextResponseWithNonce(request: NextRequest): { response: NextResponse; nonce: string } {
  const nonce = crypto.randomBytes(16).toString('base64')
  const googleEnabled = !!(process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID)
  const requestHeaders = buildNonceRequestHeaders({
    headers: request.headers,
    nonce,
    googleEnabled,
  })
  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  })
  // Debug log retained (commented) for future CSP/nonce flow troubleshooting.
  // console.log(`[DEBUG csp] proxy generated nonce for ${request.nextUrl.pathname}: ${nonce.slice(0, 8)}...`)
  return { response, nonce }
}

function addSecurityHeaders(response: NextResponse, _request: NextRequest, nonce?: string): NextResponse {
  const requestId = crypto.randomUUID()
  response.headers.set('X-Request-Id', requestId)
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('X-Frame-Options', 'DENY')
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')

  const googleEnabled = !!(process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID)
  const effectiveNonce = nonce || crypto.randomBytes(16).toString('base64')
  response.headers.set('Content-Security-Policy', buildMissionControlCsp({ nonce: effectiveNonce, googleEnabled }))

  return response
}

function extractApiKeyFromRequest(request: NextRequest): string {
  const direct = (request.headers.get('x-api-key') || '').trim()
  if (direct) return direct

  const authorization = (request.headers.get('authorization') || '').trim()
  if (!authorization) return ''

  const [scheme, ...rest] = authorization.split(/\s+/)
  if (!scheme || rest.length === 0) return ''
  const normalized = scheme.toLowerCase()
  if (normalized === 'bearer' || normalized === 'apikey' || normalized === 'token') {
    return rest.join(' ').trim()
  }
  return ''
}

export function proxy(request: NextRequest) {
  // Network access control.
  // In production: default-deny unless explicitly allowed.
  // In dev/test: allow all hosts unless overridden.
  const requestHosts = getRequestHostCandidates(request)
  const allowAnyHost = envFlag('MC_ALLOW_ANY_HOST') || process.env.NODE_ENV !== 'production'
  const allowedPatterns = String(process.env.MC_ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const implicitAllowedHosts = getImplicitAllowedHosts()

  const isAllowedHost = allowAnyHost
    || requestHosts.length > 0 && requestHosts.every((hostName) =>
      implicitAllowedHosts.some((candidate) => hostMatches(candidate, hostName))
      || allowedPatterns.some((pattern) => hostMatches(pattern, hostName))
    )

  if (!isAllowedHost) {
    return addSecurityHeaders(new NextResponse('Forbidden', { status: 403 }), request)
  }

  const { pathname } = request.nextUrl
  const publicReadOnlyPatterns = String(
    process.env.MC_LUGOS_PUBLIC_READ_ONLY_HOSTS || '',
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const isPublicReadOnlyOrigin = publicReadOnlyPatterns.length > 0
    && requestHosts.some((hostName) =>
      publicReadOnlyPatterns.some((pattern) => hostMatches(pattern, hostName))
    )

  const remoteDecisionPatterns = String(
    process.env.MC_LUGOS_REMOTE_DECISION_HOSTS || '',
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const isRemoteDecisionOrigin = remoteDecisionPatterns.length > 0
    && requestHosts.some((hostName) =>
      remoteDecisionPatterns.some((pattern) => hostMatches(pattern, hostName))
    )
  const isRemoteDecisionPath = pathname === '/api/lugos/remote-decisions'
    || pathname.startsWith('/api/lugos/remote-decisions/')
  const isLugosMutation = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(
    request.method.toUpperCase(),
  ) && pathname.startsWith('/api/lugos/')

  if (isPublicReadOnlyOrigin
    && isLugosMutation
    && !(isRemoteDecisionOrigin && isRemoteDecisionPath)) {
    return addSecurityHeaders(
      NextResponse.json(
        { error: 'Lugos commands are disabled on the public origin' },
        { status: 403 },
      ),
      request,
    )
  }

  // CSRF Origin validation for mutating requests
  const method = request.method.toUpperCase()
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    const origin = request.headers.get('origin')
    if (origin) {
      let originHost: string
      try { originHost = new URL(origin).host } catch { originHost = '' }
      if (originHost && !requestHosts.some((h) => hostsMatchForCsrf(h, originHost))) {
        return addSecurityHeaders(NextResponse.json({ error: 'CSRF origin mismatch' }, { status: 403 }), request)
      }
    }
  }

  // Allow login, setup, auth API, docs, and container health probes without session
  const isPublicHealthProbe = pathname === '/api/status' && request.nextUrl.searchParams.get('action') === 'health'
  // Exact-match only (no prefix/wildcard) so this exempts just the two health routes.
  const isPublicHealthRoute = pathname === '/api/health' || pathname === '/health'
  if (pathname === '/login' || pathname === '/setup' || pathname.startsWith('/api/auth/') || pathname === '/api/setup' || pathname === '/api/docs' || pathname === '/docs' || isPublicHealthProbe || isPublicHealthRoute) {
    const { response, nonce } = nextResponseWithNonce(request)
    return addSecurityHeaders(response, request, nonce)
  }

  // Check for session cookie
  const sessionToken = request.cookies.get(MC_SESSION_COOKIE_NAME)?.value || request.cookies.get(LEGACY_MC_SESSION_COOKIE_NAME)?.value

  // A request carrying the gateway's attestation secret is admitted here so it
  // can reach route auth, which is the only layer that can resolve the identity
  // header against the database. Without this the documented header-auth flow
  // does not work at all: attested requests were answered 401 on /api/* and
  // redirected to /login on page routes, before proxy auth was ever consulted.
  //
  // This admits, it does not authenticate. Route auth resolves the identity
  // header against the database and returns that user when it can.
  //
  // When it cannot — the header is absent, or names someone unknown or
  // unapproved — route auth does not stop there: it falls through to the session
  // cookie and API key. So an attested request naming nobody is refused only if
  // it carries no other credential; one that also has a valid cookie
  // authenticates as that cookie's owner. Admission here does not narrow that,
  // but it is a hybrid rather than "the gateway decides"; see the precedence
  // note in lib/auth.ts.
  const proxyAttested = hasValidProxyAttestation(request.headers)

  // API routes: accept session cookie OR API key
  if (pathname.startsWith('/api/')) {
    const configuredApiKey = (process.env.API_KEY || '').trim()
    const apiKey = extractApiKeyFromRequest(request)
    const hasValidApiKey = Boolean(configuredApiKey && apiKey && safeCompare(apiKey, configuredApiKey))

    // DB-backed keys (dashboard-rotated `mc_` global keys and `mca_` agent
    // keys) are validated in route auth — the edge runtime cannot query
    // SQLite, so the proxy only shape-checks them and lets route auth decide.
    // Both formats are exactly 48 hex chars after the prefix.
    const looksLikeDbBackedApiKey = /^mca?_[a-f0-9]{48}$/i.test(apiKey)

    if (sessionToken || hasValidApiKey || looksLikeDbBackedApiKey || proxyAttested) {
      const { response, nonce } = nextResponseWithNonce(request)
      return addSecurityHeaders(response, request, nonce)
    }

    return addSecurityHeaders(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }), request)
  }

  // Page routes: redirect to login if no session
  if (sessionToken || proxyAttested) {
    const { response, nonce } = nextResponseWithNonce(request)
    return addSecurityHeaders(response, request, nonce)
  }

  // Redirect to login
  const loginUrl = request.nextUrl.clone()
  loginUrl.pathname = '/login'
  return addSecurityHeaders(NextResponse.redirect(loginUrl), request)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|brand/).*)']
}
