#!/usr/bin/env bash
# Supervised npm worker — auto-restarts on exit.
#
# Use this as the trial-close-period worker entry point so a transient
# crash doesn't pause the 06:00 BST scheduler or the daily snapshot job.
# Stop with: pkill -f 'bash scripts/worker-supervised.sh' && pkill -f 'tsx.*workers'
set -uo pipefail
cd "$(dirname "$0")/.."
while true; do
  echo "[supervisor] starting worker at $(date)" | tee -a worker.log
  npm run worker >> worker.log 2>&1
  EXIT=$?
  echo "[supervisor] worker exited with code $EXIT at $(date) — restarting in 30s" | tee -a worker.log
  sleep 30
done
