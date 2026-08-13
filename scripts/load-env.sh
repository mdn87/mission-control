#!/bin/sh

# Load dotenv-style KEY=VALUE assignments without evaluating shell syntax.
# This file is sourced by both POSIX sh and Bash startup scripts.

trim_env_field() {
  printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

# Parse a dotenv-style file, handing each assignment to a named handler as
# `handler KEY VALUE`. A non-zero handler status aborts the parse.
#
# Exposed separately from load_env_file so anything that needs to know what the
# server will actually load reads the file through these exact rules rather than
# reimplementing them. scripts/security-audit.sh had its own copy and drifted
# twice — first missing inline comments, then `export ` prefixes — each time
# grading settings the server never saw.
mc_env_parse_file() {
  mc_env_file="$1"
  mc_env_handler="$2"
  [ -f "$mc_env_file" ] || return 0

  mc_env_line_number=0
  while IFS= read -r mc_env_line || [ -n "$mc_env_line" ]; do
    mc_env_line_number=$((mc_env_line_number + 1))
    mc_env_line=$(printf '%s' "$mc_env_line" | sed 's/\r$//')
    mc_env_line=$(trim_env_field "$mc_env_line")

    case "$mc_env_line" in
      ''|'#'*) continue ;;
      export[[:space:]]*) mc_env_line=$(trim_env_field "${mc_env_line#export}") ;;
    esac

    case "$mc_env_line" in
      *=*) ;;
      *)
        printf 'error: invalid env assignment in %s at line %s\n' "$mc_env_file" "$mc_env_line_number" >&2
        return 1
        ;;
    esac

    mc_env_key=$(trim_env_field "${mc_env_line%%=*}")
    mc_env_value=$(trim_env_field "${mc_env_line#*=}")

    case "$mc_env_key" in
      ''|[0-9]*|*[!A-Za-z0-9_]*)
        printf 'error: invalid env name in %s at line %s\n' "$mc_env_file" "$mc_env_line_number" >&2
        return 1
        ;;
    esac

    case "$mc_env_value" in
      \"*\") mc_env_value=${mc_env_value#\"}; mc_env_value=${mc_env_value%\"} ;;
      \'*\') mc_env_value=${mc_env_value#\'}; mc_env_value=${mc_env_value%\'} ;;
      \"*|*\"|\'*|*\')
        printf 'error: unmatched quote in %s at line %s\n' "$mc_env_file" "$mc_env_line_number" >&2
        return 1
        ;;
      *)
        mc_env_value=$(printf '%s' "$mc_env_value" | sed 's/[[:space:]]#.*$//')
        mc_env_value=$(trim_env_field "$mc_env_value")
        ;;
    esac

    "$mc_env_handler" "$mc_env_key" "$mc_env_value" || return 1
  done < "$mc_env_file"
}

# Reject names that would change how this process or its children execute.
# Enforced here rather than in the parser because it is specific to exporting:
# a reader that only inspects values has no reason to refuse the file.
mc_env_export_handler() {
  case "$1" in
    mc_env_*|MC_ENV_LOADER_*|PATH|IFS|ENV|BASH_ENV|BASHOPTS|SHELLOPTS|CDPATH|GLOBIGNORE|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PERL5OPT|RUBYOPT|LD_*|DYLD_*)
      printf 'error: unsafe process-control env name: %s\n' "$1" >&2
      return 1
      ;;
  esac
  export "$1=$2"
}

load_env_file() {
  mc_env_parse_file "$1" mc_env_export_handler
}
