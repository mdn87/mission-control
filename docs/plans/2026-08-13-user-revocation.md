# User revocation plan

Base branch: `main`

Filed as a plan rather than an issue because this repository has issues
disabled. Surfaced while correcting documentation in #12: those docs described a
revocation procedure, and review established that the procedure cannot be
performed and that the underlying capability does not exist. #12 documents the
limitation and adds two narrow guards; this plan covers the actual fix.

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

**4. `PATCH /api/auth/me` can mint a session after the operator's deletion.**
The handler calls `destroyAllUserSessions` (line 101), then unconditionally
`createSession` (line ~124) with no approval recheck. A user can let the handler
authenticate, stall the body read until the operator has deleted their sessions,
then complete a password change and receive a fresh session. Affects non-admin
users too.

**5. Authorization is decided before the request body is read, everywhere.**
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

Most merely let a revoked user complete one more write. **At least nine grant
persistent access**, which is what makes the shape a revocation problem rather
than an ordinary race:

| Route | What survives the revocation |
| --- | --- |
| `POST /api/super/os-users` | **A host OS account** — `sudo -n /usr/sbin/useradd` at line 366, with a password from the request body (line 274) |
| `POST /api/auth/users` | A new approved admin (`createUser` defaults `is_approved` to 1) |
| `PATCH /api/auth/me` | A new session, minted after the operator's deletion |
| `POST /api/auth/access-requests` | An account approved with a chosen role (`is_approved = 1`, line 108/115) |
| `POST /api/agents/[id]/keys` | An agent API key (`mca_…`, line 153) |
| `POST /api/tokens/rotate` | The rotated global `API_KEY`, now known to the revoked admin (line 83) |
| `POST /api/webhooks` | A webhook with an attacker-chosen URL and a generated secret (line 75-79) — ongoing event exfiltration |
| `POST /api/security-scan/fix` | Regenerated keys and a gateway auth token (lines 205, 252) |
| `PUT /api/workspaces/[id]` | Users reassigned across workspaces (line 151), which is the boundary the admin routes scope against |

The first is the one that matters most: it escapes the application entirely, so
no amount of Mission Control revocation touches it. It requires the deployment
to have granted the MC process passwordless sudo for `useradd` (the route's own
error hint at line 372 says so), which is the "super admin" configuration rather
than every install.

These were found by scanning the in-flight set for credential, identity, and
permission writes. **The set is a floor, not a total** — the scan keyed on
`createUser`/`createSession`/`hashApiKey`/`randomBytes`/`INSERT INTO` and similar,
so a route that grants persistent access by some other means would not appear.
The first pass of this plan said "two", and looking properly found nine.

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

## Phase 4: tests and documentation

Regression tests for each of the four problems above, in the style of the
precedence tests added in #12 (assert the behaviour; verify the guard is
load-bearing by removing it). Then rewrite the revocation sections of
`SECURITY.md` and `docs/deployment.md`, which currently describe a workaround.

## Credit

Problems 1, 3, and 4 are from the Codex review on #12, as is the TOCTOU in the
self-approval guard added and then fixed there. The review comments carry the
original analysis.
