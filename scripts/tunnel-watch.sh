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
#
# A dropped tunnel does not always make cloudflared exit: it can keep running
# and retrying "Unauthorized: Tunnel not found" for hours. So the public URL is
# probed, and the tunnel restarted after three failed probes in a row.
set -u
GRACE="${GRACE:-60}"            # a new hostname can take a minute to resolve
PROBE_EVERY="${PROBE_EVERY:-30}"
MAX_FAILS="${MAX_FAILS:-3}"

# Returns once the process is gone, killing it first if $url stops answering.
probe_until_dead() {
  local pid=$1 url=$2 fails=0
  sleep "$GRACE"
  while kill -0 "$pid" 2>/dev/null; do
    if [ -n "$url" ] && curl -sf --max-time 15 "$url/healthz" >/dev/null 2>&1; then
      fails=0
    else
      fails=$((fails + 1))
    fi
    if [ "$fails" -ge "$MAX_FAILS" ]; then
      echo "[tunnel-watch] $url stopped answering at $(date -u +%Y-%m-%dT%H:%M:%SZ), restarting"
      kill "$pid" 2>/dev/null
      break
    fi
    sleep "$PROBE_EVERY"
  done
  wait "$pid" 2>/dev/null
  return 0
}

main() {
  cd "$(dirname "$0")/.."
  local port="${PORT:-8787}" log="${TMPDIR:-/tmp}/agentboard-tunnel.log"
  while true; do
    : > "$log"
    cloudflared tunnel --url "http://localhost:$port" >> "$log" 2>&1 &
    local pid=$! url=""
    for _ in $(seq 1 30); do
      url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1)
      [ -n "$url" ] && break
      sleep 2
    done

    if [ -n "$url" ]; then
      local prev
      prev=$(cat .tunnel-url 2>/dev/null || echo "")
      if [ "$url" != "$prev" ]; then
        echo "$url" > .tunnel-url
        echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $url" >> .tunnel-history
        [ -f CONNECT.md ] && sed -i '' -E "s#https://[a-z0-9-]+\.trycloudflare\.com#$url#g" CONNECT.md
        echo "[tunnel-watch] new URL $url - reconnect Duet and Muse from CONNECT.md"
      fi
    else
      echo "[tunnel-watch] cloudflared gave no URL; retrying"
    fi

    probe_until_dead "$pid" "$url"
    echo "[tunnel-watch] tunnel went down at $(date -u +%Y-%m-%dT%H:%M:%SZ), restarting"
    sleep 3
  done
}

# Run only when executed, so scripts/test-tunnel-watch.sh can source the functions.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
