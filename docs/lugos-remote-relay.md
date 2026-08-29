# Lugos remote decision relay

Mission Control contains a disabled source path for WEIR Batch 8. The path carries one
short-lived human approve/deny decision to a separate relay issuer; it does not send a
HUD operator command and does not make Fade or WEIR remotely reachable.

## Implemented source boundaries

- `POST /api/lugos/remote-decisions` returns 404 before authentication or body parsing
  unless `MC_REMOTE_DECISIONS_ENABLED=true`.
- When enabled in tests, the route requires the `operator` role, reloads the current
  redacted WEIR projection, and binds the exact `proposal_hash`, `action_id`, and
  `work_context_hash` before requesting step-up evidence.
- The browser request has a closed identifier-only schema. It has no parameter,
  generic payload, DOM, prompt, credential, cookie, profile, or permit field.
- Human identity comes from the authenticated numeric Mission Control user ID. The
  only implemented format is `mc:user:<id>`, and it remains unavailable until the
  operator explicitly sets `MC_REMOTE_ACTOR_FORMAT=mc-user-numeric-v1`.
- The WebAuthn/passkey provider and issuer client intentionally throw unavailable
  errors. Selecting their identity provider, enrollment/recovery owner, hostname,
  CA, and mTLS lifecycle remains an activation decision.

The isolated issuer library uses Node's Ed25519 implementation, an injected key
provider, and a separate SQLite database marked `remote-relay-isolated-v1`. It never
auto-generates or stores a signing key. Its append-only queue enforces unique command,
capsule, and nonce bindings; a 1,024-live-entry ceiling; bounded claim leases;
revocation; terminal acknowledgement; explicit capsule-body purge; and redacted audit
metadata. A canonical request hash makes an enqueue retry return the original signed
capsule after response loss rather than signing a second object.

This library is not connected to Mission Control's main database, Next.js process, or
a network listener. Tests use an in-memory isolated database only.

## Flags

Both flags default false and are checked before side effects:

```text
MC_REMOTE_DECISIONS_ENABLED=false
LUGOS_RELAY_ISSUER_ENABLED=false
```

Setting either flag alone does not produce a working route. The default step-up and
issuer clients still fail closed, and no key, queue file, CA, device credential, or
listener is provisioned by this repository.

## Remaining activation work

Before a positive remote canary, choose and independently review:

1. the deployed WebAuthn/passkey provider and account recovery owner;
2. whether `mc:user:<numeric-id>` is the stable actor format;
3. the standalone issuer process owner and isolated database path;
4. signer-key custody, overlap rotation, and emergency revocation;
5. the relay hostname, CA, mTLS device enrollment, and device revocation;
6. the exact terminal capsule-body purge deadline and audit retention; and
7. the authenticated outbound pull server and workstation protocol.

The first positive policy remains the reversible synthetic public-data action only.

## Verification

```bash
pnpm test:lugos
pnpm lint
pnpm typecheck
```
