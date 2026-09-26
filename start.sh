#!/usr/bin/env bash
# Starts the AtScale Env Manager: kills anything already bound to its ports (or left
# over from a previous run of this script), then starts the Flask API and
# the Vite dev server in the background. ENV_MANAGER_FAKE=1 ./start.sh runs
# against the in-memory demo backend instead of real AtScale hosts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

API_PORT="${API_PORT:-5050}"
WEB_PORT="${WEB_PORT:-5174}"
# Not 5000/5173: those are sml-wizard's, and the cleanup below kill -9s whatever holds these ports.
export API_PORT WEB_PORT
LOG_DIR="$SCRIPT_DIR/.logs"
PID_FILE="$LOG_DIR/pids"
mkdir -p "$LOG_DIR"

echo "==> Stopping any process already using :$API_PORT or :$WEB_PORT"
for port in "$API_PORT" "$WEB_PORT"; do
  pids=$(lsof -ti "tcp:$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "    killing pid(s) on :$port -> $pids"
    kill -9 $pids 2>/dev/null || true
  fi
done

# Belt-and-suspenders: also clean up any stray process from a previous run of
# this script that isn't currently holding the port (e.g. mid-crash-loop) or
# whose PID was recorded here last time.
if [ -f "$PID_FILE" ]; then
  while read -r old_pid; do
    [ -n "$old_pid" ] && kill -9 "$old_pid" 2>/dev/null || true
  done < "$PID_FILE"
fi
pkill -9 -f "$SCRIPT_DIR/api/app.py" 2>/dev/null || true
pkill -9 -f "vite.*--port $WEB_PORT" 2>/dev/null || true

sleep 1
: > "$PID_FILE"

echo "==> Resolving the Python virtualenv"
VENV_ACTIVATE=""
if [ -f "$SCRIPT_DIR/.venv/bin/activate" ]; then
  VENV_ACTIVATE="$SCRIPT_DIR/.venv/bin/activate"
elif [ -f "$SCRIPT_DIR/.venv" ]; then
  VENV_NAME="$(cat "$SCRIPT_DIR/.venv")"
  CANDIDATE="$HOME/Development/venv/$VENV_NAME/bin/activate"
  [ -f "$CANDIDATE" ] && VENV_ACTIVATE="$CANDIDATE"
fi

if [ -n "$VENV_ACTIVATE" ]; then
  echo "    using venv: $VENV_ACTIVATE"
  # shellcheck disable=SC1090
  source "$VENV_ACTIVATE"
else
  echo "    no venv found - falling back to 'python3' on PATH"
fi

if [ ! -d "$SCRIPT_DIR/web/node_modules" ]; then
  echo "==> Installing frontend dependencies (first run)"
  (cd "$SCRIPT_DIR/web" && npm install)
fi

echo "==> Starting Flask API on :$API_PORT${ENV_MANAGER_FAKE:+ (fake backend)}"
cd "$SCRIPT_DIR/api"
nohup python app.py > "$LOG_DIR/api.log" 2>&1 &
API_PID=$!
echo "$API_PID" >> "$PID_FILE"
cd "$SCRIPT_DIR"

echo "==> Starting Vite dev server on :$WEB_PORT"
cd "$SCRIPT_DIR/web"
nohup npm run dev -- --port "$WEB_PORT" > "$LOG_DIR/web.log" 2>&1 &
WEB_PID=$!
echo "$WEB_PID" >> "$PID_FILE"
cd "$SCRIPT_DIR"

echo "==> Waiting for both to come up..."
sleep 2

api_ok=false
web_ok=false
# Vite can print "ready" while still finishing a dependency pre-bundling pass
# (e.g. "Re-optimizing dependencies because vite config has changed") and not
# actually answer requests for another few seconds - 5 tries at 1s apiece was
# occasionally too impatient and reported "NOT responding yet" for a server
# that came up a moment later.
for _ in $(seq 1 20); do
  curl -s -o /dev/null "http://127.0.0.1:$API_PORT/api/health" 2>/dev/null && api_ok=true
  curl -s -o /dev/null "http://127.0.0.1:$WEB_PORT/" 2>/dev/null && web_ok=true
  [ "$api_ok" = true ] && [ "$web_ok" = true ] && break
  sleep 1
done

echo "==> Done."
if [ "$api_ok" = true ]; then
  echo "    api:  http://127.0.0.1:$API_PORT  (pid $API_PID, log: $LOG_DIR/api.log)"
else
  echo "    api:  NOT responding yet (pid $API_PID) - check $LOG_DIR/api.log"
fi
if [ "$web_ok" = true ]; then
  echo "    web:  http://127.0.0.1:$WEB_PORT  (pid $WEB_PID, log: $LOG_DIR/web.log)"
else
  echo "    web:  NOT responding yet (pid $WEB_PID) - check $LOG_DIR/web.log"
fi
