#!/bin/sh
set -e

# `pnpm docker:up` writes GLAS-supplied credentials into this tmpfs directory
# after the container starts, so they never appear in the container
# configuration. They are loaded into this process only and the files removed.
dir=${MC_CREDENTIALS_DIR:-/tmp/mc-credentials}
if [ -z "${AUTH_SECRET:-}" ] || [ -z "${API_KEY:-}" ]; then
  waited=0
  while [ ! -f "$dir/.ready" ]; do
    if [ "$waited" -ge "${MC_CREDENTIALS_WAIT:-60}" ]; then
      printf '[entrypoint] credentials were not delivered; start with pnpm docker:up\n' >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  for file in "$dir"/*; do
    [ -f "$file" ] || continue
    name=${file##*/}
    case "$name" in
      [!A-Za-z_]*|*[!A-Za-z0-9_]*) continue ;;
    esac
    value=$(cat "$file"; printf x)
    export "$name=${value%x}"
    rm -f "$file"
  done
  rm -f "$dir/.ready"
  unset file name value
fi

for name in AUTH_SECRET API_KEY; do
  case "$name" in
    AUTH_SECRET) value=${AUTH_SECRET:-} ;;
    API_KEY) value=${API_KEY:-} ;;
  esac
  if [ -z "$value" ] || [ "$value" = "random-secret-for-legacy-cookies" ] || [ "$value" = "generate-a-random-key" ]; then
    printf '[entrypoint] %s must be supplied by a GLAS-backed deployment\n' "$name" >&2
    exit 1
  fi
done
unset value

printf '[entrypoint] Starting server\n'
exec node server.js
