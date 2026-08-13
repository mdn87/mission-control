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

# An unquoted inline comment must be stripped the way scripts/load-env.sh strips
# it, or the audit grades a different string than the server actually starts with.
COMMENT_ENV="$TMP_DIR/inline-comment.env"
cat > "$COMMENT_ENV" <<'EOF'
AUTH_PASS="a secure # password"
API_KEY=test-api-key
MC_ALLOWED_HOSTS=127.0.0.1,localhost
MC_COOKIE_SECURE=1
MC_COOKIE_SAMESITE=strict
MC_ENABLE_HSTS=1
MC_DISABLE_RATE_LIMIT=0
MC_PROXY_AUTH_HEADER=X-User-Email
MC_PROXY_AUTH_SECRET=short # replace this before production
EOF
chmod 600 "$COMMENT_ENV"
comment_output="$(bash "$AUDIT" --env-file "$COMMENT_ENV" || true)"
grep -Fq '[FAIL] MC_PROXY_AUTH_HEADER is set but MC_PROXY_AUTH_SECRET is missing or under 32 characters' <<< "$comment_output"
# A quoted value keeps its '#'; only unquoted values have comments stripped.
grep -Fq '[PASS] AUTH_PASS is set to a non-default value (19 chars)' <<< "$comment_output"
if bash "$AUDIT" --env-file "$COMMENT_ENV" --strict >/dev/null 2>&1; then
  echo 'Expected --strict to fail when an inline comment hides a short secret' >&2
  exit 1
fi

# A default role the runtime does not accept means no provisioning at all.
ROLE_ENV="$TMP_DIR/bad-role.env"
sed 's/^MC_PROXY_AUTH_SECRET=.*/MC_PROXY_AUTH_SECRET=0123456789abcdef0123456789abcdef/' \
  "$COMMENT_ENV" > "$ROLE_ENV"
echo 'MC_PROXY_AUTH_DEFAULT_ROLE=administrator' >> "$ROLE_ENV"
chmod 600 "$ROLE_ENV"
role_output="$(bash "$AUDIT" --env-file "$ROLE_ENV" || true)"
grep -Fq '[FAIL] MC_PROXY_AUTH_DEFAULT_ROLE=administrator is not one of viewer, operator, admin' <<< "$role_output"
if bash "$AUDIT" --env-file "$ROLE_ENV" --strict >/dev/null 2>&1; then
  echo 'Expected --strict to fail on an unsupported MC_PROXY_AUTH_DEFAULT_ROLE' >&2
  exit 1
fi

sed -i.bak '/^MC_PROXY_AUTH_DEFAULT_ROLE=/d' "$ROLE_ENV" && rm -f "$ROLE_ENV.bak"
echo 'MC_PROXY_AUTH_DEFAULT_ROLE=viewer' >> "$ROLE_ENV"
good_role_output="$(bash "$AUDIT" --env-file "$ROLE_ENV" || true)"
grep -Fq '[WARN] MC_PROXY_AUTH_DEFAULT_ROLE=viewer auto-provisions' <<< "$good_role_output"

# scripts/load-env.sh accepts `export KEY=value`; the audit must grade the same
# settings the server starts with rather than seeing none of them.
EXPORT_ENV="$TMP_DIR/exported.env"
cat > "$EXPORT_ENV" <<'EOF'
export AUTH_PASS="a secure # password"
export API_KEY=test-api-key
export MC_ALLOWED_HOSTS=127.0.0.1,localhost
export MC_COOKIE_SECURE=1
export MC_COOKIE_SAMESITE=strict
export MC_ENABLE_HSTS=1
export MC_DISABLE_RATE_LIMIT=0
export MC_PROXY_AUTH_HEADER=X-User-Email
export MC_PROXY_AUTH_SECRET=short
EOF
chmod 600 "$EXPORT_ENV"
export_output="$(bash "$AUDIT" --env-file "$EXPORT_ENV" || true)"
grep -Fq '[PASS] MC_ALLOWED_HOSTS is configured: 127.0.0.1,localhost' <<< "$export_output"
grep -Fq '[FAIL] MC_PROXY_AUTH_HEADER is set but MC_PROXY_AUTH_SECRET is missing or under 32 characters' <<< "$export_output"
if bash "$AUDIT" --env-file "$EXPORT_ENV" --strict >/dev/null 2>&1; then
  echo 'Expected --strict to fail on an export-prefixed env file with a short secret' >&2
  exit 1
fi

# An invalid header name breaks every auth path at runtime, so it is a finding.
BAD_HEADER_ENV="$TMP_DIR/bad-header.env"
sed 's/^export MC_PROXY_AUTH_HEADER=.*/export MC_PROXY_AUTH_HEADER=X User/; s/^export MC_PROXY_AUTH_SECRET=.*/export MC_PROXY_AUTH_SECRET=0123456789abcdef0123456789abcdef/' \
  "$EXPORT_ENV" > "$BAD_HEADER_ENV"
chmod 600 "$BAD_HEADER_ENV"
bad_header_output="$(bash "$AUDIT" --env-file "$BAD_HEADER_ENV" || true)"
grep -Fq '[FAIL] MC_PROXY_AUTH_HEADER=X User is not a valid HTTP header name' <<< "$bad_header_output"
if bash "$AUDIT" --env-file "$BAD_HEADER_ENV" --strict >/dev/null 2>&1; then
  echo 'Expected --strict to fail on an invalid MC_PROXY_AUTH_HEADER' >&2
  exit 1
fi

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
