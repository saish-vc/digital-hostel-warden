#!/usr/bin/env bash
set -euo pipefail

if (( $# != 1 )) || [[ ! $1 =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  printf 'Usage: %s <public-domain>\n' "$0" >&2
  exit 2
fi
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$repo_root"
domain=$1
base=https://$domain

# Readiness can be HTTP 200 while liveness reports degraded; require all OK.
health=$(curl --silent --show-error --fail --max-time 15 "$base/health/ready")
printf '%s' "$health" | python3 -c '
import json, sys
try:
    body = json.load(sys.stdin)
    if not isinstance(body, dict) or any(body.get(k) != "ok" for k in ("status", "db", "redis")):
        raise ValueError("health status or dependency is not ok")
except (ValueError, TypeError) as exc:
    sys.exit("Readiness check failed: " + str(exc))
'
printf '%s\n' 'API readiness: ok'

# Request the dashboard without following redirects to an unrelated site.
dashboard=$(curl --silent --show-error --fail --max-time 15 "$base/")
printf '%s' "$dashboard" | python3 -c '
import re, sys
html = sys.stdin.read()
if not re.search(r"<html(?:\s|>)", html, re.I) or not re.search(r"<div\s+id=[\x27\x22]root[\x27\x22]", html, re.I):
    sys.exit("Dashboard check failed: expected dashboard HTML")
'
printf '%s\n' 'Dashboard HTML: ok'

# Test the TLS Engine.IO WebSocket handshake, not an authenticated Socket.IO
# session. curl may time out after 101 because the upgraded connection stays
# open; inspect the response headers even when that happens.
headers=$(mktemp)
trap 'rm -f -- "$headers"' EXIT
curl_status=0
curl --silent --show-error --http1.1 --max-time 5 --output /dev/null \
  --dump-header "$headers" \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "$base/socket.io/?EIO=4&transport=websocket" || curl_status=$?
if (( curl_status != 0 && curl_status != 28 && curl_status != 56 )); then
  printf 'WebSocket request failed (curl exit %s)\n' "$curl_status" >&2
  exit 1
fi
python3 - "$headers" <<'PY'
import re, sys
with open(sys.argv[1], encoding='iso-8859-1') as f:
    headers = f.read()
# Ignore any proxy CONNECT response and inspect the final response block.
blocks = [block for block in re.split(r'\r?\n\r?\n', headers) if block.startswith('HTTP/')]
if not blocks:
    sys.exit('WebSocket check failed: no HTTP response')
lines = blocks[-1].splitlines()
fields = {}
for line in lines[1:]:
    if ':' in line:
        key, value = line.split(':', 1)
        fields[key.lower()] = value.strip()
if (not re.match(r'^HTTP/\S+ 101(?:\s|$)', lines[0]) or
        fields.get('upgrade', '').lower() != 'websocket' or
        'upgrade' not in [s.strip().lower() for s in fields.get('connection', '').split(',')] or
        fields.get('sec-websocket-accept') != 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='):
    sys.exit('WebSocket check failed: invalid upgrade response')
PY
printf '%s\n' 'TLS WebSocket upgrade: ok (authentication not tested)'
