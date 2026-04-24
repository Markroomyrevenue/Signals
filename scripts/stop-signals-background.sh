#!/usr/bin/env zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

WEB_PID_FILE="${REPO_ROOT}/.signals-web.pid"
WORKER_PID_FILE="${REPO_ROOT}/.signals-worker.pid"

APP_PORT="${PORT:-3000}"
if [[ -f "${REPO_ROOT}/.env" ]]; then
  ENV_PORT="$(sed -nE 's/^PORT="?([0-9]+)"?$/\1/p' "${REPO_ROOT}/.env" | tail -n 1)"
  if [[ -n "${ENV_PORT:-}" ]]; then
    APP_PORT="${ENV_PORT}"
  fi
fi

STOPPED_ANYTHING=0

read_pid_file() {
  local pid_file="$1"
  if [[ -f "${pid_file}" ]]; then
    tr -d '[:space:]' < "${pid_file}"
  fi
}

is_pid_running() {
  local pid="$1"
  [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1
}

stop_pid() {
  local label="$1"
  local pid="$2"

  if ! is_pid_running "${pid}"; then
    return
  fi

  STOPPED_ANYTHING=1
  echo "Stopping ${label} (${pid})..."
  pkill -TERM -P "${pid}" >/dev/null 2>&1 || true
  kill -TERM "${pid}" >/dev/null 2>&1 || true

  local attempts=0
  while is_pid_running "${pid}" && (( attempts < 20 )); do
    sleep 0.5
    attempts=$((attempts + 1))
  done

  if is_pid_running "${pid}"; then
    pkill -KILL -P "${pid}" >/dev/null 2>&1 || true
    kill -KILL "${pid}" >/dev/null 2>&1 || true
  fi
}

stop_from_pid_file() {
  local label="$1"
  local pid_file="$2"
  local pid

  pid="$(read_pid_file "${pid_file}")"
  if [[ -n "${pid}" ]]; then
    stop_pid "${label}" "${pid}"
  fi
  rm -f "${pid_file}"
}

stop_listeners_on_port() {
  local listener_pids
  listener_pids="$(lsof -tiTCP:"${APP_PORT}" -sTCP:LISTEN || true)"

  if [[ -z "${listener_pids}" ]]; then
    return
  fi

  local pid
  while IFS= read -r pid; do
    [[ -z "${pid}" ]] && continue
    stop_pid "web app" "${pid}"
  done <<< "${listener_pids}"
}

stop_matching_processes() {
  local label="$1"
  local pattern="$2"
  local matching_pids

  matching_pids="$(pgrep -f "${pattern}" || true)"
  if [[ -z "${matching_pids}" ]]; then
    return
  fi

  local pid
  while IFS= read -r pid; do
    [[ -z "${pid}" ]] && continue
    stop_pid "${label}" "${pid}"
  done <<< "${matching_pids}"
}

stop_from_pid_file "web app" "${WEB_PID_FILE}"
stop_from_pid_file "sync worker" "${WORKER_PID_FILE}"
stop_listeners_on_port
stop_matching_processes "web app" "bash scripts/dev.sh"
stop_matching_processes "web app" "next dev -H 127.0.0.1 -p ${APP_PORT}"
stop_matching_processes "sync worker" "tsx src/workers/sync-worker.ts"
stop_matching_processes "sync worker" "bash scripts/worker.sh"
stop_matching_processes "sync worker" "npm run worker:sh"

if [[ "${STOPPED_ANYTHING}" -eq 0 ]]; then
  echo "Signals was not running."
else
  echo "Signals has been stopped."
fi
