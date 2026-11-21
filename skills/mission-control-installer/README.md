# Mission Control Installer Skill

Install and configure Mission Control on any Linux or macOS system.

## What This Skill Does

1. Detects the target OS and Node.js 22+
2. Clones or updates the Mission Control repository
3. Requires a GLAS native profile and ignored BWS reference manifest
4. Starts the dashboard locally through GLAS
5. Runs an OpenClaw fleet health check (cleans stale PIDs, old logs, validates gateway)
6. Prints the access URL without disclosing credentials

## Usage

Run the installer script:

```bash
# Local deployment
bash install.sh

# Explicit local deployment (Node.js + pnpm)
bash install.sh --local

# Custom port
bash install.sh --port 8080

# Skip OpenClaw fleet check
bash install.sh --skip-openclaw
```

Or as a one-liner:

```bash
git clone https://github.com/mdn87/mission-control.git
cd mission-control
MC_INSTALL_DIR="$PWD" bash install.sh --local
```

## Prerequisites

- Node.js 22+, pnpm, Python 3 and GLAS with BWS access
- git (to clone the repository)
- An ignored `config/glas.local.json` manifest binding `AUTH_SECRET` and `API_KEY`

## Post-Install

After installation:

1. Open `http://localhost:3000` (or your configured port)
2. Log in using an admin account created during setup; credentials are never printed by the installer
3. Configure your OpenClaw gateway connection in Settings
4. Register agents via the Agents panel

## Credential configuration

Store `AUTH_SECRET`, `API_KEY`, and any configured admin password in BWS. Bind
only the names needed by this service in `config/glas.local.json`. Keep that
reference manifest out of git; it contains IDs, not secret values. See
`docs/deployment.md` for the service identity and launch steps.
