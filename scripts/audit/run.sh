#!/usr/bin/env bash
# Audit harness runner — PROD, READ-ONLY.
# Prod DATABASE_URL + API_ENCRYPTION_KEY are exported here (so they take
# precedence), then .env is loaded via node --env-file for the remaining
# non-secret app vars. node --env-file does NOT override already-set vars.
#
# Usage:  bash scripts/audit/run.sh scripts/audit/<script>.ts [args...]
set -euo pipefail

REPO="/Users/markmccracken/Documents/signals"
SCRATCH="/private/tmp/claude-501/-Users-markmccracken-Documents-signals/2fb77a7b-d5a9-4f51-b197-f092c4606a27/scratchpad"
AUDIT_ENV="$SCRATCH/.audit-env"

cd "$REPO"

# shellcheck disable=SC1090
. "$AUDIT_ENV"
export DATABASE_URL="$AUDIT_DATABASE_URL"
export API_ENCRYPTION_KEY="$API_ENCRYPTION_KEY"
export DATA_MODE="live"
export AUDIT_READONLY="1"

case "$DATABASE_URL" in
  *rlwy.net*|*railway*) : ;;
  *) echo "REFUSING: DATABASE_URL is not a Railway prod host" >&2; exit 2 ;;
esac

exec node --env-file=.env --import tsx "$@"
