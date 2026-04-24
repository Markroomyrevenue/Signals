#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

if [[ ! -d node_modules ]] || [[ ! -f ./node_modules/.bin/next ]]; then
  echo "Run npm install"
  exit 1
fi

PORT="${PORT:-3000}"

if [[ ! -f .next/BUILD_ID ]]; then
  echo "[start:prod] valid build output not found; running clean build..."
  npm run build
fi

echo "[start:prod] host: 127.0.0.1"
echo "[start:prod] port: ${PORT}"

./node_modules/.bin/next start -H 127.0.0.1 -p "${PORT}"
