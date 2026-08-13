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
per-user and deletion does not affect it, but **do not rotate it yet** — rotation
happens under isolation, in the sequence below, and deletion itself is only one
step of that sequence.

**Deletion is still not complete.** Most mutation routes authenticate at the top
of the handler and only then await the request body — 89 of them under
`src/app/api`, though a few such as `POST /api/tokens/rotate` read no body at all.
The authorization decision is therefore made before anything the operator does,
and a request begun before the deletion carries it through to completion
afterwards. Nothing in the application cancels an already-authorized handler.

Review has so far identified **twenty-one** such routes that grant access or
leave an effect outliving the revocation, **fourteen** of which reach outside
Mission Control entirely — the gateway, OpenClaw's persistent files, linked
messaging accounts, GitHub, the Lugos operator service, the host, and the
deployed release. That count has risen at every review pass, from two to
twenty-one, so treat it as a floor and the shape of the problem rather than an
inventory: **any handler that reaches an external system can be used this way.**
The response below is organised around that rather than around the list.

**Isolate first — Mission Control *and* the gateway — and stay isolated until
every credential is revoked.** This is step zero. Blocking only Mission Control
is not enough: a device paired earlier authenticates **directly** to the
browser-facing gateway with a cached device token (`src/lib/websocket.ts`), so
that path does not pass through anything you closed. And while the target can
still reach Mission Control, no ordering of restarts and rotations helps —
`PUT /api/settings` upserts arbitrary keys with no allowlist and can overwrite
`security.api_key_hash` with their own hash *after* you rotate, and
`POST /api/gateways/connect` reads the gateway token after its body await, so it
captures whatever the replacement is.

While isolated:

1. **Quarantine the target's queued and recurring tasks before restarting.**
   The scheduler's first scans run 10 and 20 seconds after startup
   (`src/lib/scheduler.ts`), so a restart with their tasks still queued executes
   attacker-authored prompts through the gateway, provider APIs or host CLIs
   while the rest of this is still in progress. Deleting the user does not remove
   those rows.
2. **Delete the account — and any account whose credentials the target created,
   reset, or saw.** `POST /api/auth/users` takes a caller-chosen password, so a
   second admin they created earlier (or through a request that completed before
   isolation) stays usable: no rotation here invalidates a local password.
3. **Restart the Mission Control process.** This is what ends handlers that were
   already authorized; nothing else in this list does.
4. **Rotate the global key with `POST /api/tokens/rotate`.** Editing the
   `API_KEY` environment variable is **not** a rotation where a
   `settings.security.api_key_hash` row exists — `matchesGlobalApiKey` gives that
   row precedence and only falls back to the environment when it is absent. To
   rotate by environment, delete that row as part of the change.
5. **Rotate the credential of every registered gateway, not just the primary.**
   `POST /api/gateways/connect` accepts any registered gateway id and returns
   that gateway's stored token to operator+ callers; only the primary uses the
   detected OpenClaw credential. Enumerate them.
6. **Revoke every credential the target holds or created**: agent API keys,
   webhooks, and **paired devices** (`device.token.revoke` via `/api/nodes`).
   `deleteUser` touches none of these tables, the agent key lookup ignores
   `created_by`, webhook delivery selects only on `enabled` and workspace, and a
   paired device token is what lets them reach the gateway directly. Any of these
   from months ago outlives every step above.

Only then lift the isolation.

**Then review what may have been left behind.** Mission Control orchestrates
other systems, so a request that completed during the window can have effects
outside it that no rotation reaches. The list below is what review has found so
far; treat it as illustrative, not complete. Eighteen rounds of review kept
adding to it, and the underlying property — authorization is decided before the
body is read, in most of the ~89 mutation handlers — means any handler that
reaches an external system belongs here.

- **The gateway**: agent runs from `POST /api/spawn`, and turns queued through
  existing sessions by `POST /api/agents/[id]/wake` or
  `POST /api/tasks/[id]/broadcast`. Cancel them at the gateway; a Mission Control
  restart does not retract accepted work. Also check whether a gateway process
  was started by `POST /api/gateways/control` that was meant to stay stopped.
- **OpenClaw's persistent files**: `exec-approvals.json` allowlists,
  `cron/jobs.json` jobs, `openclaw.json` configuration (only gateway auth fields
  are blocked, so `tools`, `elevated` and `channels` can be weakened), the agent
  workspace's `AGENTS.md`/`TOOLS.md`/`soul.md`, the skill roots, and the OpenClaw
  `.env` — `PUT /api/integrations` writes variables there, including advertised
  credentials such as `OPENCLAW_GATEWAY_TOKEN`. Restore before restarting the
  gateway.
- **Linked accounts and devices**: channels linked via `POST /api/channels`, and
  devices paired via `POST /api/nodes`. Both hold their own credentials at the
  gateway and must be revoked there.
- **Third-party systems**: `POST /api/github` uses the stored token to comment,
  close issues and initialize labels, and `POST /api/lugos/commands` submits
  approvals and handoffs to the Lugos operator service. Those effects persist
  wherever they landed and no local rotation reaches them.
- **The deployment itself**: `POST /api/releases/update` can leave an older or
  partially built release on disk, and `POST /api/super/os-users` a host account.
- **The audit log will not show most of this.** Webhook creation, agent key
  issuance, cron creation, gateway connect, device pairing and exec-approval
  changes write no audit events. Inspect the underlying tables and files.

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
