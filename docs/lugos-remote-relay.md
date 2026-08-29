# Lugos remote decision relay

Mission Control contains a disabled-by-default path for WEIR Batch 8. The path carries one
short-lived human approve/deny decision to a separate relay issuer; it does not send a
HUD operator command and does not make Fade or WEIR remotely reachable.

## Implemented boundaries

- `POST /api/lugos/remote-decisions` returns 404 before authentication or body parsing
  unless `MC_REMOTE_DECISIONS_ENABLED=true`.
- When enabled in tests, the route requires the `operator` role, reloads the current
  redacted WEIR projection, and binds the exact `proposal_hash`, `action_id`, and
  `work_context_hash` before requesting step-up evidence. Proposals older than the
  bounded activation window, or dated more than the frozen five-second clock skew in
  the future, fail before step-up.
- The browser request has a closed identifier-only schema. It has no parameter,
  generic payload, DOM, prompt, credential, cookie, profile, or permit field.
- Human identity comes from the authenticated numeric Mission Control user ID. The
  only implemented format is `mc:user:<id>`, and it remains unavailable until the
  operator explicitly sets `MC_REMOTE_ACTOR_FORMAT=mc-user-numeric-v1`.
- User-verifying WebAuthn passkeys run only on the configured HTTPS RP origin. Password
  reauthentication gates enrollment and recovery; challenges and exact-decision grants
  are short-lived and one-use.
- The issuer client connects only to the relay's loopback enqueue endpoint with a
  separate bearer, a five-second deadline, redirect refusal, and bounded response.

The isolated issuer library uses Node's Ed25519 implementation, an injected key
provider, and a separate SQLite database marked `remote-relay-isolated-v1`. It never
auto-generates or stores a signing key. Its append-only queue enforces unique command,
capsule, and nonce bindings; a 1,024-live-entry ceiling; bounded claim leases;
revocation; terminal acknowledgement; explicit capsule-body purge; and redacted audit
metadata. A canonical request hash makes an enqueue retry return the original signed
capsule after response loss rather than signing a second object.

The queue remains outside Mission Control's main database and Next.js process. The
standalone TLS 1.3 server maps an authenticated client-certificate fingerprint to one
exact device and transport principal. Its external surface is claim, revocation,
acknowledgement, and health only; enqueue remains loopback-only.

## Flags

All activation flags default false and are checked before side effects:

```text
MC_REMOTE_DECISIONS_ENABLED=false
MC_REMOTE_WEBAUTHN_ENABLED=false
LUGOS_RELAY_ISSUER_ENABLED=false
```

Setting one flag alone does not produce a working decision path. Repository code never
auto-generates a key, queue file, CA, device credential, or public listener.

## First activation choices

The reviewed first target uses `mc:user:<numeric-id>`, RP origin
`https://knot.newman.foo`, restricted host user `lugos-relay`, isolated state at
`/srv/lugos/state/remote-relay`, and external relay endpoint `10.0.1.33:8793`.
Only workstation source `10.0.1.30` is admitted. The P-256 client key originates and
stays on `4070pc`; the host pins its certificate to `workstation-4070pc` and
`relay-device:4070pc`. Ed25519 trust supports one to three pins during rotation.
Terminal capsule bodies are purged within five minutes while redacted audit anchors
remain durable.

The first positive policy remains the reversible synthetic public-data action only.
The host installation and rollback process is owned by the parent Lugos service at
`lugos-node/services/lugos-remote-relay/`.

## Verification

```bash
pnpm test:lugos
pnpm lint
pnpm typecheck
```
