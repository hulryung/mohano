#!/usr/bin/env bash
# test-events.sh - Sends sample events to the mohano server to test visualization
# without needing actual Claude Code sessions.
# Simulates a multi-agent session with 3 agents working on different tasks.

ENDPOINT="http://localhost:7777/api/events"
SESSION_ID="sess_test_$(date +%s)"

send_event() {
  local json="$1"
  local delay="${2:-0.3}"
  curl -s -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "$json" \
    -o /dev/null --max-time 2
  echo "  Sent: $(echo "$json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('hook_type','?'), '-', d.get('agent_name', d.get('session_id','?')))" 2>/dev/null || echo "$json" | head -c 80)"
  sleep "$delay"
}

echo "=== Mohano Test Events ==="
echo "Sending to: $ENDPOINT"
echo "Session: $SESSION_ID"
echo ""

# --- Event 1: Session starts ---
send_event "{
  \"hook_type\": \"SessionStart\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"team-lead\",
  \"agent_type\": \"lead\",
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 2: Lead spawns agent "backend-dev" ---
send_event "{
  \"hook_type\": \"SubagentStart\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"backend-dev\",
  \"agent_type\": \"teammate\",
  \"parent_agent\": \"team-lead\",
  \"task\": \"Build REST API endpoints\",
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 3: Lead spawns agent "frontend-dev" ---
send_event "{
  \"hook_type\": \"SubagentStart\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"frontend-dev\",
  \"agent_type\": \"teammate\",
  \"parent_agent\": \"team-lead\",
  \"task\": \"Create React dashboard components\",
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 4: Lead spawns agent "test-dev" ---
send_event "{
  \"hook_type\": \"SubagentStart\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"test-dev\",
  \"agent_type\": \"teammate\",
  \"parent_agent\": \"team-lead\",
  \"task\": \"Write integration tests\",
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 5: backend-dev reads a file ---
send_event "{
  \"hook_type\": \"PreToolUse\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"backend-dev\",
  \"tool_name\": \"Read\",
  \"tool_input\": {\"file_path\": \"/src/server/index.ts\"},
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 6: backend-dev finishes reading ---
send_event "{
  \"hook_type\": \"PostToolUse\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"backend-dev\",
  \"tool_name\": \"Read\",
  \"tool_result\": \"success\",
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 7: frontend-dev writes a component ---
send_event "{
  \"hook_type\": \"PreToolUse\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"frontend-dev\",
  \"tool_name\": \"Write\",
  \"tool_input\": {\"file_path\": \"/src/components/Dashboard.tsx\"},
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 8: frontend-dev finishes writing ---
send_event "{
  \"hook_type\": \"PostToolUse\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"frontend-dev\",
  \"tool_name\": \"Write\",
  \"tool_result\": \"success\",
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 9: test-dev runs bash command ---
send_event "{
  \"hook_type\": \"PreToolUse\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"test-dev\",
  \"tool_name\": \"Bash\",
  \"tool_input\": {\"command\": \"bun test src/api.test.ts\"},
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 10: test-dev bash completes ---
send_event "{
  \"hook_type\": \"PostToolUse\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"test-dev\",
  \"tool_name\": \"Bash\",
  \"tool_result\": \"success\",
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 11: backend-dev edits a file ---
send_event "{
  \"hook_type\": \"PreToolUse\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"backend-dev\",
  \"tool_name\": \"Edit\",
  \"tool_input\": {\"file_path\": \"/src/server/routes.ts\", \"old_string\": \"// TODO\", \"new_string\": \"app.get('/api/users', getUsers)\"},
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 12: backend-dev edit completes ---
send_event "{
  \"hook_type\": \"PostToolUse\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"backend-dev\",
  \"tool_name\": \"Edit\",
  \"tool_result\": \"success\",
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 13: backend-dev completes task ---
send_event "{
  \"hook_type\": \"TaskCompleted\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"backend-dev\",
  \"task\": \"Build REST API endpoints\",
  \"result\": \"Created 4 API routes in routes.ts\",
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 14: frontend-dev uses Grep ---
send_event "{
  \"hook_type\": \"PreToolUse\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"frontend-dev\",
  \"tool_name\": \"Grep\",
  \"tool_input\": {\"pattern\": \"export.*interface\", \"glob\": \"*.ts\"},
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 15: frontend-dev Grep completes ---
send_event "{
  \"hook_type\": \"PostToolUse\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"frontend-dev\",
  \"tool_name\": \"Grep\",
  \"tool_result\": \"success\",
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 16: test-dev goes idle ---
send_event "{
  \"hook_type\": \"TeammateIdle\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"test-dev\",
  \"reason\": \"Waiting for backend API to stabilize before writing more tests\",
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 17: frontend-dev completes task ---
send_event "{
  \"hook_type\": \"TaskCompleted\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"frontend-dev\",
  \"task\": \"Create React dashboard components\",
  \"result\": \"Built Dashboard, Sidebar, and EventList components\",
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 18: test-dev resumes with Bash ---
send_event "{
  \"hook_type\": \"PreToolUse\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"test-dev\",
  \"tool_name\": \"Bash\",
  \"tool_input\": {\"command\": \"bun test --coverage\"},
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 19: test-dev Bash completes ---
send_event "{
  \"hook_type\": \"PostToolUse\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"test-dev\",
  \"tool_name\": \"Bash\",
  \"tool_result\": \"success\",
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 20: Notification from team-lead ---
send_event "{
  \"hook_type\": \"Notification\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"team-lead\",
  \"message\": \"All subtasks completed. Preparing final review.\",
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 21: backend-dev stops ---
send_event "{
  \"hook_type\": \"SubagentStop\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"backend-dev\",
  \"reason\": \"Task completed successfully\",
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 22: frontend-dev stops ---
send_event "{
  \"hook_type\": \"SubagentStop\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"frontend-dev\",
  \"reason\": \"Task completed successfully\",
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 23: test-dev completes and stops ---
send_event "{
  \"hook_type\": \"TaskCompleted\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"test-dev\",
  \"task\": \"Write integration tests\",
  \"result\": \"12 tests passing, 94% coverage\",
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

send_event "{
  \"hook_type\": \"SubagentStop\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"test-dev\",
  \"reason\": \"Task completed successfully\",
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

# --- Event 25: Session ends ---
send_event "{
  \"hook_type\": \"SessionEnd\",
  \"session_id\": \"$SESSION_ID\",
  \"agent_name\": \"team-lead\",
  \"summary\": \"Multi-agent session complete. API, frontend, and tests delivered.\",
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\"
}"

echo ""
echo "=== Done! Sent 25 test events ==="
echo "Open the mohano dashboard to see the visualization."
