#!/bin/bash
# Keeps a cloudflare quick tunnel alive in front of the board.
#
# Quick tunnels are ephemeral: Cloudflare reaps them, and the replacement has a
# different hostname. A dead tunnel is the dangerous failure for the pickup
# test, because the agents simply cannot reach the board and the report then
# looks exactly like "no agent ever checked".
#
# So every URL change is appended to .tunnel-history, rewritten into CONNECT.md,
# and reported by poll-report, which refuses to call a silent window evidence.
set -u
cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"
LOG="${TMPDIR:-/tmp}/agentboard-tunnel.log"

while true; do
  : > "$LOG"
  cloudflared tunnel --url "http://localhost:$PORT" >> "$LOG" 2>&1 &
  PID=$!
  URL=""
  for _ in $(seq 1 30); do
    URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1)
    [ -n "$URL" ] && break
    sleep 2
  done

  if [ -n "$URL" ]; then
    PREV=$(cat .tunnel-url 2>/dev/null || echo "")
    if [ "$URL" != "$PREV" ]; then
      echo "$URL" > .tunnel-url
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $URL" >> .tunnel-history
      [ -f CONNECT.md ] && sed -i '' -E "s#https://[a-z0-9-]+\.trycloudflare\.com#$URL#g" CONNECT.md
      echo "[tunnel-watch] new URL $URL - reconnect Duet and Muse from CONNECT.md"
    fi
  else
    echo "[tunnel-watch] cloudflared gave no URL; retrying"
  fi

  wait $PID                     # blocks until the tunnel dies
  echo "[tunnel-watch] tunnel went down at $(date -u +%Y-%m-%dT%H:%M:%SZ), restarting"
  sleep 3
done
