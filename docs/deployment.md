# Deployment Guide

## Prerequisites

- **Node.js** >= 20 (LTS recommended)
- **pnpm** (installed via corepack: `corepack enable && corepack prepare pnpm@latest --activate`)

### Ubuntu / Debian

`better-sqlite3` requires native compilation tools:

```bash
sudo apt-get update
sudo apt-get install -y python3 make g++
```

### macOS

Xcode command line tools are required:

```bash
xcode-select --install
```

## Quick Start (Development)

```bash
cp .env.example .env.local
pnpm install
pnpm dev
```

Open http://localhost:3000. Login with `AUTH_USER` / `AUTH_PASS` from your `.env.local`.

## Production (Direct)

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

The `pnpm start` script binds to `0.0.0.0:3005`. Override with:

```bash
PORT=3000 pnpm start
```

**Important:** The production build bundles platform-specific native binaries. You must run `pnpm install` and `pnpm build` on the same OS and architecture as the target server. A build created on macOS will not work on Linux.

## Production (Standalone)

Use this for bare-metal deployments that run Next's standalone server directly.
This path is preferred over ad hoc `node .next/standalone/server.js` because it
syncs `.next/static` and `public/` into the standalone bundle before launch.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start:standalone
```

For a full in-place update on the target host:

```bash
BRANCH=fix/refactor PORT=3000 pnpm deploy:standalone
```

What `deploy:standalone` does:
- fetches and fast-forwards the requested branch
- reinstalls dependencies with the lockfile
- rebuilds from a clean `.next/`
- stops the old process bound to the target port
- starts the standalone server through `scripts/start-standalone.sh`
- verifies that the rendered login page references a CSS asset and that the CSS is served as `text/css`

## Production (Docker)

Preferred operator flow (Make controls docker compose):

```bash
# 1) choose mode in .env
#    MC_MODE=prod   # or dev
#    OPENCLAW_ENABLED=1   # set 0 to run MC without OpenClaw stack

# 2) run universal verbs
make up
make restart
make down
make status
```

### Mode-aware Make workflow (minimal commands)

For day-to-day operations, see the [Daily Ops Cheatsheet](./ops-cheatsheet.md).

Use `.env` + `.env.openclaw` as the single source of truth for mode/host/port/token values.

- `MC_MODE=prod` → `docker-compose.yml`
- `MC_MODE=dev` → `docker-compose-dev.yml`
- `OPENCLAW_ENABLED=1` → `make <verb> all` includes OpenClaw
- `OPENCLAW_ENABLED=0` → `make <verb> all` manages MC only

Command grammar:

```text
make <verb> [all|mc|openclaw] [dev|prod]
```

- `all` is default scope.
- `dev` / `prod` override `MC_MODE` for one command invocation.
- Why no `--dev` / `--prod`: GNU Make consumes unknown `--xxx` tokens as Make options before Makefile goals are parsed, so mode overrides use positional tokens for deterministic behavior.
- `make restart [scope]` is deterministic and always executes `make down [scope]` followed by `make up [scope]`.
- With default `all` scope, `OPENCLAW_ENABLED=1` includes OpenClaw in both the down and up phases; `OPENCLAW_ENABLED=0` skips OpenClaw in both phases.

Primary operator commands:

| Workflow | Command |
|---|---|
| Start selected component(s) | `make up [all|mc|openclaw]` |
| Restart selected component(s) | `make restart [all|mc|openclaw]` |
| Stop selected component(s) | `make down [all|mc|openclaw]` |
| Mode + endpoint health summary | `make status [all|mc|openclaw]` |
| Refresh source/state only | `make update [all|mc|openclaw]` |
| Force rebuild selected component(s) | `make rebuild [all|mc|openclaw]` |
| Full maintenance (`update` + `rebuild` + `restart`) | `make upgrade [all|mc|openclaw]` |

Mode override examples:

```bash
make restart dev
make restart mc dev
make status openclaw
make upgrade prod
```

### `update` vs `upgrade`

- `make update [scope]`
  - Fast-forwards the current Mission Control branch from origin.
  - For `scope=all`, if `OPENCLAW_ENABLED=1`, also refreshes OpenClaw source state.
  - For `scope=openclaw`, refreshes OpenClaw source state regardless of `OPENCLAW_ENABLED`.
  - Does **not** force an MC image rebuild and does **not** force restart.

- `make upgrade [scope]`
  - Runs update + rebuild + restart for selected scope.
  - `scope=mc`: MC-only flow.
  - `scope=openclaw`: OpenClaw update flow (`make openclaw-update`).
  - `scope=all`: both flows; OpenClaw path runs when `OPENCLAW_ENABLED=1`.

Minimum `.env` / `.env.openclaw` keys for this flow:

```env
# .env
MC_MODE=prod
OPENCLAW_ENABLED=1
MC_URL_SCHEME=http
MC_HOST=127.0.0.1
MC_PORT=7012
OPENCLAW_GATEWAY_TOKEN=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_NUMERIC_USER_ID=123456789
TELEGRAM_DM_POLICY=pairing
TELEGRAM_ALLOW_FROM=
TELEGRAM_OWNER_ALLOW_FROM=
# .env.openclaw (or keep in .env)
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_CONTROL_UI_PORT=18791
OPENCLAW_GATEWAY_INTERNAL_PORT=18789
OPENCLAW_STATUS_HOST=127.0.0.1
```

```bash
docker compose up          # with gateway connectivity
docker compose --profile standalone up   # without gateway (standalone mode)
```

Or build and run manually:

```bash
docker build -t mission-control .
docker run -p 3000:3000 \
  -v mission-control-data:/app/.data \
  -e AUTH_USER=admin \
  -e AUTH_PASS=your-secure-password \
  -e API_KEY=your-api-key \
  -e OPENCLAW_GATEWAY_HOST=host.docker.internal \
  --add-host=host.docker.internal:host-gateway \
  mission-control
```

The Docker image:
- Builds from `node:22-slim` with multi-stage build
- Compiles `better-sqlite3` natively inside the container (Linux x64)
- Uses Next.js standalone output for minimal image size
- Runs as non-root user `nextjs`
- Exposes port 3000 (override with `-e PORT=8080`)

### Gateway Connectivity from Docker

MC inside Docker needs to reach the gateway running on the host. There are **two** connections:

1. **Server-side** (MC backend → gateway): Set `OPENCLAW_GATEWAY_HOST=host.docker.internal`.
   Docker Desktop (macOS/Windows) resolves this automatically. On Linux, `docker-compose.yml`
   maps it via `extra_hosts`.

2. **Browser-side** (user's browser → gateway WebSocket): When the gateway host is a
   Docker-internal name (like `host.docker.internal`), MC automatically rewrites the WebSocket
   URL to the browser's own hostname. No extra config needed for local Docker usage.
   For remote access, set `NEXT_PUBLIC_GATEWAY_HOST` to the public hostname.

If your gateway runs in **another container**, put both on the same Docker network and set
`OPENCLAW_GATEWAY_HOST` to the gateway container name.

### Local Security Scan Expectations (HTTP dev vs HTTPS prod)

For local Docker development over plain `http://`, the following defaults are expected:

- Keep `MC_COOKIE_SECURE` unset
- Keep `MC_ENABLE_HSTS` unset
- Use `OPENCLAW_GATEWAY_HOST=host.docker.internal` when MC runs in Docker and gateway runs on host

`MC_COOKIE_SECURE=1` and `MC_ENABLE_HSTS=1` are HTTPS-only hardening flags. Enabling them on plain HTTP can break login/session behavior and create misleading local warnings.

Mission Control's security scan treats `host.docker.internal` as a valid local Docker topology (not a public exposure) and should not be interpreted as a production misconfiguration by itself.

### Persistent Data

SQLite database is stored in `/app/.data/` inside the container. Mount a volume to persist data across restarts:

```bash
docker run -v /path/to/data:/app/.data ...
```

### Automatic backups

- Set `MC_AUTO_BACKUP=1` (accepts `1`/`true`/`yes`/`on`) in your `.env` to enable automatic daily backups without toggling it in the UI.
- The backup directory is created automatically when scheduled backups run, so the backup warning clears once the task executes.

### Self-contained Operator Setup (Linux host with existing Claude Code / Codex CLIs)

For an operator running MC on a Linux/Docker host who already has authenticated
`claude` / `codex` / `opencode` CLIs in `~/.local/bin`, the default
`docker-compose.yml` projects the host configuration into the container so MC
can drive those same authenticated CLIs without re-login. This path runs MC
**without** OpenClaw gateway (which is macOS-only).

What the default compose does for this case:

- **Image bakes `claude` and `codex` as a fallback** — if the host doesn't
  have them in `~/.local/bin`, the container's installed copies are used.
  The host's `~/.local/bin` comes first in `PATH`, so an authenticated host
  install transparently shadows the baked one.
- **Host home is bind-mounted** — `${HOME}/.local/bin`, `${HOME}/.bun`,
  `${HOME}/.claude`, `${HOME}/.claude.json`, and `${HOME}/.local/share/claude`
  are mounted under `/home/nextjs/...` inside the container, plus `${HOME}`
  itself and `/mnt` are mounted at the same absolute paths so file paths the
  user sees on the host work identically inside the container.
- **Container runs as uid 1000** (the slim image's existing `node` user,
  renamed `nextjs`) so bind-mounted host files (typical Linux uid 1000) are
  read/written without `chown`.

**Ports.** `docker-compose.yml` maps `${MC_PORT}` on the host to `${PORT}` in
the container. The bundled `Makefile` computes its readiness/status URL from
`MC_URL_SCHEME`, `MC_HOST`, and `MC_PORT` loaded from `.env`.

**uid mismatch.** If your host user has uid ≠ 1000 (common on macOS, or
multi-user Linux), edit `docker-compose.yml`:

```yaml
user: "$(id -u):$(id -g)"   # or hard-code your uid:gid
```

Otherwise bind-mounted files in `${HOME}` will be read-only inside the
container and Claude Code will fail to write its config.

**Memory.** The compose file sets `memory: 2G` deploy limit. The upstream
default of 512M OOM-kills MC when `/chat` opens a `node-pty` terminal and the
task-dispatch loop is running concurrently. Do not lower this limit unless
you are sure neither feature is in use.

#### Direct API dispatch (gateway-free)

When OpenClaw is not present, MC dispatches tasks via direct provider APIs.
Provider is picked by the agent's `dispatchModel` prefix:

| `dispatchModel` pattern                                          | Provider           | Auth |
|------------------------------------------------------------------|--------------------|------|
| `claude-*`, `anthropic/*`                                        | Anthropic API      | `ANTHROPIC_API_KEY` |
| `gpt-*`, `o1-*`, `o3-*`, `openai/*`                              | OpenAI API         | `OPENAI_API_KEY` |
| `local/*`, `ollama/*`, `lmstudio/*`, `litellm/*`                 | OpenAI-compatible  | `LOCAL_LLM_ENDPOINT` (+ optional `LOCAL_LLM_API_KEY`) |

The "local" provider speaks the OpenAI `/v1/chat/completions` REST shape, so
LMStudio, Ollama, vLLM, and a [liteLLM](https://github.com/BerriAI/litellm)
proxy all work behind it. For multiple local backends behind one endpoint,
run liteLLM as a sidecar container and point `LOCAL_LLM_ENDPOINT` at it.

#### Shared host Claude Code session (`MC_HOST_SESSION_MODE`)

`/chat` can drive a Claude Code session that the operator has open in a host
terminal — both processes share the same `~/.claude/projects/<encoded>/<id>.jsonl`
transcript. Pick the policy via env:

| Mode | Behaviour |
|------|-----------|
| `coexist` (default) | Both MC and the host CLI append to the jsonl. Each side picks up the other's writes on its next prompt. Possible interleaving on simultaneous writes — fine for a single operator switching between the two surfaces. |
| `block-active` | Returns `409` from `/api/sessions/continue` if the jsonl was touched in the last 60s (heuristic: a live host CLI updates mtime frequently). Forces MC to act only on idle sessions. |
| `nudge` | Same as `coexist` plus a best-effort `utimes()` on the jsonl after the reply, so a tail-watching host CLI sees a fresh mtime. |

### Production Hardening

```bash
docker compose -f docker-compose.yml -f docker-compose.hardened.yml up -d
```

This adds: JSON logging, strict hostname allowlist, secure cookies, HSTS, internal-only network.

### Host hardening (Ubuntu quick actions)

- **Firewall (ufw)**: `sudo apt-get install -y ufw && sudo ufw allow OpenSSH && sudo ufw enable && sudo ufw status`
- **Time sync (NTP)**: `timedatectl set-ntp true && timedatectl status` (ensures systemd-timesyncd is active)
- **Automatic security updates**: `sudo apt-get install -y unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades && sudo unattended-upgrade -d`
- **Brute-force protection (fail2ban)**: `sudo apt-get install -y fail2ban && sudo systemctl enable --now fail2ban` (tune `/etc/fail2ban/jail.local` as needed)
- **/tmp noexec**: add `tmpfs /tmp tmpfs defaults,noexec,nosuid,nodev 0 0` to `/etc/fstab`, then `sudo mount -o remount /tmp`
- **Encrypted data (LUKS)**: create/attach a LUKS volume for data (`sudo cryptsetup luksFormat /dev/sdX && sudo cryptsetup open /dev/sdX mc-data && sudo mkfs.ext4 /dev/mapper/mc-data`) and mount it for `.data/` or backups
- **MAC framework**: keep AppArmor enabled (`sudo systemctl enable --now apparmor && sudo aa-status`); 
  Ubuntu SELinux users can install `selinux-basics selinux-policy-default` and enable per Ubuntu guidance
  - sudo apt update
  - sudo apt install selinux-basics selinux-policy-default
  - sudo selinux-activate
  - sudo reboot
  - sudo apt install policycoreutils; sestatus # check status

## Environment Variables

See `.env.example` for the full list. Key variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AUTH_USER` | Yes | `admin` | Admin username (seeded on first run) |
| `AUTH_PASS` | Yes | - | Admin password |
| `AUTH_PASS_B64` | No | - | Base64-encoded admin password (overrides `AUTH_PASS` if set) |
| `API_KEY` | Yes | - | API key for headless access |
| `PORT` | No | `3005` (direct) / `3000` (Docker) | Server port |
| `OPENCLAW_HOME` | No | - | Legacy: parent home directory containing `.openclaw/`. Use `OPENCLAW_STATE_DIR` instead (see note below) |
| `OPENCLAW_STATE_DIR` | No | `~/.openclaw` | Exact path to the OpenClaw state directory. Preferred over `OPENCLAW_HOME` — avoids double-nesting when the path already ends in `.openclaw` |
| `OPENCLAW_TOOLS_PROFILE` | No | `coding` | Tool profile projected into OpenClaw config when the env var is present (compose injects the default) |
| `OPENCLAW_SECURITY_WORKSPACE_ONLY` | No | `1` | Restrict filesystem tools to the workspace when set (env-driven) |
| `OPENCLAW_SECURITY_DENY_AUTOMATION` | No | `1` | Deny automation tool group via env-driven bootstrap |
| `OPENCLAW_SECURITY_DENY_RUNTIME` | No | `1` | Deny runtime tool group via env-driven bootstrap |
| `OPENCLAW_SECURITY_DENY_FS` | No | `0` | Deny filesystem tool group (opt-in; can block file workflows) |
| `OPENCLAW_SECURITY_SANDBOX_ALL` | No | `1` | Force `agents.defaults.sandbox.mode="all"` when set (env-driven) |
| `MISSION_CONTROL_DATA_DIR` | No | `.data/` | Directory for all Mission Control data files (DB, tokens, etc.). Use an absolute path with the standalone server to survive rebuilds. |
| `MC_ALLOWED_HOSTS` | Yes in production | _(none)_ | Comma-separated hosts allowed to reach the app. Host checking fails closed: with this unset, production serves only `localhost`, `127.0.0.1`, `::1`, and the machine hostname, and answers `403 Forbidden` to everything else. Set it to the public hostname before putting the app behind a proxy. |
| `MC_PROXY_AUTH_HEADER` | No | _(none)_ | Header carrying an identity already authenticated by a trusted gateway (e.g. `X-User-Email`). Enabling it requires `MC_PROXY_AUTH_SECRET` and the deployment controls in [Trusted reverse proxy authentication](#trusted-reverse-proxy-authentication). |
| `MC_PROXY_AUTH_SECRET` | Yes when `MC_PROXY_AUTH_HEADER` is set | _(none)_ | Random string of at least 32 characters that the gateway injects as `X-MC-Proxy-Secret`. Shorter or missing disables proxy auth and logs a critical security event. |
| `MC_PROXY_AUTH_DEFAULT_ROLE` | No | _(none)_ | When set to `viewer`, `operator`, or `admin`, unknown proxy identities are auto-provisioned at that role. Leave unset to accept only pre-existing users. |
| `MC_PORT` | No | `3000` | Host-side port that the bundled `docker-compose.yml` publishes the container's `PORT` on. The bundled `Makefile` expects `7012`. |
| `ANTHROPIC_API_KEY` | No (Yes for direct dispatch) | - | Used when `dispatchModel` matches `claude-*` / `anthropic/*` and no gateway is available. |
| `OPENAI_API_KEY` | No | - | Used when `dispatchModel` matches `gpt-*` / `o1-*` / `o3-*` / `openai/*`. |
| `LOCAL_LLM_ENDPOINT` | No | `http://host.docker.internal:1234/v1` | OpenAI-compatible base URL (LMStudio default shown). Override for Ollama (`:11434/v1`) or a liteLLM proxy. |
| `LOCAL_LLM_API_KEY` | No | - | Bearer token sent to `LOCAL_LLM_ENDPOINT`. Only needed for proxies that require auth (e.g. liteLLM with master key). |
| `MC_HOST_SESSION_MODE` | No | `coexist` | Policy when MC `--resumes` a host Claude Code session that may have a live CLI attached. One of `coexist`, `block-active`, `nudge`. |
| `NEXT_PUBLIC_CHAT_POLL_INTERVAL_MS` | No | `1500` (code) / `1000` (docker-compose) | `/chat` transcript poll cadence (ms) when the SSE channel drops. **Baked at build time**, so changing it requires `make rebuild`. |

> **Sandbox runtime requirement**
> 
> Enabling sandbox mode via `OPENCLAW_SECURITY_SANDBOX_ALL=1` requires Docker access. Ensure the `mc-openclaw-gateway` service bind-mounts the host Docker socket (`/var/run/docker.sock`) as shown in `docker-compose-openclaw.yml`.

> **Note — `OPENCLAW_HOME` vs `OPENCLAW_STATE_DIR`**
>
> Mission Control supports two env vars for locating OpenClaw:
>
> - `OPENCLAW_HOME` — treated as the *parent* home directory; `.openclaw` is appended automatically.
>   Setting `OPENCLAW_HOME=/root/.openclaw` will resolve to `/root/.openclaw/.openclaw` (**double-nesting bug**).
> - `OPENCLAW_STATE_DIR` — treated as the *exact* state directory path. Always prefer this.
>
> **Recommended `.env` for a standard install:**
> ```env
> OPENCLAW_STATE_DIR=/root/.openclaw
> MISSION_CONTROL_DATA_DIR=/absolute/path/to/.data
> ```
> Using an absolute path for `MISSION_CONTROL_DATA_DIR` ensures your
> database and data survive `npm run build` / standalone server rebuilds.

## Trusted reverse proxy authentication

Setting `MC_PROXY_AUTH_HEADER` lets a gateway that has already authenticated the
user (Envoy OIDC `claimToHeaders`, an oauth2-proxy, Tailscale Serve) pass that
identity through. Because the identity arrives as an HTTP header, the gateway
configuration is part of the security boundary.

> **A leaked secret exposes the entire application, not part of it.**
>
> The middleware admits a request carrying a valid `X-MC-Proxy-Secret` so it can
> reach route auth, which is the only layer able to resolve the identity header
> against the database. Both page routes and `/api/*` are covered, so an
> attested user reaches the dashboard without seeing the login form.
>
> That admission is not authentication — route auth resolves the identity header
> against the database and returns that user — but it does mean the secret alone
> determines whether a request is considered to come from the gateway. There is
> no second factor: the `/api/*` middleware check cannot query the database from
> the edge runtime, so it only shape-checks dashboard-issued keys, and never
> treated a key as proof of anything. When assessing a leaked secret or a
> directly reachable backend, assume the whole surface is exposed.
>
> **The gateway's identity does not always win.** If route auth cannot resolve
> the name — an existing *unapproved* account always, or a renamed or unknown one
> when `MC_PROXY_AUTH_DEFAULT_ROLE` is unset — it does not stop there. It falls
> through to the session cookie and API key, so a user whose upstream identity
> changed can still be authenticated as their *old* account by a cookie that has
> not expired.
>
> **Removing access upstream does not remove it here, and unapproving is not
> enough.** `validateSession` does not check approval, and no admin route or UI
> action ends another user's session — `destroyAllUserSessions` is called only by
> the user's own password change and by `deleteUser`. An unapproved account
> therefore keeps working until its session expires.
>
> **To revoke a user, delete the account**, which destroys their sessions first.
> Before doing so:
>
> 1. Confirm `MC_PROXY_AUTH_DEFAULT_ROLE` is unset, or that the gateway has
>    stopped asserting that identity. Otherwise deletion makes the identity
>    *unknown*, and the next attested request auto-provisions a fresh approved
>    account with the configured role.
> Rotate the global `API_KEY` **after** the deletion, not here — see below. It is
> not per-user, so deletion does not affect it, but rotating while the account
> still has a live session lets the target call `POST /api/tokens/rotate` again
> and read the replacement.
>
> This is a workaround, not a procedure, and three gaps are worth knowing when
> assessing exposure. Unapproving alone leaves a live session with no supported
> way to clear it. While an unapproved admin still holds that session, the admin
> routes' role-only checks keep passing, so they can create another approved
> admin that survives whatever is done to the original. And deletion does not
> stop a request that was already authorized: most mutation routes authenticate
> before awaiting their body — 89 of them, though some read no body at all — so a
> revoked admin can begin `POST /api/auth/users`, stall, wait out the deletion,
> and then create a fresh approved admin.
>
> Twelve mutation routes in that shape grant access outliving the revocation, and
> **eight of them leave the application**. Wherever the platform's account-creation
> command is reachable — passwordless sudo for `useradd` on Linux, `sysadminctl
> -addUser` on macOS, which unlike Linux does apply the requested password —
> `POST /api/super/os-users` creates a host OS account. `POST /api/gateways/connect`
> returns the real gateway bearer credential to operator+ callers; `POST /api/cron`
> writes an enabled OpenClaw cron job that keeps running agent turns;
> `POST /api/nodes` approves a gateway device pairing whose device holds its own
> token; `POST /api/spawn` submits an agent run to the gateway that a Mission
> Control restart cannot cancel. The rest mint a new approved admin, an approved
> access request, an agent API key, or a webhook aimed at a chosen URL.
>
> **Restart the Mission Control process after deleting the account and before
> rotating anything.** There is no drain check an operator can consult, and a
> stalled request can be held open indefinitely — and rotating first is not a way
> round it, because `gateways/connect` reads the token *after* its body await, so
> a request resuming later discloses the replacement too. A restart is the only
> step that deterministically ends an already-authorized handler.
>
> Then rotate the gateway credential (its state looks normal even after
> disclosure, so inspection proves nothing) and the global key via
> `POST /api/tokens/rotate` — only after the deletion and restart, since that
> endpoint needs no body and returns the new key in plaintext to any surviving
> admin session. Changing the `API_KEY` environment variable is not a rotation
> where a `settings.security.api_key_hash` row exists; that row takes precedence
> and the old key stays valid until it is removed.
>
> Restart **again** after rotating the global key and before rotating the gateway
> credential: the first restart does not lock out someone holding the old global
> key, and they can stall `gateways/connect` to capture the replacement gateway
> token.
>
> **Cancel any agent runs spawned during the window** at the gateway — the
> restart does not reach them — review OpenClaw's `exec-approvals.json`, the
> agent workspace instruction files and skill roots for changes made during it,
> and **revoke every agent API key the departing user created or saw**:
> `deleteUser` does not touch `agent_api_keys`, the lookup ignores `created_by`,
> and such a key can carry the `admin` scope.
>
> The audit log does not record webhook creation, agent key issuance, cron job
> creation, gateway connect, device pairing, or exec-approval changes — inspect
> the `webhooks` and `agent_api_keys` tables, OpenClaw's `cron/jobs.json` and
> `exec-approvals.json`, and the gateway's paired devices directly, alongside the
> audit log and the host's account list on super-admin deployments.
>
> Closing this properly needs an atomic revocation operation and an authority
> recheck after body parsing, not a documented ordering — see
> [docs/plans/2026-08-13-user-revocation.md](plans/2026-08-13-user-revocation.md).

Mission Control checks exactly one credential: `MC_PROXY_AUTH_SECRET`, at least
32 random characters, injected by the gateway as `X-MC-Proxy-Secret` and
compared in constant time. It must not be the placeholder from `.env.example`,
which is public. If it is missing, shorter, or that placeholder, proxy auth
stays disabled, every request falls back to normal session login, and a
`proxy_auth_misconfigured` critical security event is recorded on the first
request. Requests presenting proxy headers that fail any check after that —
a mismatched secret, a missing identity header, or an identity that does not
resolve to an approved user — are recorded as `proxy_auth_rejected`
(rate-limited to one event per minute).

Because that secret is the whole of the authentication, two things outside the
application carry the rest:

**1. The gateway must strip these headers from every inbound client request
before adding its own**, on every route, not just the login path:

| Header | Why |
| --- | --- |
| whatever `MC_PROXY_AUTH_HEADER` names (e.g. `X-User-Email`) | Otherwise a client picks its own identity. |
| `X-MC-Proxy-Secret` | Otherwise a client can replay a leaked secret. |

**2. The app must not be reachable except through the gateway.** Anyone who can
open a connection directly and present the secret becomes whatever user they
name. Every bundled launch path publishes on all interfaces by default, so this
takes an explicit change:

| Launch path | Default | Loopback-only |
| --- | --- | --- |
| `docker-compose.yml` | `"${MC_PORT:-3000}:${PORT:-3000}"` — all interfaces | Override the mapping to `"127.0.0.1:${MC_PORT:-3000}:${PORT:-3000}"`, or drop `ports:` entirely and put the gateway on the same Docker network |
| `scripts/deploy-standalone.sh` | `MC_HOSTNAME` unset → `0.0.0.0` | Set `MC_HOSTNAME=127.0.0.1` |
| `scripts/start-standalone.sh` | `HOSTNAME` unset → `0.0.0.0` | Set `HOSTNAME=127.0.0.1` |
| `pnpm start` | `next start --hostname 0.0.0.0` | Run `next start --hostname 127.0.0.1` |

Note that `MC_PORT` is only a port number — it cannot restrict the interface,
so changing it does not satisfy this requirement.

There is deliberately no trusted-IP option. `X-Forwarded-For` records the
address each proxy saw as *its* peer, so it never contains the address of the
proxy that connected to this app, and no transport peer is exposed to
middleware to compare against. A "trusted hop" header would just be the shared
secret with less entropy. Restricting where connections may originate is a
network control, which is what requirement 2 is.

Leave `MC_PROXY_AUTH_DEFAULT_ROLE` unset unless you intend unknown identities to
be auto-provisioned as real accounts.

## Kubernetes Sidecar Deployment

When running Mission Control alongside a gateway as containers in the same pod (sidecar pattern), agents are not discovered via the filesystem. Instead, use the gateway's agent registration API.

### Architecture

```
┌──────────────── Pod ────────────────┐
│  ┌─────────┐     ┌───────────────┐  │
│  │   MC    │◄───►│   Gateway     │  │
│  │ :3000   │     │   :18789      │  │
│  └─────────┘     └───────────────┘  │
│       ▲                  ▲          │
│       │ localhost        │          │
│       └──────────────────┘          │
└─────────────────────────────────────┘
```

### Required Configuration

**Environment variables** for the MC container:

```bash
AUTH_USER=admin
AUTH_PASS=<secure-password>
API_KEY=<your-api-key>
OPENCLAW_GATEWAY_HOST=127.0.0.1
NEXT_PUBLIC_GATEWAY_PORT=18789
```

### Agent Registration

The gateway must register its agents with MC on startup. Include the `agents` array in the gateway registration request:

```bash
curl -X POST http://localhost:3000/api/gateways \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "sidecar-gateway",
    "host": "127.0.0.1",
    "port": 18789,
    "is_primary": true,
    "agents": [
      { "name": "developer-1", "role": "developer" },
      { "name": "researcher-1", "role": "researcher" }
    ]
  }'
```

To update the agent list on reconnect, use `PUT /api/gateways` with the same `agents` field.

Alternatively, each agent can register itself via the direct connection endpoint:

```bash
curl -X POST http://localhost:3000/api/connect \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "tool_name": "openclaw-gateway",
    "agent_name": "developer-1",
    "agent_role": "developer"
  }'
```

### Health Checks

Agents must send heartbeats to stay visible:

```bash
curl http://localhost:3000/api/agents/<agent-id>/heartbeat \
  -H "Authorization: Bearer <API_KEY>"
```

Without heartbeats, agents will be marked offline after 10 minutes (configurable via `general.agent_timeout_minutes` setting).

## Troubleshooting

### "Internal server error" on login / NODE_MODULE_VERSION mismatch

`better-sqlite3` is a native addon compiled for a specific Node.js version.
If you switch Node versions (e.g. via nvm), the compiled binary won't load.

```bash
pnpm rebuild better-sqlite3
```

The health endpoint (`/api/status?action=health`) will report this error explicitly.

### "Module not found: better-sqlite3"

Native compilation failed. On Ubuntu/Debian:
```bash
sudo apt-get install -y python3 make g++
rm -rf node_modules
pnpm install
```

### Docker: gateway unreachable / WebSocket not connecting

**Checklist:**

1. Verify the gateway is reachable from inside the container:
   ```bash
   docker exec mission-control curl -s http://host.docker.internal:18789
   ```

2. Check env vars are set:
   ```bash
   docker exec mission-control env | grep -i gateway
   ```
   You should see `OPENCLAW_GATEWAY_HOST=host.docker.internal`.

3. If using a **mounted `~/.openclaw`** directory, the `openclaw.json` inside may have
   `gateway.host = "127.0.0.1"` — this is the host's loopback, not reachable from the
   container. Environment variables take precedence over `openclaw.json`, so set
   `OPENCLAW_GATEWAY_HOST=host.docker.internal` in your `.env` or docker-compose.

4. **Browser WebSocket**: MC automatically rewrites Docker-internal hostnames
   (`host.docker.internal`, `host-gateway`) to the browser's hostname. If the browser
   still can't connect, set `NEXT_PUBLIC_GATEWAY_HOST` to a hostname your browser can reach.

5. **Linux-specific**: `host.docker.internal` requires Docker 20.10+. The `extra_hosts`
   entry in `docker-compose.yml` handles this. If using `docker run` directly, add
   `--add-host=host.docker.internal:host-gateway`.

### AUTH_PASS with "#" is not working

In dotenv files, `#` starts a comment unless the value is quoted.

Use one of these:
- `AUTH_PASS="my#password"`
- `AUTH_PASS_B64=$(echo -n 'my#password' | base64)`

### "pnpm-lock.yaml not found" during Docker build

If your deployment context omits `pnpm-lock.yaml`, Docker build now falls back to
`pnpm install --no-frozen-lockfile`.

For reproducible builds, include `pnpm-lock.yaml` in the build context.

### "Invalid ELF header" or "Mach-O" errors

The native binary was compiled on a different platform. Rebuild:
```bash
rm -rf node_modules .next
pnpm install
pnpm build
```

### Database locked errors

Ensure only one instance is running against the same `.data/` directory. SQLite uses WAL mode but does not support multiple writers.

### "Gateway error: origin not allowed"

Your gateway is rejecting the Mission Control browser origin. Add the Control UI origin
to your gateway config allowlist, for example:

```json
{
  "gateway": {
    "controlUi": {
      "allowedOrigins": ["http://YOUR_HOST:3000"]
    }
  }
}
```

Then restart the gateway and reconnect from Mission Control.

### "Gateway error: device identity required"

Device identity signing uses WebCrypto and requires a secure browser context.
Open Mission Control over HTTPS (or localhost), then reconnect.

### "Gateway shows offline on VPS deployment"

Browser WebSocket connections to non-standard ports (like 18789/18790) are often blocked by VPS firewall/provider rules.

Quick option:

```bash
NEXT_PUBLIC_GATEWAY_OPTIONAL=true
```

This runs Mission Control in standalone mode (core features available, live gateway streams unavailable).

Production option: reverse-proxy gateway WebSocket over 443.

nginx example:

```nginx
location /gateway-ws {
  proxy_pass http://127.0.0.1:18789;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_read_timeout 86400;
}
```

Then point UI to:

```bash
NEXT_PUBLIC_GATEWAY_URL=wss://your-domain.com/gateway-ws
```

Mission Control now retries common reverse-proxy websocket paths (`/gateway-ws`, `/gw`) automatically when root-path handshake fails, but setting `NEXT_PUBLIC_GATEWAY_URL` is still recommended for deterministic production behavior.

## Next Steps

Once deployed, set up your agents and orchestration:

- **[Quickstart](quickstart.md)** — Register your first agent and complete a task in 5 minutes
- **[Agent Setup](agent-setup.md)** — SOUL personalities, heartbeats, config sync, agent sources
- **[Orchestration Patterns](orchestration.md)** — Auto-dispatch, quality review, multi-agent workflows
- **[CLI Reference](cli-agent-control.md)** — Full CLI command list for headless/scripted usage
