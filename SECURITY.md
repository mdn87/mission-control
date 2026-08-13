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
route auth cannot resolve, it falls through to the session cookie and API key
rather than refusing, so **revoking a user upstream does not by itself revoke
their access here** — a Mission Control session that has not expired will still
authenticate them as their old account. An *unapproved* identity always falls
through this way; an unknown or renamed one does so only when
`MC_PROXY_AUTH_DEFAULT_ROLE` is unset, since otherwise it is auto-provisioned
into a new approved account instead.

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
that role, re-granting the access you just removed. The global `API_KEY` is not
per-user and deletion does not affect it, but **do not rotate it yet** — that
comes after the deletion and restart below, because rotating while the account
still holds a live session lets the target rotate again and read the
replacement.

**Deletion is still not complete.** Most mutation routes authenticate at the top
of the handler and only then await the request body — 89 of them, though a few
such as `POST /api/tokens/rotate` read no body at all — so a request begun before
the deletion carries an authorization decision that deletion cannot cancel. Twelve
of those routes grant access or action that outlives it: a new approved admin, an
approved access request, an agent API key, a webhook aimed at an attacker's URL,
an OpenClaw cron job, a paired gateway device with its own token, a spawned
gateway agent run, a persistent agent command allowlist, overwritten agent instruction files,
attacker-authored skills, a host OS account, and the gateway bearer credential.

**Eight of those leave the application**, and nothing done inside Mission Control
undoes any of them. Wherever the platform's account-creation command is available
to the process, `POST /api/super/os-users` creates a **host OS account**. On Linux
that is passwordless sudo for `useradd`, and the requested password is applied by
a separate `chpasswd` call whose failure is ignored — so without that privilege
too, the account exists with no usable password. On macOS it is `sysadminctl
-addUser`, tried directly and then under sudo, and the requested password is set
in the same call, so the attacker's password does take effect.
`POST /api/gateways/connect` returns the **real gateway bearer credential** to
operator+ callers, which authenticates to the separate OpenClaw gateway.
`POST /api/cron` writes an **enabled OpenClaw cron job** with an attacker-chosen
schedule and agent-turn message, which keeps running afterwards. `POST /api/nodes`
approves a **gateway device pairing**, and the paired device holds its own token —
revoke it at the gateway, since deleting the Mission Control user does not.
`POST /api/spawn` submits an **agent run to the gateway** with an attacker-chosen
task and a timeout of up to an hour; once the gateway has accepted it, restarting
Mission Control does not cancel it, so find and cancel any runs spawned during
the window. `PUT /api/exec-approvals` writes **agent command allowlists** to
OpenClaw's persistent `exec-approvals.json`, so wildcard patterns added during the
window let agents run matching commands without approval indefinitely — neither
deletion nor a restart reverts that file, and the route writes no audit event.
`PUT /api/agents/[id]/files` overwrites **agent instruction files** (`AGENTS.md`,
`TOOLS.md`, `soul.md`) in the OpenClaw workspace, and `PUT /api/skills` writes
**attacker-authored skills** into the skill roots; both shape what agents do
afterwards and survive deletion and restart.

**Cut the in-flight requests before rotating anything.** There is no per-user
request registry and no drain check, so "wait for requests to finish" is not
something an operator can verify — a stalled body can be held open as long as the
attacker likes. Worse, rotating first does not help: `POST /api/gateways/connect`
reads the gateway token *after* its body await, so a request that resumes after
your rotation discloses the **replacement** token. Restart the Mission Control
process (or otherwise terminate its connections) after deleting the account and
before rotating credentials. That is the only step here that deterministically
ends an already-authorized handler.

Then, in this order:

- **Rotate the gateway credential.** `POST /api/gateways/connect` returns the
  existing token unchanged and writes no audit event, so a disclosed credential
  leaves the gateway's state looking entirely normal. Inspection cannot tell you
  whether it leaked; assume it did if such a request may have been in flight.
- **Rotate the global key with `POST /api/tokens/rotate`** — after the deletion
  and restart, never before, since that endpoint needs no request body and
  returns the new key in plaintext to any live admin session. Editing the
  `API_KEY` environment variable is **not** a rotation on a deployment that has
  ever rotated from the dashboard: `matchesGlobalApiKey` gives the
  `settings.security.api_key_hash` row precedence and only falls back to the
  environment when no such row exists, so the old database-backed key stays valid
  behind a changed env var. To rotate by environment instead, delete that
  settings row as part of the change.
- **Restart again after rotating the global key, before rotating the gateway
  credential.** The first restart does not lock out someone who knows the old
  global key: it stays valid until rotated, `getUserFromRequest` grants its
  holder admin, and they can reconnect and stall `POST /api/gateways/connect` —
  which reads the token after its body await — to capture the *replacement*
  gateway credential. Keep ingress closed until the old key is invalid, or
  restart between the two rotations.
- **Cancel any agent runs spawned during the window**, at the gateway. The
  restart does not reach them.
- **Review OpenClaw's `exec-approvals.json`** and remove allowlist entries added
  during the window, and the agent workspace's `AGENTS.md`, `TOOLS.md`,
  `soul.md` and skill roots for instructions written during it.
- **Revoke every agent API key the departing user created or saw** — not only
  keys minted during the window. `deleteUser` removes sessions and the user row
  and nothing else: `agent_api_keys` rows survive, the lookup checks only the
  hash, expiry and `revoked_at` without regard to `created_by`, and such a key
  can carry the `admin` scope. A key issued months earlier therefore outlives
  every step above.
- **Do not rely on the audit log alone.** Webhook creation, agent API key
  issuance, cron job creation, gateway connect, device pairing, and exec-approval
  changes write no audit events. Inspect the `webhooks` and `agent_api_keys`
  tables, OpenClaw's `cron/jobs.json` and `exec-approvals.json`, and the gateway's
  paired-device list directly, alongside the audit log for user creation,
  access-request approvals and agent spawns, and the host's account list on
  super-admin deployments.

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
