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

## Current workaround

Delete the account. `deleteUser` destroys sessions before removing the row, so
deletion is the only complete revocation available today. It is complete only if
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

## Phase 3: close the mint paths

Approval recheck at session issuance, covering problem 4 and anything Phase 1
turns up. The self-approval guard added in #12 narrows its window rather than
closing it — the read and write are still separate statements — so an atomic
check-and-update belongs here too.

## Phase 4: tests and documentation

Regression tests for each of the four problems above, in the style of the
precedence tests added in #12 (assert the behaviour; verify the guard is
load-bearing by removing it). Then rewrite the revocation sections of
`SECURITY.md` and `docs/deployment.md`, which currently describe a workaround.

## Credit

Problems 1, 3, and 4 are from the Codex review on #12, as is the TOCTOU in the
self-approval guard added and then fixed there. The review comments carry the
original analysis.
