#!/usr/bin/env bash
# uninstall.sh - Remove Mohano hooks from Claude Code settings
# Only removes mohano-related hooks, leaves everything else intact.
set -euo pipefail

SETTINGS_FILE="$HOME/.claude/settings.json"
CONFIG_DIR="$HOME/.config/mohano"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[mohano]${NC} $1"; }
ok()    { echo -e "${GREEN}[mohano]${NC} $1"; }
warn()  { echo -e "${YELLOW}[mohano]${NC} $1"; }

echo ""
echo -e "${RED}  Mohano - Uninstall${NC}"
echo -e "  ──────────────────"
echo ""

# ── 1. Remove mohano hooks from Claude Code settings ──────

if [ -f "$SETTINGS_FILE" ]; then
  info "Removing Mohano hooks from $SETTINGS_FILE..."

  python3 << 'PYEOF'
import json, os, sys

settings_file = os.path.expanduser("~/.claude/settings.json")

try:
    with open(settings_file, 'r') as f:
        settings = json.load(f)
except Exception as e:
    print(f"Could not read settings: {e}", file=sys.stderr)
    sys.exit(1)

hooks = settings.get("hooks", {})
removed = 0

for event_name in list(hooks.keys()):
    rules = hooks[event_name]
    # Keep only rules that do NOT contain a mohano hook
    filtered = []
    for rule in rules:
        hook_list = rule.get("hooks", [])
        non_mohano = [h for h in hook_list if "mohano" not in h.get("command", "")]
        if non_mohano:
            # Other hooks exist in this rule — keep them, remove only mohano ones
            rule["hooks"] = non_mohano
            filtered.append(rule)
        else:
            # All hooks in this rule are mohano — drop the entire rule
            removed += 1

    if filtered:
        hooks[event_name] = filtered
    else:
        # No rules left for this event — remove the key entirely
        del hooks[event_name]

if hooks:
    settings["hooks"] = hooks
elif "hooks" in settings:
    del settings["hooks"]

with open(settings_file, 'w') as f:
    json.dump(settings, f, indent=2, ensure_ascii=False)
    f.write("\n")

print(f"removed:{removed}")
PYEOF

  if [ $? -eq 0 ]; then
    ok "Mohano hooks removed from Claude Code settings"
  else
    warn "Could not update settings file. You may need to remove hooks manually."
  fi
else
  info "No settings file found at $SETTINGS_FILE — skipping"
fi

# ── 2. Remove client config ──────────────────────────────

if [ -d "$CONFIG_DIR" ]; then
  rm -rf "$CONFIG_DIR"
  ok "Removed config directory ($CONFIG_DIR)"
else
  info "No config directory found — skipping"
fi

# ── Done ──────────────────────────────────────────────────

echo ""
echo -e "${GREEN}  Uninstall complete!${NC}"
echo ""
echo "  Mohano hooks have been removed from Claude Code."
echo "  Your other hooks and settings are untouched."
echo ""
echo "  To reinstall later:"
echo -e "    ${CYAN}./setup.sh${NC}"
echo ""
