#!/usr/bin/env bash
# send-event.sh - Claude Code hook script that captures events and POSTs to the visualization server.
# Reads JSON from stdin, adds a timestamp, and sends it to the mohano server.
# Designed to be non-blocking and never interfere with Claude Code operation.

set -o pipefail

# Load config from ~/.config/mohano/config if it exists
CONFIG_FILE="${MOHANO_CONFIG:-$HOME/.config/mohano/config}"
if [ -f "$CONFIG_FILE" ]; then
  # shellcheck source=/dev/null
  source "$CONFIG_FILE"
fi

# Defaults (can be overridden by config file or env vars)
MOHANO_URL="${MOHANO_URL:-http://localhost:7777}"
MOHANO_API_KEY="${MOHANO_API_KEY:-}"

ENDPOINT="${MOHANO_URL}/api/events"

# Read JSON from stdin
INPUT=$(cat)

# If no input, exit silently
if [ -z "$INPUT" ]; then
  exit 0
fi

# Add timestamp field to the JSON using python3 (available on macOS)
ENRICHED=$(python3 -c "
import json, sys, datetime
try:
    data = json.loads(sys.argv[1])
    data['timestamp'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    print(json.dumps(data))
except Exception:
    print(sys.argv[1])
" "$INPUT" 2>/dev/null) || ENRICHED="$INPUT"

# Build curl args
CURL_ARGS=(-s -X POST "$ENDPOINT" -H "Content-Type: application/json" -d "$ENRICHED" --max-time 2 -o /dev/null)

if [ -n "$MOHANO_API_KEY" ]; then
  CURL_ARGS+=(-H "Authorization: Bearer $MOHANO_API_KEY")
fi

# POST to the server in background, with a short timeout so it never hangs
curl "${CURL_ARGS[@]}" &

# Always exit 0 so we never block Claude Code
exit 0
