#!/bin/zsh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
"${PROJECT_DIR}/scripts/start-signals-background.sh"
echo
echo "Press Return to close this window."
read -r
exit 0
