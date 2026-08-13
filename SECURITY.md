# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Mission Control, please report it responsibly.

**Do not open a public issue.** Instead, email security@builderz.dev with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and aim to provide a fix or mitigation within 7 days for critical issues.

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest `main` | Yes |
| older releases | Best effort |

## Security Considerations

Mission Control handles authentication credentials and API keys. When deploying:

- Always set strong values for `AUTH_PASS` and `API_KEY`.
- Set `MC_ALLOWED_HOSTS` in production. Host checking fails closed, so anything
  beyond `localhost`, `127.0.0.1`, `::1`, and the machine hostname is answered
  with `403 Forbidden` until it is listed here.
- If you enable header-based proxy authentication, configure the reverse proxy
  to strip client-supplied headers first — see [Trusted reverse proxy
  authentication](#trusted-reverse-proxy-authentication) below.
- Keep `.env` files out of version control (already in `.gitignore`).
- Enable `MC_COOKIE_SECURE=1` when serving over HTTPS.
- Review the [Environment Variables](README.md#environment-variables) section for all security-relevant configuration.

## Hardening Checklist

Run `bash scripts/security-audit.sh` to check your deployment automatically.

### Credentials
- [ ] `AUTH_PASS` is a strong, unique password (12+ characters)
- [ ] `API_KEY` is a random hex string (not the default)
- [ ] `AUTH_SECRET` is a random string
- [ ] `.env` file permissions are `600` (owner read/write only)

### Network
- [ ] `MC_ALLOWED_HOSTS` is configured (not `MC_ALLOW_ANY_HOST=1`)
- [ ] Dashboard is behind a reverse proxy with TLS (Caddy, nginx, Tailscale)
- [ ] If `MC_PROXY_AUTH_HEADER` is set: `MC_PROXY_AUTH_SECRET` is 32+ characters
- [ ] If `MC_PROXY_AUTH_HEADER` is set: the proxy strips client-supplied
      identity and `X-MC-Proxy-Secret` headers before injecting its own
- [ ] If `MC_PROXY_AUTH_HEADER` is set: the app is not reachable except through
      that proxy (bound to loopback or an internal network)
- [ ] `MC_ENABLE_HSTS=1` is set for HTTPS deployments
- [ ] `MC_COOKIE_SECURE=1` is set for HTTPS deployments
- [ ] `MC_COOKIE_SAMESITE=strict`

### Docker (if applicable)
- [ ] Use the hardened compose overlay: `docker compose -f docker-compose.yml -f docker-compose.hardened.yml up`
- [ ] Container runs as non-root user (default: `nextjs`, UID 1001)
- [ ] Read-only filesystem with tmpfs for temp dirs
- [ ] All Linux capabilities dropped except `NET_BIND_SERVICE`
- [ ] `no-new-privileges` security option enabled
- [ ] Log rotation configured (max-size, max-file)

### OpenClaw Gateway
- [ ] Gateway bound to localhost (`OPENCLAW_GATEWAY_HOST=127.0.0.1`)
- [ ] Gateway token configured (`OPENCLAW_GATEWAY_TOKEN`)
- [ ] Gateway token NOT exposed via `NEXT_PUBLIC_*` variables

### Monitoring
- [ ] Rate limiting is active (`MC_DISABLE_RATE_LIMIT` is NOT set)
- [ ] Audit logging is enabled with appropriate retention
- [ ] Regular database backups configured

## Trusted reverse proxy authentication

`MC_PROXY_AUTH_HEADER` lets a gateway that has already authenticated the user
pass that identity to Mission Control as an HTTP header. The only credential
Mission Control checks is `MC_PROXY_AUTH_SECRET` — 32+ random characters that
the gateway injects as `X-MC-Proxy-Secret`, compared in constant time. It must
not be the `.env.example` placeholder, which is public. A missing, shorter, or
placeholder secret disables proxy auth entirely and records a
`proxy_auth_misconfigured` critical event on the first request; requests that
present proxy headers which fail any later check are recorded as
`proxy_auth_rejected`.

The edge middleware admits a request carrying a valid `X-MC-Proxy-Secret` so it
can reach route auth, which is the only layer able to resolve the identity
header against the database. That covers both page routes and `/api/*`, so an
attested user reaches the dashboard without the login form.

There is no second factor behind that secret — the middleware cannot query the
database from the edge runtime, so its API-key check is a shape check only.
**Treat a leaked proxy secret as full compromise of the application**, not of
part of it.

The gateway's identity also does not always win. When the header names someone
unknown or unapproved, route auth falls through to the session cookie and API
key rather than refusing, so **revoking a user upstream does not by itself
revoke their access here** — a Mission Control session that has not expired will
still authenticate them as their old account.

Unapproving the account is not sufficient either: `validateSession` does not
check approval, so a live session survives it.

**Unapproving an account is not revocation, and there is no supported way to end
another user's sessions on its own.** `destroyAllUserSessions` is reachable from
exactly two places: the user's own password change, and `deleteUser`. No admin
route or UI action ends someone else's session, so an unapproved account keeps
working until its session expires or the account is deleted.

**To revoke a user today, delete the account.** `deleteUser` destroys their
sessions before removing the row, which makes deletion the most complete
revocation available. Before deleting, confirm `MC_PROXY_AUTH_DEFAULT_ROLE` is
unset or the gateway no longer asserts that identity — otherwise the next
attested request finds no row and auto-provisions a fresh approved account with
that role, re-granting the access you just removed. If the user knew the global
`API_KEY`, rotate it too; it is not per-user and deletion does not affect it.

**Deletion is still not complete.** Every mutation route authenticates at the
top of the handler and only then awaits the request body, so a request begun
before the deletion carries an authorization decision that deletion cannot
cancel. At least nine such routes grant access that outlives the revocation —
a new approved admin, a new session, an approved access request, an agent API
key, the rotated global `API_KEY`, a webhook pointed at an attacker's URL, a
regenerated gateway token, or users moved between workspaces.

One escapes the application altogether: on a deployment where the Mission
Control process has passwordless sudo for `useradd`, `POST /api/super/os-users`
creates a **host OS account** with a password from the request body. Nothing
done inside Mission Control revokes that.

Treat revocation as effective only once in-flight requests have drained. Check
the audit log around it for user creation, access-request approvals, key and
webhook issuance, and — on super-admin deployments — the host's account list.

Known gaps, which are why the above is a workaround rather than a procedure:

- Unapproval blocks *new* logins (local login and the proxy path both refuse an
  unapproved user) but leaves existing sessions valid, and there is no way to
  clear them short of deletion.
- While an unapproved admin still holds a live session, role-only checks on the
  admin routes continue to pass. They can create another approved admin account,
  which survives any action taken against the original.

Both need an atomic revocation operation rather than documentation. See
[docs/deployment.md](docs/deployment.md#trusted-reverse-proxy-authentication).

Because that secret is the whole of the authentication, two deployment
controls carry the rest of the weight:

1. **The gateway must strip the client's own copy of both headers on every
   route** before injecting its own — whatever `MC_PROXY_AUTH_HEADER` names
   (e.g. `X-User-Email`) so a client cannot choose its identity, and
   `X-MC-Proxy-Secret` so a client cannot replay a leaked secret.
2. **The app must not be reachable except through that gateway.** Anyone who
   can open a connection directly and present the secret is any user they name,
   from anywhere. Every bundled launch path binds to all interfaces by default,
   so this needs an explicit change — an IP-qualified Compose mapping such as
   `127.0.0.1:${MC_PORT}:${PORT}`, or `MC_HOSTNAME=127.0.0.1` for the
   standalone scripts. Setting `MC_PORT` alone does not do it; it is only a
   port number. See
   [docs/deployment.md](docs/deployment.md#trusted-reverse-proxy-authentication)
   for the per-launch-path table.

There is deliberately no trusted-IP check. `X-Forwarded-For` records the
address each proxy saw as *its* peer, so it never contains the address of the
proxy that connected to the app, and no transport peer is available to compare
against; any "trusted hop" header would just be the shared secret again with
less entropy. Restricting where connections can originate is a network control,
not an application one — hence requirement 2.

Setting `MC_PROXY_AUTH_DEFAULT_ROLE` additionally auto-provisions accounts for
unknown identities — leave it unset unless that is what you want.

See [docs/deployment.md](docs/deployment.md#trusted-reverse-proxy-authentication)
for the full configuration reference.

See [docs/SECURITY-HARDENING.md](docs/SECURITY-HARDENING.md) for the full hardening guide.
