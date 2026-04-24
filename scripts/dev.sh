#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

echo "[dev] cwd: $(pwd)"
echo "[dev] node: $(node -v)"
echo "[dev] npm: $(npm -v)"

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if (( NODE_MAJOR >= 24 )); then
  echo "[dev] Node.js $(node -v) detected."
  echo "[dev] Next.js 15.2.0 in this project can hang during startup on Node 24+."
  echo "[dev] Use Node 22 LTS, then reinstall dependencies:"
  echo "[dev]   nvm install 22"
  echo "[dev]   nvm use 22"
  echo "[dev]   rm -rf node_modules .next"
  echo "[dev]   npm install"
  exit 1
fi

if [[ ! -d node_modules ]] || [[ ! -f ./node_modules/.bin/next ]]; then
  echo "Run npm install"
  exit 1
fi

echo "[dev] next: $(./node_modules/.bin/next --version)"
echo "[dev] host: 127.0.0.1"
echo "[dev] port: ${PORT:-3000}"

DEFAULT_DEV_DIST_DIR=".next-dev"
if [[ -z "${ROOMY_NEXT_DIST_DIR:-}" ]]; then
  export ROOMY_NEXT_DIST_DIR="${DEFAULT_DEV_DIST_DIR}"
fi

echo "[dev] dist dir: ${ROOMY_NEXT_DIST_DIR}"

export NODE_OPTIONS="--trace-uncaught --trace-warnings"
export NEXT_TELEMETRY_DISABLED=1

./node_modules/.bin/next dev -H 127.0.0.1 -p "${PORT:-3000}" 2>&1 | tee -a dev.log
