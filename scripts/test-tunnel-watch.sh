#!/bin/bash
# Checks the watchdog's probe loop without Cloudflare: a stand-in process and
# a URL that never answers must be killed; one that answers must be left alone.
set -u
cd "$(dirname "$0")/.."
GRACE=0 PROBE_EVERY=0.2 MAX_FAILS=3
source scripts/tunnel-watch.sh

sleep 30 & dead=$!
start=$(date +%s)
probe_until_dead "$dead" "https://no-such-tunnel.invalid" >/dev/null
if kill -0 "$dead" 2>/dev/null; then echo "FAIL: dead tunnel was not killed"; exit 1; fi
echo "ok: a URL that never answers is killed after $MAX_FAILS probes ($(( $(date +%s) - start ))s)"

PORT_OK=${PORT:-8787}
if curl -sf --max-time 5 "http://localhost:$PORT_OK/healthz" >/dev/null; then
  sleep 2 & alive=$!
  start=$(date +%s)
  probe_until_dead "$alive" "http://localhost:$PORT_OK" >/dev/null
  if [ $(( $(date +%s) - start )) -lt 2 ]; then echo "FAIL: a healthy tunnel was killed early"; exit 1; fi
  echo "ok: a URL that answers is left running until its process exits on its own"
else
  echo "skip: no server on :$PORT_OK to test the healthy case"
fi
