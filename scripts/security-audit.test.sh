#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUDIT="$ROOT_DIR/scripts/security-audit.sh"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mc-security-audit.XXXXXX")"
HARDENED_ENV="$TMP_DIR/hardened.env"
INSECURE_ENV="$TMP_DIR/insecure.env"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat > "$HARDENED_ENV" <<'EOF'
PATH=/definitely/not/a/real/path
BASH_ENV=/tmp/should-not-be-loaded
AUTH_PASS="a secure # password"
API_KEY=test-api-key
MC_ALLOWED_HOSTS=127.0.0.1,localhost
MC_ALLOW_ANY_HOST=0
MC_COOKIE_SECURE=1
MC_COOKIE_SAMESITE=strict
MC_ENABLE_HSTS=1
MC_DISABLE_RATE_LIMIT=0
EOF
chmod 600 "$HARDENED_ENV"

output="$(bash "$AUDIT" --env-file "$HARDENED_ENV" --strict)"
grep -Fq '[PASS] AUTH_PASS is set to a non-default value (19 chars)' <<< "$output"
grep -Fq '=== Security Score: 8 / 8 ===' <<< "$output"
grep -Fq 'All checks passed!' <<< "$output"

cat > "$INSECURE_ENV" <<'EOF'
AUTH_PASS=password
API_KEY=generate-a-random-key
MC_ALLOW_ANY_HOST=1
MC_DISABLE_RATE_LIMIT=1
EOF
chmod 600 "$INSECURE_ENV"

if bash "$AUDIT" --env-file "$INSECURE_ENV" --strict >/dev/null 2>&1; then
  echo 'Expected --strict to fail when the audit reports security findings' >&2
  exit 1
fi

if bash "$AUDIT" --unknown >/dev/null 2>&1; then
  echo 'Expected an unknown option to fail' >&2
  exit 1
fi

PROXY_ENV="$TMP_DIR/proxy.env"
cat > "$PROXY_ENV" <<'EOF'
AUTH_PASS="a secure # password"
API_KEY=test-api-key
MC_ALLOWED_HOSTS=127.0.0.1,localhost
MC_ALLOW_ANY_HOST=0
MC_COOKIE_SECURE=1
MC_COOKIE_SAMESITE=strict
MC_ENABLE_HSTS=1
MC_DISABLE_RATE_LIMIT=0
MC_PROXY_AUTH_HEADER=X-User-Email
EOF
chmod 600 "$PROXY_ENV"

# Proxy auth enabled without its required secret is a finding, not a warning.
proxy_output="$(bash "$AUDIT" --env-file "$PROXY_ENV" || true)"
grep -Fq '[FAIL] MC_PROXY_AUTH_HEADER is set but MC_PROXY_AUTH_SECRET is missing or under 32 characters' <<< "$proxy_output"
grep -Fq 'Verify the proxy strips client-supplied X-User-Email' <<< "$proxy_output"
grep -Fq 'Verify the app is not reachable except through that proxy' <<< "$proxy_output"

if bash "$AUDIT" --env-file "$PROXY_ENV" --strict >/dev/null 2>&1; then
  echo 'Expected --strict to fail when proxy auth is half-configured' >&2
  exit 1
fi

# The shipped placeholder clears the length rule but is public.
cat >> "$PROXY_ENV" <<'EOF'
MC_PROXY_AUTH_SECRET=replace-with-at-least-32-random-characters
EOF
placeholder_output="$(bash "$AUDIT" --env-file "$PROXY_ENV" || true)"
grep -Fq '[FAIL] MC_PROXY_AUTH_SECRET is still the .env.example placeholder' <<< "$placeholder_output"
if bash "$AUDIT" --env-file "$PROXY_ENV" --strict >/dev/null 2>&1; then
  echo 'Expected --strict to fail when MC_PROXY_AUTH_SECRET is the shipped placeholder' >&2
  exit 1
fi

sed -i.bak '/^MC_PROXY_AUTH_SECRET=/d' "$PROXY_ENV" && rm -f "$PROXY_ENV.bak"
cat >> "$PROXY_ENV" <<'EOF'
MC_PROXY_AUTH_SECRET=0123456789abcdef0123456789abcdef
EOF

proxy_output="$(bash "$AUDIT" --env-file "$PROXY_ENV" --strict)"
grep -Fq '[PASS] MC_PROXY_AUTH_SECRET is at least 32 characters' <<< "$proxy_output"

# The retired setting must be called out rather than silently ignored.
echo 'MC_PROXY_AUTH_TRUSTED_IPS=127.0.0.1' >> "$PROXY_ENV"
retired_output="$(bash "$AUDIT" --env-file "$PROXY_ENV")"
grep -Fq '[WARN] MC_PROXY_AUTH_TRUSTED_IPS is set but no longer used' <<< "$retired_output"

# MC_ALLOWED_HOSTS omitted is now a finding, since host checking fails closed.
NO_HOSTS_ENV="$TMP_DIR/no-hosts.env"
cat > "$NO_HOSTS_ENV" <<'EOF'
AUTH_PASS="a secure # password"
API_KEY=test-api-key
MC_COOKIE_SECURE=1
MC_COOKIE_SAMESITE=strict
MC_ENABLE_HSTS=1
MC_DISABLE_RATE_LIMIT=0
EOF
chmod 600 "$NO_HOSTS_ENV"

if bash "$AUDIT" --env-file "$NO_HOSTS_ENV" --strict >/dev/null 2>&1; then
  echo 'Expected --strict to fail when MC_ALLOWED_HOSTS is unset' >&2
  exit 1
fi

echo 'security-audit tests passed'
