#!/usr/bin/env bash
# setup.sh - Install Mohano and configure Claude Code hooks
set -euo pipefail

MOHANO_DIR="$(cd "$(dirname "$0")" && pwd)"
SEND_SCRIPT="$MOHANO_DIR/hooks/send-event.sh"
SETTINGS_FILE="$HOME/.claude/settings.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[mohano]${NC} $1"; }
ok()    { echo -e "${GREEN}[mohano]${NC} $1"; }
warn()  { echo -e "${YELLOW}[mohano]${NC} $1"; }
err()   { echo -e "${RED}[mohano]${NC} $1"; }

echo ""
echo -e "${CYAN}  Mohano - Claude Code Agent Visualizer${NC}"
echo -e "  ──────────────────────────────────────"
echo ""

# ── 1. Check prerequisites ──────────────────────────────────

info "Checking prerequisites..."

if ! command -v node &>/dev/null; then
  err "Node.js is required but not found. Install it from https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  err "Node.js 18+ is required (found v$(node -v))"
  exit 1
fi

if ! command -v python3 &>/dev/null; then
  warn "python3 not found. Timestamps in events will use raw format."
fi

if ! command -v curl &>/dev/null; then
  err "curl is required but not found."
  exit 1
fi

ok "Prerequisites OK (Node $(node -v))"

# ── 2. Install server dependencies ──────────────────────────

info "Installing server dependencies..."
cd "$MOHANO_DIR/server"
npm install --silent 2>/dev/null
ok "Server dependencies installed"

# ── 3. Make hook scripts executable ──────────────────────────

chmod +x "$MOHANO_DIR/hooks/send-event.sh"
chmod +x "$MOHANO_DIR/hooks/test-events.sh"
ok "Hook scripts are executable"

# ── 4. Configure Claude Code hooks ──────────────────────────

info "Configuring Claude Code hooks..."

# Ensure ~/.claude directory exists
mkdir -p "$HOME/.claude"

# Build hooks config using python3
HOOK_CMD="cat | $SEND_SCRIPT"

python3 << PYEOF
import json, os, sys

settings_file = "$SETTINGS_FILE"
hook_cmd = "$HOOK_CMD"

# Hook definitions: (event_name, supports_matcher)
hook_defs = [
    ("PreToolUse",    True),
    ("PostToolUse",   True),
    ("SubagentStart", True),
    ("SubagentStop",  True),
    ("Notification",  True),
    ("TaskCompleted", False),
    ("TeammateIdle",  False),
    ("Stop",          False),
]

# Load existing settings or start fresh
settings = {}
if os.path.exists(settings_file):
    try:
        with open(settings_file, 'r') as f:
            settings = json.load(f)
    except Exception:
        pass

hooks = settings.get("hooks", {})

for event_name, supports_matcher in hook_defs:
    hook_entry = {"type": "command", "command": hook_cmd, "async": True}
    if supports_matcher:
        new_rule = {"matcher": "", "hooks": [hook_entry]}
    else:
        new_rule = {"hooks": [hook_entry]}

    existing = hooks.get(event_name, [])

    # Check if mohano hook already exists (by command substring)
    already = any(
        any("mohano" in h.get("command", "") for h in rule.get("hooks", []))
        for rule in existing
    )

    if not already:
        existing.append(new_rule)
        hooks[event_name] = existing

settings["hooks"] = hooks

with open(settings_file, 'w') as f:
    json.dump(settings, f, indent=2, ensure_ascii=False)
    f.write("\n")

print("ok")
PYEOF

if [ $? -eq 0 ]; then
  ok "Claude Code hooks configured in $SETTINGS_FILE"
else
  warn "Could not auto-configure hooks. See README for manual setup."
fi

# ── 5. Done ──────────────────────────────────────────────────

echo ""
echo -e "${GREEN}  Setup complete!${NC}"
echo ""
echo "  Start the server:"
echo -e "    ${CYAN}cd $MOHANO_DIR/server && npm start${NC}"
echo ""
echo "  Then open:"
echo -e "    ${CYAN}http://localhost:7777${NC}"
echo ""
echo "  To test with sample events (in another terminal):"
echo -e "    ${CYAN}$MOHANO_DIR/hooks/test-events.sh${NC}"
echo ""
