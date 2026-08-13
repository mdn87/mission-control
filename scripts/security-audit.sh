#!/usr/bin/env bash
# Mission Control Security Audit
# Run: bash scripts/security-audit.sh [--env-file .env] [--strict]

set -euo pipefail

SCORE=0
MAX_SCORE=0
ISSUES=()

pass() { echo "  [PASS] $1"; ((++SCORE)); ((++MAX_SCORE)); }
fail() { echo "  [FAIL] $1"; ISSUES+=("$1"); ((++MAX_SCORE)); }
warn() { echo "  [WARN] $1"; ((++MAX_SCORE)); }
info() { echo "  [INFO] $1"; }

# Parse only the settings this audit reads. Never source an env file or import
# arbitrary names: values such as PATH, BASH_ENV, or command hooks must not be
# able to change how the audit itself executes.
ENV_FILE=".env"
STRICT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)
      [[ $# -ge 2 ]] || { echo "Missing value for --env-file" >&2; exit 2; }
      ENV_FILE="$2"
      shift 2
      ;;
    --strict)
      STRICT=1
      shift
      ;;
    --help|-h)
      echo "Usage: bash scripts/security-audit.sh [--env-file FILE] [--strict]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

# Read the env file through scripts/load-env.sh's own parser rather than a
# second implementation. The audit exists to report what the server will
# actually run with, so any divergence here is a false report: a private copy
# previously missed inline comments and then `export ` prefixes, certifying
# settings the server never saw.
#
# Sourcing the loader only defines functions. The env file itself is still never
# evaluated — values reach this script as handler arguments, so PATH, BASH_ENV,
# or command hooks in it cannot change how the audit executes.
AUDIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./load-env.sh
. "$AUDIT_DIR/load-env.sh"

# Capture only the settings this audit reads; everything else is discarded.
mc_audit_capture() {
  case "$1" in
    AUTH_PASS) AUTH_PASS="$2" ;;
    API_KEY) API_KEY="$2" ;;
    MC_ALLOWED_HOSTS) MC_ALLOWED_HOSTS="$2" ;;
    MC_ALLOW_ANY_HOST) MC_ALLOW_ANY_HOST="$2" ;;
    MC_COOKIE_SECURE) MC_COOKIE_SECURE="$2" ;;
    MC_COOKIE_SAMESITE) MC_COOKIE_SAMESITE="$2" ;;
    MC_ENABLE_HSTS) MC_ENABLE_HSTS="$2" ;;
    MC_DISABLE_RATE_LIMIT) MC_DISABLE_RATE_LIMIT="$2" ;;
    MC_PROXY_AUTH_HEADER) MC_PROXY_AUTH_HEADER="$2" ;;
    MC_PROXY_AUTH_SECRET) MC_PROXY_AUTH_SECRET="$2" ;;
    MC_PROXY_AUTH_TRUSTED_IPS) MC_PROXY_AUTH_TRUSTED_IPS="$2" ;;
    MC_PROXY_AUTH_DEFAULT_ROLE) MC_PROXY_AUTH_DEFAULT_ROLE="$2" ;;
  esac
}

# A file the loader rejects is one the server cannot start with, so refusing to
# grade it is more useful than grading the lines that happened to parse.
if ! mc_env_parse_file "$ENV_FILE" mc_audit_capture; then
  echo "  [FAIL] $ENV_FILE cannot be parsed by scripts/load-env.sh; the server will not start with it" >&2
  exit 2
fi

echo "=== Mission Control Security Audit ==="
echo ""

# 1. .env file permissions
echo "--- File Permissions ---"
if [[ -f "$ENV_FILE" ]]; then
  if perms=$(stat -c '%a' -- "$ENV_FILE" 2>/dev/null); then
    : # GNU stat
  elif perms=$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null); then
    : # BSD stat
  else
    perms="unknown"
  fi
  if [[ "$perms" == "600" ]]; then
    pass ".env permissions are 600 (owner read/write only)"
  else
    fail ".env permissions are $perms (should be 600). Run: chmod 600 $ENV_FILE"
  fi
else
  warn ".env file not found at $ENV_FILE"
fi

# 2. Default passwords check
echo ""
echo "--- Credentials ---"
INSECURE_PASSWORDS=("admin" "password" "change-me-on-first-login" "changeme" "testpass123" "testpass1234")
AUTH_PASS_VAL="${AUTH_PASS:-}"
if [[ -z "$AUTH_PASS_VAL" ]]; then
  fail "AUTH_PASS is not set"
else
  insecure=false
  for bad in "${INSECURE_PASSWORDS[@]}"; do
    if [[ "$AUTH_PASS_VAL" == "$bad" ]]; then
      insecure=true; break
    fi
  done
  if $insecure; then
    fail "AUTH_PASS is set to a known insecure default"
  elif [[ ${#AUTH_PASS_VAL} -lt 12 ]]; then
    fail "AUTH_PASS is too short (${#AUTH_PASS_VAL} chars, minimum 12)"
  else
    pass "AUTH_PASS is set to a non-default value (${#AUTH_PASS_VAL} chars)"
  fi
fi

API_KEY_VAL="${API_KEY:-}"
if [[ -z "$API_KEY_VAL" || "$API_KEY_VAL" == "generate-a-random-key" ]]; then
  fail "API_KEY is not set or uses the default value"
else
  pass "API_KEY is configured"
fi

# 3. Network config
echo ""
echo "--- Network Security ---"
MC_ALLOWED="${MC_ALLOWED_HOSTS:-}"
MC_ANY="${MC_ALLOW_ANY_HOST:-}"
if [[ "$MC_ANY" == "1" || "$MC_ANY" == "true" ]]; then
  fail "MC_ALLOW_ANY_HOST is enabled (any host can connect)"
elif [[ -n "$MC_ALLOWED" ]]; then
  pass "MC_ALLOWED_HOSTS is configured: $MC_ALLOWED"
else
  fail "MC_ALLOWED_HOSTS is not set (production serves only localhost/::1/hostname; every other host gets 403)"
fi

# 3b. Trusted reverse proxy authentication
# src/lib/auth.ts trims the header name and the default role but NOT the secret,
# so a quoted value with surrounding whitespace works at runtime. Match that
# exactly, or the audit reports a failure for a configuration that runs fine.
trim_ws() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  printf '%s' "${value%"${value##*[![:space:]]}"}"
}
PROXY_HEADER="$(trim_ws "${MC_PROXY_AUTH_HEADER:-}")"
PROXY_SECRET="${MC_PROXY_AUTH_SECRET:-}"
PROXY_TRUSTED="${MC_PROXY_AUTH_TRUSTED_IPS:-}"
PROXY_DEFAULT_ROLE="$(trim_ws "${MC_PROXY_AUTH_DEFAULT_ROLE:-}")"
if [[ -z "$PROXY_HEADER" ]]; then
  info "MC_PROXY_AUTH_HEADER is not set (header-based proxy auth disabled)"
else
  # An invalid field name makes Headers.get() throw for every request, taking
  # session and API-key auth down with it, so this is not merely cosmetic.
  PROXY_HEADER_PATTERN='^[A-Za-z0-9!#$%&'"'"'*+.^_`|~-]+$'
  if [[ ! "$PROXY_HEADER" =~ $PROXY_HEADER_PATTERN ]]; then
    fail "MC_PROXY_AUTH_HEADER=$PROXY_HEADER is not a valid HTTP header name (proxy auth disabled)"
  elif [[ "${PROXY_HEADER,,}" == "x-mc-proxy-secret" ]]; then
    fail "MC_PROXY_AUTH_HEADER must not be X-MC-Proxy-Secret (identity would resolve to the secret itself; proxy auth disabled)"
  fi

  # The .env.example placeholder is 42 characters, so a length-only check would
  # certify a secret that is published in the repository.
  if [[ "$PROXY_SECRET" == "replace-with-at-least-32-random-characters" ]]; then
    fail "MC_PROXY_AUTH_SECRET is still the .env.example placeholder (public value; proxy auth disabled)"
  elif [[ ${#PROXY_SECRET} -ge 32 ]]; then
    pass "MC_PROXY_AUTH_SECRET is at least 32 characters"
  else
    fail "MC_PROXY_AUTH_HEADER is set but MC_PROXY_AUTH_SECRET is missing or under 32 characters (proxy auth disabled)"
  fi
  if [[ -n "$PROXY_TRUSTED" ]]; then
    warn "MC_PROXY_AUTH_TRUSTED_IPS is set but no longer used; the app cannot identify the proxy hop from headers (see SECURITY.md)"
  fi
  # resolveOrProvisionProxyUser accepts only these three and otherwise refuses to
  # provision, so a typo here silently means "no auto-provisioning" rather than
  # what the setting appears to say.
  case "$PROXY_DEFAULT_ROLE" in
    "") ;;
    viewer|operator|admin)
      warn "MC_PROXY_AUTH_DEFAULT_ROLE=$PROXY_DEFAULT_ROLE auto-provisions accounts for unknown proxy identities"
      ;;
    *)
      fail "MC_PROXY_AUTH_DEFAULT_ROLE=$PROXY_DEFAULT_ROLE is not one of viewer, operator, admin (unknown identities will be refused, not provisioned)"
      ;;
  esac
  # Neither can be checked from here — one lives in the reverse proxy config and
  # the other in the network layer — but the secret is the only credential, so
  # these two controls are what the scheme actually rests on. Always say them.
  info "Verify the proxy strips client-supplied $PROXY_HEADER and X-MC-Proxy-Secret headers before injecting its own"
  info "Verify the app is not reachable except through that proxy (bound to loopback or an internal network)"
fi

# 4. Cookie/HTTPS config
echo ""
echo "--- HTTPS & Cookies ---"
COOKIE_SECURE="${MC_COOKIE_SECURE:-}"
if [[ "$COOKIE_SECURE" == "1" || "$COOKIE_SECURE" == "true" ]]; then
  pass "MC_COOKIE_SECURE is enabled"
else
  warn "MC_COOKIE_SECURE is not enabled (cookies sent over HTTP)"
fi

SAMESITE="${MC_COOKIE_SAMESITE:-strict}"
if [[ "$SAMESITE" == "strict" ]]; then
  pass "MC_COOKIE_SAMESITE is strict"
else
  warn "MC_COOKIE_SAMESITE is '$SAMESITE' (strict recommended)"
fi

HSTS="${MC_ENABLE_HSTS:-}"
if [[ "$HSTS" == "1" ]]; then
  pass "HSTS is enabled"
else
  warn "HSTS is not enabled (set MC_ENABLE_HSTS=1 for HTTPS deployments)"
fi

# 5. Rate limiting
echo ""
echo "--- Rate Limiting ---"
RL_DISABLED="${MC_DISABLE_RATE_LIMIT:-}"
if [[ "$RL_DISABLED" == "1" ]]; then
  fail "Rate limiting is disabled (MC_DISABLE_RATE_LIMIT=1)"
else
  pass "Rate limiting is active"
fi

# 6. Docker security (if running in Docker)
echo ""
echo "--- Docker Security ---"
if command -v docker &>/dev/null; then
  if docker ps --filter name=mission-control --format '{{.Names}}' 2>/dev/null | grep -q mission-control; then
    ro=$(docker inspect mission-control --format '{{.HostConfig.ReadonlyRootfs}}' 2>/dev/null || echo "false")
    if [[ "$ro" == "true" ]]; then
      pass "Container filesystem is read-only"
    else
      warn "Container filesystem is writable (use read_only: true)"
    fi

    nnp=$(docker inspect mission-control --format '{{.HostConfig.SecurityOpt}}' 2>/dev/null || echo "[]")
    if echo "$nnp" | grep -q "no-new-privileges"; then
      pass "no-new-privileges is set"
    else
      warn "no-new-privileges not set"
    fi

    user=$(docker inspect mission-control --format '{{.Config.User}}' 2>/dev/null || echo "")
    if [[ -n "$user" && "$user" != "root" && "$user" != "0" ]]; then
      pass "Container runs as non-root user ($user)"
    else
      warn "Container may be running as root"
    fi
  else
    info "Mission Control container not running"
  fi
else
  info "Docker not installed (skipping container checks)"
fi

# Summary
echo ""
echo "=== Security Score: $SCORE / $MAX_SCORE ==="
if [[ ${#ISSUES[@]} -gt 0 ]]; then
  echo ""
  echo "Issues to fix:"
  for issue in "${ISSUES[@]}"; do
    echo "  - $issue"
  done
fi

if [[ $SCORE -eq $MAX_SCORE ]]; then
  echo "All checks passed!"
elif [[ $SCORE -ge $((MAX_SCORE * 7 / 10)) ]]; then
  echo "Good security posture with minor improvements needed."
else
  echo "Security improvements recommended before production use."
fi

if [[ "$STRICT" == "1" && ${#ISSUES[@]} -gt 0 ]]; then
  exit 1
fi
