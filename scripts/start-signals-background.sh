#!/usr/bin/env zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

WEB_PID_FILE="${REPO_ROOT}/.signals-web.pid"
WORKER_PID_FILE="${REPO_ROOT}/.signals-worker.pid"
LAUNCHER_LOG="${REPO_ROOT}/.signals-launcher.log"
STOP_SCRIPT="${SCRIPT_DIR}/stop-signals-background.sh"
DEV_DIST_DIR="${ROOMY_NEXT_DIST_DIR:-.next-dev}"

APP_PORT="${PORT:-3000}"
if [[ -f "${REPO_ROOT}/.env" ]]; then
  ENV_PORT="$(sed -nE 's/^PORT="?([0-9]+)"?$/\1/p' "${REPO_ROOT}/.env" | tail -n 1)"
  if [[ -n "${ENV_PORT:-}" ]]; then
    APP_PORT="${ENV_PORT}"
  fi
fi

APP_URL="http://127.0.0.1:${APP_PORT}/login"
WAIT_TIMEOUT_SECONDS="${SIGNALS_WAIT_TIMEOUT_SECONDS:-90}"

ensure_node_22() {
  if [[ ! -s "${HOME}/.nvm/nvm.sh" ]]; then
    echo "nvm was not found at ${HOME}/.nvm/nvm.sh. This launcher expects Node 22 via nvm." >&2
    exit 1
  fi

  # shellcheck source=/dev/null
  . "${HOME}/.nvm/nvm.sh"
  nvm use 22 >/dev/null
}

is_pid_running() {
  local pid="$1"
  [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1
}

read_pid_file() {
  local pid_file="$1"
  if [[ -f "${pid_file}" ]]; then
    tr -d '[:space:]' < "${pid_file}"
  fi
}

web_app_is_running() {
  lsof -nP -iTCP:"${APP_PORT}" -sTCP:LISTEN >/dev/null 2>&1
}

web_app_is_healthy() {
  curl -fsS "${APP_URL}" >/dev/null 2>&1
}

sync_worker_is_running() {
  pgrep -f "tsx src/workers/sync-worker.ts" >/dev/null 2>&1 \
    || pgrep -f "bash scripts/worker.sh" >/dev/null 2>&1 \
    || pgrep -f "npm run worker:sh" >/dev/null 2>&1
}

recover_unhealthy_app() {
  echo "Detected an unhealthy Signals app on port ${APP_PORT}. Restarting it cleanly."
  if [[ -x "${STOP_SCRIPT}" ]]; then
    "${STOP_SCRIPT}" >/dev/null 2>&1 || true
  fi

  # Clear both the old shared dist and the isolated dev dist before retrying.
  rm -rf "${REPO_ROOT}/.next" "${REPO_ROOT}/${DEV_DIST_DIR}"
}

start_background_process() {
  local label="$1"
  local pid_file="$2"
  local command="$3"

  local existing_pid
  existing_pid="$(read_pid_file "${pid_file}")"
  if is_pid_running "${existing_pid}"; then
    echo "${label} already running with PID ${existing_pid}."
    return
  fi

  rm -f "${pid_file}"
  nohup /bin/zsh -lc "source \"${HOME}/.nvm/nvm.sh\" && nvm use 22 >/dev/null && cd \"${REPO_ROOT}\" && exec ${command}" >> "${LAUNCHER_LOG}" 2>&1 < /dev/null &
  local pid=$!
  echo "${pid}" > "${pid_file}"
  echo "Started ${label} with PID ${pid}."
}

start_web_app() {
  if web_app_is_running; then
    if web_app_is_healthy; then
      echo "Web app already healthy on port ${APP_PORT}."
      return
    fi

    recover_unhealthy_app
  fi

  start_background_process "web app" "${WEB_PID_FILE}" "bash scripts/dev.sh"
}

start_sync_worker() {
  if sync_worker_is_running; then
    echo "Sync worker already running."
    return
  fi

  start_background_process "sync worker" "${WORKER_PID_FILE}" "bash scripts/worker.sh"
}

wait_for_app() {
  local attempts=0
  until web_app_is_healthy; do
    attempts=$((attempts + 1))
    if (( attempts >= WAIT_TIMEOUT_SECONDS )); then
      echo "Signals did not become ready within ${WAIT_TIMEOUT_SECONDS} seconds. Check ${REPO_ROOT}/dev.log for details." >&2
      exit 1
    fi
    sleep 1
  done
}

open_browser() {
  if [[ "${SIGNALS_SKIP_BROWSER:-0}" == "1" ]]; then
    echo "Browser launch skipped."
    return
  fi

  if open -a "Google Chrome" "${APP_URL}" >/dev/null 2>&1; then
    return
  fi
  open "${APP_URL}"
}

ensure_node_22

if [[ ! -d "${REPO_ROOT}/node_modules" ]]; then
  echo "node_modules is missing. Run npm install in ${REPO_ROOT} first." >&2
  exit 1
fi

touch "${LAUNCHER_LOG}"

start_web_app
start_sync_worker
wait_for_app
open_browser

echo "Signals is running at ${APP_URL}"
