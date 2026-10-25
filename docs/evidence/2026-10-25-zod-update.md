# Zod constrained-collection update

Mission Control now requires Zod `^4.6.7`; the lockfile resolves 4.6.7 throughout
the graph. No other package version, dependency override, release-age exception
or scanner suppression changed.

## Reason and boundary

[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
identifies releases before 4.6.6 as affected. The
[upstream correction](https://github.com/colinhacks/zod/pull/6652) rejects an
oversized constrained collection before validating its elements. Previously,
Mission Control's task tag limit could still produce one error per invalid tag
before reporting the size violation.

The npm registry records 4.6.7 as published at `2026-10-12T16:29:37.778Z`, more
than seven days before this October 25 change. The existing 10,080-minute release
age gate remains intact. Scalar and AI SDK peer-resolution identifiers changed
only because they now reference the same updated Zod version.

This is a dependency maintenance slice, not a claim that all denial-of-service
risks are eliminated. It does not cap request JSON allocation, unbounded schemas
or arbitrary metadata. Existing valid-input behavior and within-limit element
validation remain covered by the application suite. Shared runtime deployment,
mobile approvals and Autowork are outside this change.

## Evidence

- Two regressions use the real create/update task schemas and just 51 invalid
  tags against their maximum of 50. On 4.4.3 both returned 52 issues; on 4.6.7
  both return the single collection-size issue. No memory-exhaustion payload is
  needed. All 74 validation tests pass with the update.
- The complete unit suite passes **1,786 tests across 221 files** on Windows.
- OSV-Scanner 2.3.8 scanned 1,085 packages from both the original and updated
  lockfiles with the same existing configuration. The original reports the Zod
  advisory; the updated graph reports no findings. The existing braces ignore
  is unchanged and reported unused. This is a point-in-time dependency result,
  not a complete application security audit.
- Independent read-only review found no blocker in dependency scope, release
  age, the regression tests or the affected validation path. It emphasized the
  request-allocation/unbounded-schema limitations above.

The PR records the remaining build, typecheck, lint, artifact and end-to-end CI
results. Local test/scan/review receipts are retained with the portfolio
finishing-pass artifacts. Production installation requires the separately
coordinated Mission Control rollout; merging source does not update a running
server.

Rollback is a normal source revert and lockfile install, with no schema or
configuration migration. It would reintroduce the known advisory, so preserve
the reason and exposure assessment if rollback becomes necessary.
