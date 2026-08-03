# Lugos operator integration

This fork replaces Mission Control's overview with a Lugos fleet view and adds
a dense `Lugos` plugin panel without making Mission Control authoritative for
Lugos runs, identities, approvals, or receipts. The integration is pinned to
upstream commit `17186288ef28341723999a040b3b7baa55427a2c`.

## Boundary

| Hop | Authentication | Authority |
|---|---|---|
| Browser → Mission Control read routes | Mission Control `viewer` session or higher | Mission Control-local, disposable |
| Browser → Mission Control command route | Mission Control `operator` session or higher | Mission Control-local, disposable |
| Mission Control → Lugos snapshot/SSE | Loopback service boundary | Lugos projection contract |
| Mission Control → Lugos commands | Server-side `LUGOS_OPERATOR_API_TOKEN` | Lugos command allowlist and receipts |

The browser calls only `/api/lugos/*`. It never receives the Lugos endpoint or
bearer. Snapshot, event, command, and receipt payloads are parsed against the
strict `lugos-operator-*/v1` schemas. Unknown fields and schemas fail closed.

Mission Control does not write these objects to SQLite. Its database continues
to own only Mission Control users, roles, sessions, and local UI state.

## Week-3 spatial overview

The root overview is an automatic semantic layout of three projection-derived
entity types:

- machines from `source_host`;
- services from the run `route`, explicitly labeled as derived rather than an
  authoritative service inventory;
- agents from `agent_address`, grouped by source host.

Coordinates are computed from the current snapshot and are never stored,
dragged, or operationally meaningful. Only live active work uses motion, and
the existing global reduced-motion rule removes that animation without hiding
state. Attention stays in an ordered rail beside the map. Clicking a rail item
or entity opens a dense AITU drill-in sourced from the same run projection.

The AITU edge cards show activity, outcome, phase-timing, source-health, and
receipt signals already present in the operator contract. This slice adds no
new telemetry service or projection. The separate `/lugos` panel remains the
command and durable-receipt surface.

## Week-4 task loop

The `/lugos` panel now drives one bounded source-linked loop:

1. `mail.handoff` sends a normal Agent Mail message and records its source
   message/thread identity.
2. `task.approve` accepts only an existing handoff and invokes the injected
   repository artifact adapter.
3. Lugos emits a receipt for each accepted command and reconstructs the
   `lugos-task-loop/v1` projection from those private receipt records.
4. Mission Control renders handoff, approval, artifact, receipt, and replay
   state from that projection. It creates no Mission Control task or optimistic
   copy.

The command schemas are closed: there is no arbitrary mail, filesystem, shell,
or git passthrough. The proof artifact is JSON-only beneath the adapter's
configured root. Agent Mail, the repo adapter, and Lugos receipts remain the
authorities.

## Local vertical slice

Start the replayable Lugos fake from the superproject:

```powershell
cd ../lugos-hud
$env:LUGOS_OPERATOR_API_TOKEN='replace-with-at-least-16-characters'
npm run operator-api:fake
```

The default uses a deterministic fake Agent Mail sender. For an intentional
local live-mail proof, set `LUGOS_OPERATOR_AGENT_MAIL_MODE=live`, trust the
Lugos Agent Mail CA through `NODE_EXTRA_CA_CERTS`, and keep
`LUGOS_OPERATOR_ARTIFACT_ROOT` beneath an ignored local data directory.

In another PowerShell window:

```powershell
cd ../mission-control
$env:LUGOS_OPERATOR_API_URL='http://127.0.0.1:3231'
$env:LUGOS_OPERATOR_API_TOKEN='replace-with-the-same-value'
pnpm exec next dev --hostname 127.0.0.1 --port 3230
```

On macOS/Linux, use the same variable names with normal shell assignment:

```bash
LUGOS_OPERATOR_API_URL=http://127.0.0.1:3231 \
LUGOS_OPERATOR_API_TOKEN=replace-with-the-same-value \
pnpm exec next dev --hostname 127.0.0.1 --port 3230
```

Open `http://127.0.0.1:3230/setup`, create the disposable local admin, then
visit `http://127.0.0.1:3230/` for the fleet overview or `/lugos` for commands
and receipts.

This is a loopback development proof, not the reviewed production deployment
lane. Do not bind it to LAN/public interfaces or reuse its credentials.

## Verification

```powershell
pnpm test:lugos
pnpm lugos:compat
pnpm typecheck
pnpm lint
pnpm build
```

`pnpm lugos:compat` verifies that the plugin, router, navigation, and role
seams used by this patch exist in upstream v2.2.0 and v2.3.0.
