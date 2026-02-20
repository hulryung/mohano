# Mohano

Real-time visualizer for Claude Code multi-agent and subagent activity.

Mohano connects to Claude Code via its [hooks system](https://docs.anthropic.com/en/docs/claude-code/hooks) and streams all agent events to a web dashboard, giving you visibility into what each agent is doing across sessions.

## Features

- **Timeline View** - Swim-lane timeline showing events per agent in real time
- **Task Graph** - Kanban board of tasks (Pending / In Progress / Completed) with dependency arrows
- **Agents View** - Per-session agent cards grouped by type:
  - **Team agents** - grouped by team name (spawned with `team_name`)
  - **Subagents** - individual subagents (Explore, Plan, Bash, etc.)
  - **Main session** - the primary Claude Code session
- **Live Event Log** - Collapsible table of all events with filtering
- **Detail Modal** - Click any event to see parsed fields or raw JSON
- **Filtering** - Filter by session, agent, or event type
- **WebSocket** - Auto-reconnecting real-time connection with no polling

## Architecture

```
Claude Code ──(hooks)──> send-event.sh ──(POST)──> Mohano Server ──(WebSocket)──> Browser
```

- **Hooks** (`hooks/send-event.sh`) - Shell script invoked by Claude Code hooks. Reads event JSON from stdin, adds a UTC timestamp, and POSTs to the server. Runs async and always exits 0 to never block Claude Code.
- **Server** (`server/index.mjs`) - Node.js HTTP + WebSocket server on port 7777. Receives events via `POST /api/events`, stores them in a circular buffer (2000 max), and broadcasts to all connected WebSocket clients. Also serves the frontend as static files.
- **Frontend** (`frontend/`) - Vanilla HTML/CSS/JS single-page app with a dark theme. Connects via WebSocket for real-time updates.

## Quick Start

### 1. Install and start the server

```bash
cd server
npm install
npm start
# Server runs at http://localhost:7777
```

For development with auto-reload:

```bash
npm run dev
```

### 2. Configure Claude Code hooks

Add the following to your Claude Code settings (`~/.claude/settings.json`). Adjust the path to `send-event.sh` to match your installation:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [{"type": "command", "command": "cat | /path/to/mohano/hooks/send-event.sh", "async": true}]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [{"type": "command", "command": "cat | /path/to/mohano/hooks/send-event.sh", "async": true}]
      }
    ],
    "SubagentStart": [
      {
        "matcher": "",
        "hooks": [{"type": "command", "command": "cat | /path/to/mohano/hooks/send-event.sh", "async": true}]
      }
    ],
    "SubagentStop": [
      {
        "matcher": "",
        "hooks": [{"type": "command", "command": "cat | /path/to/mohano/hooks/send-event.sh", "async": true}]
      }
    ],
    "TaskCompleted": [
      {
        "hooks": [{"type": "command", "command": "cat | /path/to/mohano/hooks/send-event.sh", "async": true}]
      }
    ],
    "TeammateIdle": [
      {
        "hooks": [{"type": "command", "command": "cat | /path/to/mohano/hooks/send-event.sh", "async": true}]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [{"type": "command", "command": "cat | /path/to/mohano/hooks/send-event.sh", "async": true}]
      }
    ],
    "Stop": [
      {
        "hooks": [{"type": "command", "command": "cat | /path/to/mohano/hooks/send-event.sh", "async": true}]
      }
    ]
  }
}
```

> **Note:** `TaskCompleted`, `TeammateIdle`, and `Stop` hooks don't support the `matcher` field - omit it for those event types.

### 3. Open the dashboard

Navigate to [http://localhost:7777](http://localhost:7777) in your browser. Start a Claude Code session and you'll see events streaming in.

### 4. Test with sample events (optional)

```bash
chmod +x hooks/test-events.sh
./hooks/test-events.sh
```

This sends 25 simulated events from 4 agents to verify the pipeline works.

## API

| Endpoint | Method | Description |
|---|---|---|
| `/api/events` | POST | Ingest a hook event (JSON body) |
| `/api/events` | GET | Retrieve stored events. Query params: `session_id`, `agent_type`, `tool_name`, `hook_event_name`, `since_seq`, `limit` |
| `/api/agents` | GET | List tracked agents |
| `/api/tasks` | GET | Scan `~/.claude/tasks/` for task files |
| `/ws` | WebSocket | Real-time event stream |

## Project Structure

```
mohano/
├── frontend/
│   ├── index.html          # Main page
│   ├── app.js              # Frontend logic (state, rendering, WebSocket)
│   └── style.css           # Dark theme styles
├── hooks/
│   ├── send-event.sh       # Hook script (stdin JSON -> POST to server)
│   ├── test-events.sh      # Sample event generator for testing
│   └── claude-hooks-config.json  # Example hooks configuration
└── server/
    ├── index.mjs           # Node.js HTTP + WebSocket server
    └── package.json
```

## Requirements

- Node.js 18+
- `python3` (used by `send-event.sh` to add timestamps; available by default on macOS)
- `curl` (used by `send-event.sh` to POST events)

## License

MIT
