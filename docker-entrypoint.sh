#!/bin/sh
set -e

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

printf '[entrypoint] Starting server\n'
exec node server.js
