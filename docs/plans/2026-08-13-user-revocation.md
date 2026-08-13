# User revocation plan

Base branch: `main`

Filed as a plan rather than an issue because this repository has issues
disabled. Surfaced while correcting documentation in #12: those docs described a
revocation procedure, and review established that the procedure cannot be
performed and that the underlying capability does not exist. #12 documents the
limitation and adds three narrow guards; this plan covers the actual fix.

## The problem

**1. No operator-facing way to end another user's sessions.**
`destroyAllUserSessions` has exactly two callers — `src/app/api/auth/me/route.ts:101`
(the user's own password change) and `src/lib/auth.ts:386` (inside `deleteUser`).
No admin route, no UI action. An operator who unapproves an account cannot clear
its live sessions.

**2. `validateSession` does not check approval.** `src/lib/auth.ts:203-233`
selects `is_approved` and never gates on it, so a session issued before
unapproval keeps working until it expires. Asserted by test in #12.

**3. Admin authority survives unapproval.** The admin routes check `role` only.
While an unapproved admin holds a live session, `POST /api/auth/users` lets them
create a new local admin with a chosen password, and `createUser` defaults
`is_approved` to 1 (`src/lib/auth.ts:353`). That account is unaffected by
anything done to the original, so revocation can be defeated by acting before
the session is cleared.

**4. `PATCH /api/auth/me` can mint a session after sessions are cleared.**
The handler calls `destroyAllUserSessions` (line 101), then unconditionally
`createSession` (line ~124) with no approval recheck. A user can let the handler
authenticate, stall the body read until the operator has cleared their sessions,
then complete a password change and receive a fresh one. Affects non-admin users
too.

This is a race against **clearing sessions, not against deleting the account**:
the password path reloads `password_hash` from `users` after parsing and returns
403 once the row is gone, and a display-only update returns 404. It therefore
matters for problem 1, where sessions cannot be cleared any other way, and not
for the deletion workaround.

**5. Authorization is decided before the request body is read.**
Handlers call `getUserFromRequest` or `requireRole` at the top and only then
`await validateBody(...)` or `await request.json()`. The authorization decision
is an in-memory object from before the await, so nothing that happens during it —
unapproval, session destruction, account deletion — can cancel the request. A
revoked admin begins `POST /api/auth/users` (auth at `route.ts:29-31`), stalls
the body (line 38), waits for the operator to delete the account, then resumes
and creates a fresh approved admin (lines 43-47).

This is the root cause of problem 4 rather than a separate bug, and it is
architectural: 89 mutation handlers under `src/app/api` match the shape
"authenticates, then awaits a body" (routes exporting POST/PUT/PATCH/DELETE that
call `getUserFromRequest` or `requireRole` and also `await validateBody(...)` or
`await request.json()`).

Most merely let a revoked user complete one more write. **Twenty-one grant access or
action that survives account deletion**, which is what makes the shape a revocation problem
rather than an ordinary race:

| Route | What survives the revocation |
| --- | --- |
| `POST /api/super/os-users` | **A host OS account** — `sudo -n /usr/sbin/useradd`, line 366 |
| `POST /api/gateways/connect` | **The real gateway bearer credential**, returned to operator+ at lines 184-193 |
| `POST /api/auth/users` | A new approved admin (`createUser` defaults `is_approved` to 1) |
| `POST /api/auth/access-requests` | An account approved with a chosen role (`is_approved = 1`, lines 108/115) |
| `POST /api/agents/[id]/keys` | An agent API key (`mca_…`, line 153) |
| `POST /api/webhooks` | A webhook with an attacker-chosen URL and generated secret (lines 75-79) — ongoing event exfiltration |
| `POST /api/cron` (`add`) | An enabled OpenClaw cron job with an attacker-chosen schedule and agent-turn message (lines 371-413), written to `cron/jobs.json` |
| `POST /api/nodes` | An approved gateway device pairing (auth line 97, body await 102, `device.pair.approve` 132-134); the paired device holds its own token |
| `PUT /api/exec-approvals` | Agent command allowlist patterns written to OpenClaw's persistent `exec-approvals.json` (auth line 114, body await 120, write 130-172); no audit event |
| `PUT /api/agents/[id]/files` | Overwritten agent instruction files — `AGENTS.md`, `TOOLS.md`, `soul.md` — in the OpenClaw workspace (auth 105, body await 116, write 139-141) |
| `PUT /api/skills` | Attacker-authored skills written into the OpenClaw or workspace skill roots (auth 408, body await 415) |
| `PUT /api/settings` | An overwritten `security.api_key_hash` — the route upserts arbitrary keys with no allowlist (auth before `validateBody` at 131, upsert 136-160), and that row outranks the environment key |
| `PUT /api/gateway-config` | Attacker-chosen values in persistent `openclaw.json` (auth 110, body await 134, write 174-183); only gateway auth fields are blocked |
| `POST /api/channels` | A messaging channel linked to the attacker's own account via the `whatsapp-link` QR (auth 165, body await 168) |
| `POST /api/releases/update` | An attacker-selected release tag checked out and rebuilt (auth 32, body await 42, checkout 81-107) |
| `PUT /api/integrations` | Attacker-selected variables written into OpenClaw's persistent `.env` (auth 473, body await 478, write 500-515); the blocklist does not cover `OPENCLAW_GATEWAY_TOKEN` or provider tokens |
| `POST /api/agents/[id]/wake`, `POST /api/tasks/[id]/broadcast` | Agent turns queued through existing gateway sessions; a restart does not retract accepted work |
| `POST /api/github` | Issue comments, closures and label initialisation performed on GitHub with the stored token (64-90, 255-301, 428-437) |
| `POST /api/gateways/control` | A gateway process started that was meant to stay stopped; in Docker the Hermes branch spawns it detached (218-275) |
| `POST /api/lugos/commands` | `approval.request`, `mail.handoff` or `task.approve` accepted by the separate Lugos operator service |
| `POST /api/spawn` | A gateway agent run with an attacker-chosen task (auth line 19, body await 28, `sessions_spawn` 86-103), timeout up to an hour; a Mission Control restart does not cancel it |

**Fourteen of these leave the application**, and none is undone by anything done
inside Mission Control:

- The host OS account, wherever the platform's account-creation command is
  reachable. On Linux that is passwordless sudo for `useradd`, and the *password*
  from the request body goes through a **separate** `sudo -n /usr/sbin/chpasswd`
  call at lines 379-383 whose failure is silently swallowed — so a narrowly
  scoped sudoers rule yields an account with no usable password rather than the
  attacker's. That is a weaker outcome, not a safe one. On macOS the same
  endpoint uses `sysadminctl -addUser` (lines 341-351), tried directly and then
  under sudo, with the requested password set in the same call — so there the
  attacker's password does take effect.
- The gateway bearer credential, which authenticates directly to the separate
  OpenClaw gateway and is not rotated by deleting a Mission Control user. Note
  the route returns the *existing* token unchanged and writes no audit event, so
  disclosure leaves no trace — the credential state looks normal afterwards, and
  only rotation resolves it.
- The OpenClaw cron job, which keeps running agent turns on the attacker's
  schedule from `cron/jobs.json` after the account is gone.
- The paired gateway device, which holds its own token for the separate gateway.
  Deleting the Mission Control user does not revoke the pairing; it has to be
  revoked at the gateway.
- The spawned gateway agent run, which the gateway executes on its own for up to
  an hour. A Mission Control restart cannot touch it, which makes the restart
  step in the current documentation necessary but not sufficient.
- The agent command allowlist in OpenClaw's `exec-approvals.json`. Wildcard
  patterns added during the window let agents execute matching commands without
  approval, indefinitely, and neither deletion nor a restart reverts the file.
- The agent instruction files — `AGENTS.md`, `TOOLS.md`, `soul.md` — in the
  OpenClaw workspace, which shape what every later agent turn does.
- Attacker-authored skills in the OpenClaw or workspace skill roots, same
  reasoning: they are read by agents long after the account is gone.
- Weakened gateway configuration in `openclaw.json`. Only gateway authentication
  fields are blocked, so `tools`, `elevated` and `channels` can be loosened and
  stay loosened.
- A messaging channel linked to the attacker's own account. Neither deletion nor
  a restart logs it out; it has to be logged out at the gateway.
- A rolled-back or partially built release on disk, where release updates are
  enabled and the source tree is writable.
- Variables in OpenClaw's `.env`, including advertised credentials such as
  `OPENCLAW_GATEWAY_TOKEN` — the blocklist on `PUT /api/integrations` does not
  cover them. Restore before restarting the gateway.
- Agent turns queued through existing gateway sessions by `wake` or `broadcast`,
  which the gateway executes regardless of what happens to Mission Control.
- GitHub state — comments, closed issues, initialised labels — written with the
  stored integration token, which no local rotation reaches.
- Commands accepted by the Lugos operator service (`approval.request`,
  `mail.handoff`, `task.approve`), which that service has already acted on.
- A gateway process started by `gateways/control` that was meant to stay
  stopped.

`PATCH /api/auth/me` mints a session, but **not through the deletion race**: the
password path reloads `password_hash` from `users` (line ~71) and returns 403
once the row is gone. It survives clearing sessions alone, so it matters for
problem 1 and not for the deletion workaround.

### What this list is not

The count went 2 → 5 → 9 → 6 → 7 → 8 → 9 → 10 → 12 → 16 → 21 across successive passes, every step of it
prompted by review rather than by my own checking. The nine was wrong in both
directions, and the errors are worth recording so the next reader calibrates
against them rather than the number:

- `POST /api/tokens/rotate` was counted as a body-stall race and is not one: it
  never awaits a body. It is still a revocation hazard, just a different kind —
  it authenticates at line 76 and returns the new key in **plaintext** at line
  134, so any live admin session can rotate the global key and read the
  replacement. That makes it an ordering constraint rather than a race: rotate
  the global key *after* the account is deleted, never before, or the target
  rotates again and learns the new one.
- `POST /api/security-scan/fix` was counted and does not belong: it writes the
  regenerated key and gateway token to `.env` and the OpenClaw config and returns
  only counts and generic notes (lines 393-404), so the requester never receives
  them.
- `PUT /api/workspaces/[id]` was counted and does not belong: it updates name,
  brand, and isolation only. The user reassignment at line 151 is in the `DELETE`
  handler, which does not await a body either.
- `POST /api/gateways/connect` was missed entirely, and it is one of the five
  external paths. `POST /api/nodes` and `POST /api/spawn` were missed the same
  way in later passes.

The scan keyed on `createUser`/`createSession`/`hashApiKey`/`randomBytes`/
`INSERT INTO` and similar, so a route granting persistence by other means would
not appear. Treat twenty-one as the current floor, not a total — and note that
the floor has risen at every single pass, which is the more useful fact.

## Current workaround

Delete the account. `deleteUser` destroys sessions before removing the row, so
deletion is the most complete revocation available today — but see problem 5: it
does not stop a request that was already authorized, so revocation is effective
only once in-flight requests have drained. It is also complete only if
`MC_PROXY_AUTH_DEFAULT_ROLE` is unset or the gateway has stopped asserting that
identity — otherwise the next attested request auto-provisions a fresh
**approved** account with the configured role. The global `API_KEY` is not
per-user and needs separate rotation. Documented in `SECURITY.md` and
`docs/deployment.md` as of #12.

## Goals

- An operator can revoke a user's access in one action, without database access.
- Revocation cannot be defeated by a user acting between steps.
- Unapproving an account has a defined, documented relationship to revocation
  rather than an accidental one.

## Phase 1: decide the authorization model

The open question, and a behaviour change for every deployment: should an
unapproved user's existing session be rejected at authorization time, or should
approval remain a login-time gate only? Rejecting closes problem 2 and most of
3, but changes what unapproval means for deployments already relying on it.

Worth establishing here, because neither was checked while filing this:

- Whether rejecting unapproved sessions is sufficient on its own, or whether the
  admin-creates-admin path in problem 3 survives it.
- Whether any path other than `PATCH /api/auth/me` can issue a session for an
  already-unapproved user.

## Phase 1a: artifacts a departing user leaves behind are not revoked at all

Distinct from every race below, and simpler. Two classes are confirmed:

- **Agent API keys.** See below.
- **Webhooks.** Delivery selects `WHERE enabled = 1 AND workspace_id = ?`
  (`src/lib/webhooks.ts:180`) with no regard for `created_by`, and `deleteUser`
  does not touch the table, so a webhook a departing admin configured months ago
  keeps receiving activity, notification and security events.

Both suggest the same question for the design: what else does a user create that
outlives their account? Nobody has enumerated that, and it is not the same
question as the in-flight race.

## Phase 1a-i: agent API keys are not revoked at all

Distinct from every race above, and simpler: `deleteUser` destroys sessions and
deletes the user row, and touches nothing else. `agent_api_keys` rows survive,
the lookup in `src/lib/auth.ts:565-600` matches on `key_hash` with only
`revoked_at` and expiry checks and no regard for `created_by`, and a key may
carry the `admin` scope. An admin who minted an agent key months ago keeps full
access after their account is deleted, with no in-flight request and no race
involved.

Any revocation operation must revoke that user's agent keys, and the UI needs a
way to see which keys a given user created.

## Phase 1b: there is no drain primitive

"Wait for in-flight requests to finish" appears in the current documentation
because it was the only honest thing to say, not because it is actionable. There
is no per-user in-flight registry and no operator-visible drain check, and an
attacker choosing to stall a body can hold one open indefinitely.

Rotating credentials first does not sidestep it: `POST /api/gateways/connect`
reads the gateway token *after* its body await (line 151 onward), so a request
resuming after a rotation discloses the replacement. The documentation therefore
tells operators to restart the process, which is deterministic but heavy-handed.

Whatever Phase 2 builds should make this unnecessary — revocation that takes
effect against already-authorized handlers, rather than an operational
instruction to bounce the service.

## Phase 2: atomic revocation

One operation that invalidates credentials and authority together, rather than a
documented ordering of separate steps. Endpoint plus a UI action in user
management. Should cover sessions and any per-user credentials, and state
explicitly what it does not cover (the global `API_KEY`).

## Phase 3: recheck authority after parsing

Problem 5 is the general case and problem 4 an instance of it, so the fix is a
recheck after the body is read rather than a patch per route. Options worth
weighing: re-resolving the user after `await` in the mutation handlers that
grant persistent access, or a wrapper that every mutation route goes through so
the recheck cannot be forgotten on a new one. The second is more work and the
only one that holds for the 87 routes nobody has looked at.

The self-approval guard added in #12 narrows its window rather than closing it —
the read and write are still separate statements — so an atomic check-and-update
belongs here too.

## Phase 4: audit coverage

Six of the ten escalation routes write no audit record at all:
`POST /api/webhooks`, `POST /api/agents/[id]/keys`, `POST /api/cron`,
`POST /api/gateways/connect`, `POST /api/nodes`, and `PUT /api/exec-approvals`
never call `logAuditEvent` or insert into `audit_log`. (`POST /api/spawn` does
record an `agent_spawn` event.) An operator investigating a revocation window can
therefore find nothing in the audit log while an attacker's webhook, agent key,
cron job, paired device, allowlist entry, or disclosed gateway credential
remains active.

Device pairing matters most among the additions, because the resulting credential
lives at the gateway rather than in Mission Control — unobservable here and
unrevoked by anything done here.

The gateway case is the sharpest: the route returns the existing token unchanged,
so there is no state difference to detect even in principle. Disclosure is
unobservable after the fact, which makes rotation the only sound response and an
audit event the only way to know it is needed.

Add audit events for all six, and sweep the remaining credential-issuing routes
for the same gap — each of these was found by testing a documentation claim, not
by a deliberate audit-coverage review.

## Phase 5: tests and documentation

Regression tests for each of the four problems above, in the style of the
precedence tests added in #12 (assert the behaviour; verify the guard is
load-bearing by removing it). Then rewrite the revocation sections of
`SECURITY.md` and `docs/deployment.md`, which currently describe a workaround.

## Credit

Problems 1, 3, and 4 are from the Codex review on #12, as is the TOCTOU in the
self-approval guard added and then fixed there. The review comments carry the
original analysis.
