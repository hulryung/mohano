#!/usr/bin/env bash
# send-event.sh - Claude Code hook script that captures events and POSTs to the visualization server.
# Reads JSON from stdin, adds a timestamp, and sends it to the mohano server.
# Designed to be non-blocking and never interfere with Claude Code operation.

set -o pipefail

ENDPOINT="http://localhost:7777/api/events"

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

# POST to the server in background, with a short timeout so it never hangs
curl -s -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -d "$ENRICHED" \
  --max-time 1 \
  -o /dev/null &

# Always exit 0 so we never block Claude Code
exit 0
