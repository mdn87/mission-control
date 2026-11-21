#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' 'Mission Control no longer writes credential files. Add AUTH_SECRET, API_KEY, and other required credentials to BWS and bind them in config/glas.local.json.' >&2
exit 1
