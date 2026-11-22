# Mission Control deployment in this fork

This fork runs credentialed services through GLAS with Bitwarden Secrets Manager
(BWS) references. GitHub issues its own short lived `GITHUB_TOKEN` to Actions.
The local installers do not create passwords, API keys, or credential files.

## Prepare GLAS

Install GLAS with its Bitwarden support for the account that launches the service.
Set `GLAS_PYTHON` to that Python interpreter, `GLAS_ROOT` if using a source
checkout, and `GLAS_HOME` to the selected native credential profile's inventory.
The profile must be able to read every BWS entry referenced by the manifest.

Copy `config/glas.example.json` to the ignored `config/glas.local.json` and
replace the placeholder secret IDs with the IDs `glas add` printed. At minimum map
separate BWS entries to `AUTH_SECRET` and `API_KEY`. Existing installations should
reuse the current values while migrating so sessions and agent clients continue to
work. Map `LUGOS_OPERATOR_API_TOKEN` when the operator integration is enabled,
`GITHUB_TOKEN` for issue sync, and `OPENCLAW_GATEWAY_TOKEN` for gateway access.
Do not place secret values in the manifest. `glas validate` checks reference
syntax without reading secret values.

## Start locally

Node.js 22 or newer, pnpm, Python, and the GLAS runtime are required:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

`pnpm dev` and `pnpm start` use `scripts/with-glas.py`. The standalone path is
`pnpm start:standalone`; `scripts/deploy-standalone.sh` also starts through GLAS.
The Windows and Unix installers require the manifest and `GLAS_HOME` before
starting the server. Set the nonsecret `PORT` as needed. Create the initial admin
account at `/setup` after the service starts.

For the CLI, TUI, and MCP client, copy `config/glas.cli.example.json` to the
ignored `config/glas.cli.local.json`; it binds the same BWS entry as `API_KEY` to
`MC_API_KEY`.
`scripts/with-glas.py --exec node scripts/mc-cli.cjs ...` selects that manifest.
Legacy profiles may still select a nonsecret URL, but their API key and cookie
fields are ignored. CLI login and command-line API key flags are disabled.

Hermes is a separate runtime. If its onboarding wizard uses an API key, put that
provider key in BWS and launch Hermes through its own GLAS manifest that binds
the provider's expected name (for example, `ANTHROPIC_API_KEY`). The wizard
does not accept or store provider keys; its old `set-env` API action is rejected.
Device authorization remains available for providers that support it.

## Docker

Start the container with `pnpm docker:up` (or `bash install.sh --docker`,
`.\install.ps1 -Mode docker`). These run `scripts/docker-up.cjs` under GLAS
with `config/glas.local.json`. The script runs
`docker compose up -d --build --force-recreate` without the credentials, then
writes each credential the manifest maps into the container's `/tmp` tmpfs
through `docker exec` standard input. The entry point waits up to 60 seconds for
that delivery, loads the values into the server process, and deletes the files.
`docker-compose.yml` lists no credential names, so the values never appear in
the container configuration shown by `docker inspect` or stored under
`/var/lib/docker`. The entry point still refuses to start when `AUTH_SECRET` or
`API_KEY` is missing and never generates credentials.

Docker access on the host is still root-equivalent: anyone in the `docker`
group can `docker exec` into the container and read the server's environment.

The credentials live only in the running container's memory. A container
restart (crash, `docker compose restart`, or host reboot) starts without them,
and the entry point exits after its wait; `restart: unless-stopped` then keeps
retrying. Run `pnpm docker:up` again to recover, and after changing a value in
BWS. Extra arguments are Compose options placed before `up`, so the hardened
overlay is
`node scripts/launch-glas.cjs --exec node scripts/docker-up.cjs -f docker-compose.yml -f docker-compose.hardened.yml`.

## Other service identities

The tenant gateway template uses a separate GLAS manifest and encrypted systemd
machine-account credential for each tenant. Its runtime JSON selects the
manifest, GLAS inventory, and fixed gateway command. Grant each machine account
only its tenant's BWS references before enabling that unit. Set the gateway
port in OpenClaw's nonsecret configuration. Automated tenant bootstrap is
disabled until per-tenant machine-account enrollment and manifest provisioning
are implemented; the old provisioner cannot create a gateway `.env` file.

The optional remote decision relay uses `LUGOS_RELAY_INTERNAL_TOKEN` from its
own BWS manifest. It accepts `LUGOS_RELAY_TLS_KEY_PEM` and
`LUGOS_RELAY_SIGNING_KEY_PEM` as GLAS injected private keys in memory. The
older private-key file-path options are rejected. The TLS
certificate, client CA, device list, and SQLite database remain files because
they are public trust anchors or application state. The relay stays disabled
until its separate service and workstation keys are provisioned and verified.

## Retire old sources

After a GLAS launched process has been verified with the same credentials,
remove the old local credential copies and persistent Windows environment
entries. Restart affected services so they no longer inherit the old values.
Deleting old credentials or rotating them is a separate irreversible step.
