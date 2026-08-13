/**
 * Configuration and attestation checks for header-based proxy authentication.
 *
 * Deliberately free of database, logging, and Next.js imports so the middleware
 * — which runs in the edge runtime and cannot reach SQLite — applies exactly the
 * rules route auth applies. Two implementations of these checks would drift, and
 * `security-audit.sh` already demonstrated that failure twice by reimplementing
 * `load-env.sh`'s parsing instead of sharing it.
 */

import { timingSafeEqual } from 'node:crypto'

/** Header the trusted gateway injects to attest that it, not a client, sent this. */
export const PROXY_AUTH_SECRET_HEADER = 'x-mc-proxy-secret'

export const MIN_PROXY_AUTH_SECRET_LENGTH = 32

/**
 * Values shipped in .env.example. They satisfy the length rule but are public,
 * so treating them as configured would hand the secret to anyone reading the repo.
 */
export const INSECURE_PROXY_AUTH_SECRETS = new Set([
  'replace-with-at-least-32-random-characters',
])

/**
 * RFC 7230 token. `Headers.get()` throws a TypeError on anything else, and proxy
 * auth is evaluated before every other authentication method, so an invalid
 * configured name would take session and API-key auth down with it.
 */
const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export type ProxyAuthConfig =
  | { status: 'disabled' }
  | { status: 'misconfigured'; reason: string }
  | { status: 'enabled'; identityHeader: string; secret: string }

/** Constant-time string comparison. */
export function safeCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) {
    // Compare against a dummy buffer so a length mismatch costs the same time.
    timingSafeEqual(bufA, Buffer.alloc(bufA.length))
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

/**
 * Resolve proxy auth configuration from the environment.
 *
 * Every rejection reason is returned rather than thrown so callers can decide
 * whether to log it; `misconfigured` always means proxy auth is off, never that
 * a request should be treated as authenticated.
 */
export function readProxyAuthConfig(): ProxyAuthConfig {
  const identityHeader = (process.env.MC_PROXY_AUTH_HEADER || '').trim()
  if (!identityHeader) return { status: 'disabled' }

  const secret = process.env.MC_PROXY_AUTH_SECRET || ''

  if (!HTTP_HEADER_NAME.test(identityHeader)) {
    return {
      status: 'misconfigured',
      reason: 'MC_PROXY_AUTH_HEADER is not a valid HTTP header name — proxy auth disabled',
    }
  }
  if (identityHeader.toLowerCase() === PROXY_AUTH_SECRET_HEADER) {
    // Both reads would return the secret, so with auto-provisioning enabled the
    // first attested request would persist the credential as a username.
    return {
      status: 'misconfigured',
      reason: `MC_PROXY_AUTH_HEADER must not be ${PROXY_AUTH_SECRET_HEADER} — the identity and attestation headers must differ; proxy auth disabled`,
    }
  }
  if (secret.length < MIN_PROXY_AUTH_SECRET_LENGTH) {
    return {
      status: 'misconfigured',
      reason: `MC_PROXY_AUTH_HEADER is set but MC_PROXY_AUTH_SECRET is shorter than ${MIN_PROXY_AUTH_SECRET_LENGTH} characters — proxy auth disabled`,
    }
  }
  if (INSECURE_PROXY_AUTH_SECRETS.has(secret)) {
    return {
      status: 'misconfigured',
      reason: 'MC_PROXY_AUTH_SECRET is the placeholder from .env.example, which is public — proxy auth disabled',
    }
  }

  return { status: 'enabled', identityHeader, secret }
}

/**
 * Whether a request carries the gateway's attestation secret.
 *
 * This is only the "did the trusted gateway send this" half. It says nothing
 * about *who* the request claims to be — resolving the identity header to a real
 * approved user happens in route auth, which can reach the database.
 */
export function hasValidProxyAttestation(headers: Headers): boolean {
  const config = readProxyAuthConfig()
  if (config.status !== 'enabled') return false
  const presented = headers.get(PROXY_AUTH_SECRET_HEADER) || ''
  if (!presented) return false
  return safeCompare(presented, config.secret)
}
