// Mohano - Claude Code Agent Visualizer
// Vanilla JS frontend for real-time multi-agent monitoring

(function () {
  'use strict';

  // ── Workspace Token ──────────────────────────────────────────
  const pathMatch = location.pathname.match(/^\/d\/([^/]+)/);
  const WORKSPACE_TOKEN = pathMatch ? pathMatch[1] : null;

  // ── State ──────────────────────────────────────────────────
  const state = {
    events: [],
    tasksBySession: new Map(),  // sessionId -> Map(taskId -> task)
    activeTaskSession: '',      // which session's tasks to show ('' = latest)
    agents: new Map(),          // agentName -> { color, eventCount, lastSeen }
    agentProfiles: new Map(),   // sessionId::agentKey -> { name, sessionId, type, ... }
    activeAgentSession: '',     // which session's agents to show
    sessions: new Set(),
    eventTypes: new Set(),
    filters: { session: '', agent: '', types: new Set() },
    autoScroll: true,
    wsConnected: false,
    reconnectDelay: 1000,
    reconnectTimer: null,
    ws: null,
    tokenError: false,
  };

  const AGENT_COLORS = [
    '#58a6ff', '#3fb950', '#bc8cff', '#d29922',
    '#f85149', '#39d2c0', '#db61a2', '#79c0ff',
  ];

  const EVENT_TYPE_STYLE = {
    SubagentStart:      { cls: 'type-subagent',     badge: 'blue',   label: 'Subagent+' },
    SubagentStop:       { cls: 'type-subagent',     badge: 'blue',   label: 'Subagent-' },
    PreToolUse:         { cls: 'type-tool-success', badge: 'green',  label: 'Tool' },
    PostToolUse:        { cls: 'type-tool-success', badge: 'green',  label: 'Tool OK' },
    PostToolUseFailure: { cls: 'type-tool-error',   badge: 'red',    label: 'Tool Err' },
    TaskStart:          { cls: 'type-task',         badge: 'purple', label: 'Task+' },
    TaskCompleted:      { cls: 'type-task',         badge: 'purple', label: 'TaskDone' },
    TaskUpdate:         { cls: 'type-task',         badge: 'purple', label: 'TaskUpd' },
    TeammateIdle:       { cls: 'type-idle',         badge: 'gray',   label: 'Idle' },
    SendMessage:        { cls: 'type-message',      badge: 'orange', label: 'Msg' },
    Notification:       { cls: 'type-default',      badge: 'gray',   label: 'Notif' },
    Stop:               { cls: 'type-idle',         badge: 'gray',   label: 'Stop' },
    SessionStart:       { cls: 'type-subagent',     badge: 'blue',   label: 'Start' },
    SessionEnd:         { cls: 'type-subagent',     badge: 'blue',   label: 'End' },
    ConfigChange:       { cls: 'type-default',      badge: 'gray',   label: 'Config' },
    PreCompact:         { cls: 'type-default',      badge: 'gray',   label: 'Compact' },
  };

  // ── DOM refs ───────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    connectionStatus:  $('#connection-status'),
    connectionLabel:   $('#connection-label'),
    eventCount:        $('#event-count'),
    filterSession:     $('#filter-session'),
    filterAgent:       $('#filter-agent'),
    filterEventTypes:  $('#filter-event-types'),
    btnClearFilters:   $('#btn-clear-filters'),
    agentList:         $('#agent-list'),
    viewTabs:          $$('.tab'),
    views:             $$('.view'),
    btnAutoScroll:     $('#btn-auto-scroll'),
    timelineInfo:      $('#timeline-info'),
    timelineLanes:     $('#timeline-lanes'),
    timelineContainer: $('#timeline-container'),
    taskBoard:         $('#taskgraph-board'),
    colPending:        $('#col-pending'),
    colInProgress:     $('#col-in-progress'),
    colCompleted:      $('#col-completed'),
    depArrows:         $('#dependency-arrows'),
    agentsContainer:   $('#agents-container'),
    agentsSessionSel:  $('#agents-session-selector'),
    eventLogBody:      $('#event-log-body'),
    bottomPanelHeader: $('#bottom-panel-header'),
    bottomPanelContent:$('#bottom-panel-content'),
    detailOverlay:     $('#detail-overlay'),
    detailTitle:       $('#detail-title'),
    detailJson:        $('#detail-json'),
    detailClose:       $('#detail-close'),
  };

  // ── Utilities ──────────────────────────────────────────────
  function formatTime(ts) {
    if (!ts) return '--:--:--';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return String(ts).slice(0, 8);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function getAgentColor(name) {
    if (!name) return AGENT_COLORS[0];
    const agent = state.agents.get(name);
    return agent ? agent.color : AGENT_COLORS[0];
  }

  function getEventStyle(type) {
    return EVENT_TYPE_STYLE[type] || { cls: 'type-default', badge: 'gray', label: type ? type.slice(0, 6) : '?' };
  }

  function extractAgentName(event) {
    // Real Claude Code events: agent identity comes from various places
    // 1. Teammate/agent name fields
    if (event.teammate_name) return event.teammate_name;
    if (event.agent_name) return event.agent_name;
    if (event.agent) return event.agent;
    if (event.agentName) return event.agentName;

    // 2. For Task tool events, extract agent name from tool_input or tool_response
    if (event.tool_name === 'Task' || event.tool_name === 'SendMessage') {
      const name = event.tool_input?.name || event.tool_response?.name;
      if (name) return name;
    }

    // 3. For SubagentStop, check tool_response for agent info
    const hookType = event.hook_event_name || event.hook_type;
    if (hookType === 'SubagentStop' || hookType === 'SubagentStart') {
      if (event.agent_type) return event.agent_type;
    }

    // 4. Derive from session_id (use short form) or cwd (project name)
    if (event.cwd) {
      const parts = event.cwd.split('/');
      return parts[parts.length - 1] || 'unknown';
    }
    if (event.session_id) {
      return event.session_id.slice(0, 8);
    }

    return event.owner || 'unknown';
  }

  function extractEventType(event) {
    return event.hook_event_name || event.hook_type || event.type || event.eventType || event.event_type || 'Unknown';
  }

  function extractSessionId(event) {
    return event.session || event.sessionId || event.session_id || '';
  }

  function extractSummary(event) {
    if (event.summary) return event.summary;
    const t = extractEventType(event);

    if (t === 'PreToolUse' || t === 'PostToolUse') {
      const tool = event.tool_name || event.tool || event.toolName || 'tool';
      // Add context from tool_input
      if (event.tool_input) {
        if (event.tool_input.file_path) return `${tool}: ${event.tool_input.file_path.split('/').pop()}`;
        if (event.tool_input.command) return `${tool}: ${String(event.tool_input.command).slice(0, 40)}`;
        if (event.tool_input.pattern) return `${tool}: ${event.tool_input.pattern}`;
        if (event.tool_input.query) return `${tool}: ${String(event.tool_input.query).slice(0, 40)}`;
        if (event.tool_input.prompt) return `${tool}: ${String(event.tool_input.prompt).slice(0, 40)}`;
        if (event.tool_input.description) return `${tool}: ${event.tool_input.description}`;
        if (event.tool_input.subject) return `${tool}: ${event.tool_input.subject}`;
        if (event.tool_input.taskId) return `${tool}: task #${event.tool_input.taskId}`;
      }
      return tool;
    }
    if (t === 'SendMessage') return event.recipient ? `to ${event.recipient}` : 'message';
    if (t === 'TaskCompleted' || t === 'TaskUpdate') return event.task || event.task_subject || event.subject || event.taskId || '';
    if (t === 'SubagentStart') return event.agent_type || event.task || 'spawn';
    if (t === 'SubagentStop') return event.agent_type || event.reason || 'stop';
    if (t === 'TeammateIdle') return event.reason || 'idle';
    if (t === 'Notification') return event.message || '';
    if (t === 'SessionStart') return 'session started';
    if (t === 'SessionEnd') return event.summary || 'session ended';
    if (t === 'Stop') return 'agent stopped';
    return '';
  }

  function isToolError(event) {
    const t = extractEventType(event);
    if (t === 'PostToolUse' && (event.error || event.status === 'error' || event.success === false)) return true;
    return false;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function syntaxHighlightJson(json) {
    const str = typeof json === 'string' ? json : JSON.stringify(json, null, 2);
    return str.replace(/("(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(\.\d+)?([eE][+-]?\d+)?)/g, (match) => {
      let cls = 'json-number';
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? 'json-key' : 'json-string';
      } else if (/true|false/.test(match)) {
        cls = 'json-bool';
      } else if (/null/.test(match)) {
        cls = 'json-null';
      }
      return `<span class="${cls}">${escapeHtml(match)}</span>`;
    });
  }

  // Inject JSON syntax highlighting styles
  const jsonStyles = document.createElement('style');
  jsonStyles.textContent = `
    .json-key    { color: #79c0ff; }
    .json-string { color: #a5d6ff; }
    .json-number { color: #d29922; }
    .json-bool   { color: #ff7b72; }
    .json-null   { color: #6e7681; }
  `;
  document.head.appendChild(jsonStyles);

  // ── Register Agent ─────────────────────────────────────────
  function registerAgent(name) {
    if (!name || state.agents.has(name)) return;
    const idx = state.agents.size % AGENT_COLORS.length;
    state.agents.set(name, { color: AGENT_COLORS[idx], eventCount: 0, lastSeen: Date.now() });
  }

  // ── Process Event ──────────────────────────────────────────
  function processEvent(event) {
    state.events.push(event);

    const agent = extractAgentName(event);
    const type = extractEventType(event);
    const session = extractSessionId(event);

    registerAgent(agent);
    const agentData = state.agents.get(agent);
    if (agentData) {
      agentData.eventCount++;
      agentData.lastSeen = Date.now();
    }

    if (session) state.sessions.add(session);
    state.eventTypes.add(type);

    // Update agent profiles
    updateAgentProfiles(event);

    // Extract tasks from tool events (PostToolUse only to avoid duplicates)
    const toolName = event.tool_name || '';
    if (type === 'PostToolUse' && (toolName === 'TaskCreate' || toolName === 'TaskUpdate')) {
      upsertTaskFromTool(event);
    }
    if (type === 'TaskCompleted') {
      const sid = extractSessionId(event);
      const taskId = event.task_id;
      if (taskId && sid) {
        const sessionTasks = state.tasksBySession.get(sid);
        if (sessionTasks) {
          const existing = sessionTasks.get(String(taskId));
          if (existing) existing.status = 'completed';
        }
      }
    }
  }

  function getSessionTaskMap(sessionId) {
    if (!state.tasksBySession.has(sessionId)) {
      state.tasksBySession.set(sessionId, new Map());
    }
    return state.tasksBySession.get(sessionId);
  }

  function upsertTaskFromTool(event) {
    const input = event.tool_input || {};
    const response = event.tool_response || {};
    const toolName = event.tool_name;
    const sessionId = extractSessionId(event);
    if (!sessionId) return;

    const sessionTasks = getSessionTaskMap(sessionId);

    if (toolName === 'TaskCreate') {
      const taskData = response.task || response;
      const id = String(taskData.id || '');
      if (!id) return;
      // Always create/replace - a new TaskCreate with the same id means a new team's task
      sessionTasks.set(id, {
        id,
        sessionId,
        subject: input.subject || taskData.subject || `Task #${id}`,
        owner: '',
        status: 'pending',
        blockedBy: [],
        blocks: [],
        createdAt: event.timestamp || event.ts || '',
        raw: event,
      });
      // Track latest session with tasks
      state.activeTaskSession = sessionId;
    } else if (toolName === 'TaskUpdate') {
      const id = String(input.taskId || '');
      if (!id) return;
      const existing = sessionTasks.get(id);
      if (existing) {
        if (input.status) existing.status = input.status;
        if (input.owner) existing.owner = input.owner;
        if (input.subject) existing.subject = input.subject;
        if (input.addBlockedBy) {
          existing.blockedBy = [...new Set([...existing.blockedBy, ...input.addBlockedBy])];
        }
        if (input.addBlocks) {
          existing.blocks = [...new Set([...existing.blocks, ...input.addBlocks])];
        }
        if (response.statusChange) {
          existing.status = response.statusChange.to;
        }
        existing.raw = event;
      } else {
        sessionTasks.set(id, {
          id,
          sessionId,
          subject: input.subject || `Task #${id}`,
          owner: input.owner || '',
          status: input.status || 'pending',
          blockedBy: input.addBlockedBy || [],
          blocks: input.addBlocks || [],
          createdAt: event.timestamp || event.ts || '',
          raw: event,
        });
      }
    }
  }

  function getActiveSessionTasks() {
    const sid = state.activeTaskSession;
    if (!sid) return [];
    const sessionTasks = state.tasksBySession.get(sid);
    if (!sessionTasks) return [];
    return [...sessionTasks.values()];
  }

  // ── Agent Profiles ────────────────────────────────────────
  function getAgentProfileKey(sessionId, name) {
    return `${sessionId}::${name}`;
  }

  function getOrCreateProfile(sessionId, name) {
    const key = getAgentProfileKey(sessionId, name);
    if (!state.agentProfiles.has(key)) {
      state.agentProfiles.set(key, {
        key,
        name,
        sessionId,
        type: 'main',       // main | subagent | team
        subagentType: '',    // e.g. 'Explore', 'Plan', 'Bash', 'general-purpose'
        teamName: '',
        status: 'active',    // active | idle | stopped
        color: getAgentColor(name),
        events: [],
        startTime: '',
        stopTime: '',
        taskDescription: '',
      });
    }
    return state.agentProfiles.get(key);
  }

  function updateAgentProfiles(event) {
    const sessionId = extractSessionId(event);
    if (!sessionId) return;

    const hookType = extractEventType(event);
    const toolName = event.tool_name || '';

    // SubagentStart: a new subagent was spawned
    if (hookType === 'SubagentStart') {
      const name = event.agent_type || event.agent_name || extractAgentName(event);
      const profile = getOrCreateProfile(sessionId, name);
      profile.type = 'subagent';
      profile.subagentType = event.agent_type || '';
      profile.status = 'active';
      profile.startTime = event.timestamp || event.ts || '';
      profile.events.push(event);
      return;
    }

    // SubagentStop: subagent finished
    if (hookType === 'SubagentStop') {
      const name = event.agent_type || event.agent_name || extractAgentName(event);
      const profile = getOrCreateProfile(sessionId, name);
      profile.type = 'subagent';
      profile.status = 'stopped';
      profile.stopTime = event.timestamp || event.ts || '';
      profile.events.push(event);
      return;
    }

    // TeammateIdle: a team member went idle
    if (hookType === 'TeammateIdle') {
      const name = event.teammate_name || extractAgentName(event);
      const profile = getOrCreateProfile(sessionId, name);
      profile.type = 'team';
      profile.status = 'idle';
      profile.events.push(event);
      return;
    }

    // PostToolUse with Task tool: a subagent or team agent was spawned
    if (hookType === 'PostToolUse' && toolName === 'Task') {
      const input = event.tool_input || {};
      const response = event.tool_response || {};
      const agentName = input.name || response.name || input.subagent_type || '';
      if (!agentName) return;

      const profile = getOrCreateProfile(sessionId, agentName);
      if (input.team_name || response.team_name) {
        profile.type = 'team';
        profile.teamName = input.team_name || response.team_name;
      } else {
        profile.type = 'subagent';
      }
      profile.subagentType = input.subagent_type || '';
      profile.status = 'active';
      profile.startTime = profile.startTime || event.timestamp || event.ts || '';
      if (input.description) profile.taskDescription = input.description;
      if (input.prompt) profile.taskDescription = profile.taskDescription || truncate(input.prompt, 120);
      profile.events.push(event);
      return;
    }

    // PreToolUse with Task tool: capture the spawn intent
    if (hookType === 'PreToolUse' && toolName === 'Task') {
      const input = event.tool_input || {};
      const agentName = input.name || input.subagent_type || '';
      if (!agentName) return;

      const profile = getOrCreateProfile(sessionId, agentName);
      if (input.team_name) {
        profile.type = 'team';
        profile.teamName = input.team_name;
      } else {
        profile.type = 'subagent';
      }
      profile.subagentType = input.subagent_type || '';
      if (input.description) profile.taskDescription = input.description;
      if (input.prompt) profile.taskDescription = profile.taskDescription || truncate(input.prompt, 120);
      return;
    }

    // TeamCreate tool: creates a team
    if (toolName === 'TeamCreate') {
      const input = event.tool_input || {};
      if (input.team_name) {
        // Track the main session agent with team context
        const mainName = extractAgentName(event);
        const mainProfile = getOrCreateProfile(sessionId, mainName);
        mainProfile.teamName = input.team_name;
      }
      return;
    }

    // SendMessage tool: indicates team communication
    if (toolName === 'SendMessage') {
      const input = event.tool_input || {};
      const recipient = input.recipient;
      if (recipient) {
        const profile = getOrCreateProfile(sessionId, recipient);
        profile.type = 'team';
        if (!profile.teamName) {
          // Try to infer team name from sender
          const senderName = extractAgentName(event);
          const senderProfile = state.agentProfiles.get(getAgentProfileKey(sessionId, senderName));
          if (senderProfile && senderProfile.teamName) {
            profile.teamName = senderProfile.teamName;
          }
        }
      }
      return;
    }

    // For Stop events
    if (hookType === 'Stop') {
      const name = extractAgentName(event);
      const key = getAgentProfileKey(sessionId, name);
      if (state.agentProfiles.has(key)) {
        const profile = state.agentProfiles.get(key);
        profile.status = 'stopped';
        profile.stopTime = event.timestamp || event.ts || '';
        profile.events.push(event);
      }
      return;
    }

    // General events: add to the agent's profile event list (keep last 10)
    const name = extractAgentName(event);
    const key = getAgentProfileKey(sessionId, name);
    if (state.agentProfiles.has(key)) {
      const profile = state.agentProfiles.get(key);
      profile.events.push(event);
      if (profile.events.length > 20) {
        profile.events = profile.events.slice(-20);
      }
      // If agent has events, it's active (unless explicitly idle/stopped)
      if (profile.status === 'idle') {
        profile.status = 'active';
      }
    } else {
      // Create a main agent profile for any agent that generates events
      const profile = getOrCreateProfile(sessionId, name);
      profile.events.push(event);
    }
  }

  function getActiveAgentSession() {
    return state.activeAgentSession || state.activeTaskSession || (state.sessions.size > 0 ? [...state.sessions].pop() : '');
  }

  function getSessionAgentProfiles(sessionId) {
    const profiles = [];
    for (const [, profile] of state.agentProfiles) {
      if (profile.sessionId === sessionId) {
        profiles.push(profile);
      }
    }
    return profiles;
  }

  // ── Filtering ──────────────────────────────────────────────
  function passesFilter(event) {
    const { session, agent, types } = state.filters;
    if (session && extractSessionId(event) !== session) return false;
    if (agent && extractAgentName(event) !== agent) return false;
    if (types.size > 0 && !types.has(extractEventType(event))) return false;
    return true;
  }

  function getFilteredEvents() {
    return state.events.filter(passesFilter);
  }

  // ── Render: Filters ────────────────────────────────────────
  function renderFilterOptions() {
    // Sessions
    const curSession = dom.filterSession.value;
    dom.filterSession.innerHTML = '<option value="">All Sessions</option>';
    for (const s of state.sessions) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s.length > 20 ? s.slice(0, 8) + '...' + s.slice(-8) : s;
      if (s === curSession) opt.selected = true;
      dom.filterSession.appendChild(opt);
    }

    // Agents
    const curAgent = dom.filterAgent.value;
    dom.filterAgent.innerHTML = '<option value="">All Agents</option>';
    for (const [name] of state.agents) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (name === curAgent) opt.selected = true;
      dom.filterAgent.appendChild(opt);
    }

    // Event types
    const existing = new Set(
      Array.from(dom.filterEventTypes.querySelectorAll('input')).map((i) => i.value)
    );
    for (const t of state.eventTypes) {
      if (existing.has(t)) continue;
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = t;
      input.checked = state.filters.types.size === 0 || state.filters.types.has(t);
      input.addEventListener('change', () => {
        if (input.checked) {
          state.filters.types.delete(t);
        } else {
          // If unchecking, add all others first time
          if (state.filters.types.size === 0) {
            for (const et of state.eventTypes) state.filters.types.add(et);
          }
          state.filters.types.delete(t);
        }
        renderAll();
      });
      const style = getEventStyle(t);
      const badge = document.createElement('span');
      badge.className = `type-badge ${style.badge}`;
      badge.textContent = t;
      label.appendChild(input);
      label.appendChild(badge);
      dom.filterEventTypes.appendChild(label);
    }
  }

  // ── Render: Agent List ─────────────────────────────────────
  function renderAgentList() {
    dom.agentList.innerHTML = '';
    for (const [name, data] of state.agents) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'agent-dot';
      dot.style.background = data.color;
      const nameSpan = document.createElement('span');
      nameSpan.className = 'agent-name';
      nameSpan.textContent = name;
      nameSpan.style.color = data.color;
      const count = document.createElement('span');
      count.className = 'agent-count';
      count.textContent = data.eventCount;
      li.appendChild(dot);
      li.appendChild(nameSpan);
      li.appendChild(count);
      dom.agentList.appendChild(li);
    }
  }

  // ── Render: Timeline ───────────────────────────────────────
  function renderTimeline() {
    const filtered = getFilteredEvents();
    dom.timelineInfo.textContent = `${filtered.length} events`;

    if (filtered.length === 0) {
      dom.timelineLanes.innerHTML = `
        <div class="empty-state">
          <div>No events yet</div>
          <div class="hint">Waiting for agent activity...</div>
        </div>`;
      return;
    }

    // Group by agent
    const lanes = new Map();
    for (const ev of filtered) {
      const agent = extractAgentName(ev);
      if (!lanes.has(agent)) lanes.set(agent, []);
      lanes.get(agent).push(ev);
    }

    // Check which lanes exist
    const existingLanes = new Map();
    for (const el of dom.timelineLanes.querySelectorAll('.swim-lane')) {
      existingLanes.set(el.dataset.agent, el);
    }

    // Add/update lanes
    for (const [agent, events] of lanes) {
      let laneEl = existingLanes.get(agent);
      if (!laneEl) {
        laneEl = document.createElement('div');
        laneEl.className = 'swim-lane';
        laneEl.dataset.agent = agent;

        const label = document.createElement('div');
        label.className = 'lane-label';
        const dot = document.createElement('span');
        dot.className = 'agent-dot';
        dot.style.background = getAgentColor(agent);
        label.appendChild(dot);
        label.appendChild(document.createTextNode(agent));

        const eventsContainer = document.createElement('div');
        eventsContainer.className = 'lane-events';

        laneEl.appendChild(label);
        laneEl.appendChild(eventsContainer);
        dom.timelineLanes.appendChild(laneEl);
      }

      const container = laneEl.querySelector('.lane-events');
      const currentCount = container.children.length;

      // Only add new events
      for (let i = currentCount; i < events.length; i++) {
        const ev = events[i];
        const block = document.createElement('div');
        const style = getEventStyle(extractEventType(ev));
        const cls = isToolError(ev) ? 'type-tool-error' : style.cls;
        block.className = `event-block ${cls}`;
        block.textContent = style.label;
        block.title = `${extractEventType(ev)} - ${formatTime(ev.timestamp || ev.ts)}`;
        block.addEventListener('click', () => showDetail(ev));
        container.appendChild(block);
      }
    }

    // Remove stale lanes
    for (const [agent, el] of existingLanes) {
      if (!lanes.has(agent)) el.remove();
    }

    // Auto-scroll
    if (state.autoScroll) {
      const laneEls = dom.timelineLanes.querySelectorAll('.lane-events');
      for (const el of laneEls) {
        el.scrollLeft = el.scrollWidth;
      }
    }
  }

  // ── Render: Task Session Selector ──────────────────────────
  function renderTaskSessionSelector() {
    let selector = document.getElementById('task-session-selector');
    const container = document.getElementById('view-taskgraph');
    if (!selector) {
      const bar = document.createElement('div');
      bar.className = 'task-session-bar';
      bar.innerHTML = '<label>Session:</label>';
      selector = document.createElement('select');
      selector.id = 'task-session-selector';
      selector.addEventListener('change', () => {
        state.activeTaskSession = selector.value;
        renderTaskGraph();
      });
      bar.appendChild(selector);
      container.insertBefore(bar, container.firstChild);
    }

    const curVal = state.activeTaskSession;
    selector.innerHTML = '';
    for (const [sid] of state.tasksBySession) {
      const opt = document.createElement('option');
      opt.value = sid;
      opt.textContent = sid.slice(0, 8) + '...';
      // Try to find a project name from events of this session
      const sampleEvent = state.events.find(e => extractSessionId(e) === sid && e.cwd);
      if (sampleEvent) {
        const project = sampleEvent.cwd.split('/').pop();
        opt.textContent = `${project} (${sid.slice(0, 8)})`;
      }
      if (sid === curVal) opt.selected = true;
      selector.appendChild(opt);
    }
  }

  // ── Render: Task Graph ─────────────────────────────────────
  function renderTaskGraph() {
    dom.colPending.innerHTML = '';
    dom.colInProgress.innerHTML = '';
    dom.colCompleted.innerHTML = '';
    renderTaskSessionSelector();

    const tasks = getActiveSessionTasks();

    if (tasks.length === 0) {
      dom.colPending.innerHTML = '<div class="empty-state"><div>No tasks</div></div>';
      return;
    }

    for (const task of tasks) {
      const card = document.createElement('div');
      card.className = 'task-card';
      card.dataset.taskId = task.id;
      const agentColor = getAgentColor(task.owner);
      card.style.borderLeftColor = agentColor;

      card.innerHTML = `
        <div class="task-card-id">#${escapeHtml(String(task.id))}</div>
        <div class="task-card-subject">${escapeHtml(task.subject)}</div>
        <div class="task-card-meta">
          <span class="task-card-owner" style="color: ${agentColor}">${escapeHtml(task.owner || 'unassigned')}</span>
          ${task.blockedBy && task.blockedBy.length ? `<span class="task-card-deps">blocked by: ${task.blockedBy.map(id => '#' + id).join(', ')}</span>` : ''}
        </div>`;

      card.addEventListener('click', () => showDetail(task.raw || task));

      const status = (task.status || '').toLowerCase().replace(/\s+/g, '_');
      if (status === 'completed') {
        dom.colCompleted.appendChild(card);
      } else if (status === 'in_progress') {
        dom.colInProgress.appendChild(card);
      } else {
        dom.colPending.appendChild(card);
      }
    }

    // Draw dependency arrows (deferred to next frame so layout is ready)
    requestAnimationFrame(drawDependencyArrows);
  }

  function drawDependencyArrows() {
    const svg = dom.depArrows;
    svg.innerHTML = '';

    const board = dom.taskBoard;
    const boardRect = board.getBoundingClientRect();

    // Set SVG size to cover the full scrollable area
    const sw = board.scrollWidth;
    const sh = board.scrollHeight;
    svg.setAttribute('width', sw);
    svg.setAttribute('height', sh);
    svg.setAttribute('viewBox', `0 0 ${sw} ${sh}`);
    svg.style.width = sw + 'px';
    svg.style.height = sh + 'px';

    // Add marker defs for arrowheads (pending = blue, completed = green)
    const NS = 'http://www.w3.org/2000/svg';
    const defs = document.createElementNS(NS, 'defs');

    function makeMarker(id, color) {
      const marker = document.createElementNS(NS, 'marker');
      marker.setAttribute('id', id);
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '10');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '8');
      marker.setAttribute('markerHeight', '8');
      marker.setAttribute('orient', 'auto-start-reverse');
      const arrow = document.createElementNS(NS, 'path');
      arrow.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
      arrow.setAttribute('fill', color);
      marker.appendChild(arrow);
      return marker;
    }

    defs.appendChild(makeMarker('arrow-pending', '#58a6ff'));
    defs.appendChild(makeMarker('arrow-completed', '#3fb950'));
    svg.appendChild(defs);

    // Scroll offsets so we translate viewport coords into board-content coords
    const scrollLeft = board.scrollLeft;
    const scrollTop = board.scrollTop;

    const tasks = getActiveSessionTasks();

    for (const task of tasks) {
      if (!task.blockedBy || task.blockedBy.length === 0) continue;

      const toCard = board.querySelector(`[data-task-id="${task.id}"]`);
      if (!toCard) continue;
      const toRect = toCard.getBoundingClientRect();

      for (const depId of task.blockedBy) {
        const fromCard = board.querySelector(`[data-task-id="${depId}"]`);
        if (!fromCard) continue;
        const fromRect = fromCard.getBoundingClientRect();

        // Determine if the blocking task is completed
        const blockingTask = tasks.find(t => t.id === String(depId));
        const isCompleted = blockingTask && blockingTask.status === 'completed';
        const arrowClass = isCompleted ? 'dep-arrow completed' : 'dep-arrow pending';
        const markerId = isCompleted ? 'arrow-completed' : 'arrow-pending';

        // Convert viewport rects to board-content coordinates
        const fromLeft   = fromRect.left - boardRect.left + scrollLeft;
        const fromRight  = fromRect.right - boardRect.left + scrollLeft;
        const fromTop    = fromRect.top - boardRect.top + scrollTop;
        const fromBottom = fromRect.bottom - boardRect.top + scrollTop;
        const fromCenterY = fromTop + fromRect.height / 2;
        const fromCenterX = fromLeft + fromRect.width / 2;

        const toLeft   = toRect.left - boardRect.left + scrollLeft;
        const toRight  = toRect.right - boardRect.left + scrollLeft;
        const toTop    = toRect.top - boardRect.top + scrollTop;
        const toBottom = toRect.bottom - boardRect.top + scrollTop;
        const toCenterY = toTop + toRect.height / 2;
        const toCenterX = toLeft + toRect.width / 2;

        let d;

        if (Math.abs(fromCenterX - toCenterX) < fromRect.width * 0.5) {
          // Same column: draw from bottom-center of source to top-center of target,
          // curving outward to the right to avoid overlapping cards
          const x1 = fromCenterX;
          const y1 = fromBottom;
          const x2 = toCenterX;
          const y2 = toTop;
          const bulge = 60;
          d = `M${x1},${y1} C${x1 + bulge},${y1} ${x2 + bulge},${y2} ${x2},${y2}`;
        } else if (fromCenterX < toCenterX) {
          // Source is LEFT of target: right edge -> left edge
          const x1 = fromRight;
          const y1 = fromCenterY;
          const x2 = toLeft;
          const y2 = toCenterY;
          const midX = (x1 + x2) / 2;
          d = `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`;
        } else {
          // Source is RIGHT of target: left edge -> right edge
          const x1 = fromLeft;
          const y1 = fromCenterY;
          const x2 = toRight;
          const y2 = toCenterY;
          const midX = (x1 + x2) / 2;
          d = `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`;
        }

        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', d);
        path.setAttribute('class', arrowClass);
        path.setAttribute('marker-end', `url(#${markerId})`);
        svg.appendChild(path);
      }
    }
  }

  // ── Render: Agents View ────────────────────────────────────
  function renderAgentsSessionSelector() {
    const sel = dom.agentsSessionSel;
    const curVal = getActiveAgentSession();
    sel.innerHTML = '';

    if (state.sessions.size === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No sessions';
      sel.appendChild(opt);
      return;
    }

    for (const sid of state.sessions) {
      const opt = document.createElement('option');
      opt.value = sid;
      // Try to find a project name
      const sampleEvent = state.events.find(e => extractSessionId(e) === sid && e.cwd);
      if (sampleEvent) {
        const project = sampleEvent.cwd.split('/').pop();
        opt.textContent = `${project} (${sid.slice(0, 8)})`;
      } else {
        opt.textContent = sid.slice(0, 8) + '...';
      }
      if (sid === curVal) opt.selected = true;
      sel.appendChild(opt);
    }

    if (!state.activeAgentSession && curVal) {
      state.activeAgentSession = curVal;
    }
  }

  function renderAgentsView() {
    renderAgentsSessionSelector();
    const container = dom.agentsContainer;
    container.innerHTML = '';

    const sessionId = getActiveAgentSession();
    const profiles = getSessionAgentProfiles(sessionId);

    if (profiles.length === 0) {
      container.innerHTML = `
        <div class="agents-empty">
          <div>No agents detected</div>
          <div class="hint">Agent profiles are built from SubagentStart, Task, and TeammateIdle events</div>
        </div>`;
      return;
    }

    // Group by type: main, team, subagent
    const groups = {
      team: profiles.filter(p => p.type === 'team'),
      subagent: profiles.filter(p => p.type === 'subagent'),
      main: profiles.filter(p => p.type === 'main'),
    };

    // Group team agents by team name
    const teamsByName = new Map();
    for (const p of groups.team) {
      const tn = p.teamName || 'unnamed-team';
      if (!teamsByName.has(tn)) teamsByName.set(tn, []);
      teamsByName.get(tn).push(p);
    }

    // Render team groups
    for (const [teamName, members] of teamsByName) {
      const group = document.createElement('div');
      group.className = 'agents-group';
      group.innerHTML = `
        <div class="agents-group-header">
          <span class="legend-dot legend-team"></span>
          Team: ${escapeHtml(teamName)}
          <span class="group-count">${members.length} members</span>
        </div>`;
      const grid = document.createElement('div');
      grid.className = 'agents-grid';
      for (const profile of members) {
        grid.appendChild(buildAgentCard(profile));
      }
      group.appendChild(grid);
      container.appendChild(group);
    }

    // Render subagents
    if (groups.subagent.length > 0) {
      const group = document.createElement('div');
      group.className = 'agents-group';
      group.innerHTML = `
        <div class="agents-group-header">
          <span class="legend-dot legend-subagent"></span>
          Subagents
          <span class="group-count">${groups.subagent.length}</span>
        </div>`;
      const grid = document.createElement('div');
      grid.className = 'agents-grid';
      for (const profile of groups.subagent) {
        grid.appendChild(buildAgentCard(profile));
      }
      group.appendChild(grid);
      container.appendChild(group);
    }

    // Render main agents
    if (groups.main.length > 0) {
      const group = document.createElement('div');
      group.className = 'agents-group';
      group.innerHTML = `
        <div class="agents-group-header">
          <span class="legend-dot legend-main"></span>
          Main Session
          <span class="group-count">${groups.main.length}</span>
        </div>`;
      const grid = document.createElement('div');
      grid.className = 'agents-grid';
      for (const profile of groups.main) {
        grid.appendChild(buildAgentCard(profile));
      }
      group.appendChild(grid);
      container.appendChild(group);
    }
  }

  function buildAgentCard(profile) {
    const card = document.createElement('div');
    card.className = `agent-card type-${profile.type}`;

    // Header: name + type badge + status
    const header = document.createElement('div');
    header.className = 'agent-card-header';

    const nameEl = document.createElement('span');
    nameEl.className = 'agent-card-name';
    nameEl.style.color = profile.color;
    nameEl.textContent = profile.name;

    const typeBadge = document.createElement('span');
    typeBadge.className = `agent-card-type ${profile.type}`;
    typeBadge.textContent = profile.type === 'team' ? 'Team' : profile.type === 'subagent' ? 'Sub' : 'Main';

    const statusBadge = document.createElement('span');
    statusBadge.className = `agent-card-status ${profile.status}`;
    statusBadge.textContent = profile.status;

    header.appendChild(nameEl);
    header.appendChild(typeBadge);
    header.appendChild(statusBadge);
    card.appendChild(header);

    // Meta info
    const meta = document.createElement('div');
    meta.className = 'agent-card-meta';

    if (profile.subagentType) {
      meta.innerHTML += `<span class="agent-meta-item"><span class="agent-meta-label">type:</span> ${escapeHtml(profile.subagentType)}</span>`;
    }
    if (profile.teamName) {
      meta.innerHTML += `<span class="agent-meta-item"><span class="agent-meta-label">team:</span> <span class="agent-team-name">${escapeHtml(profile.teamName)}</span></span>`;
    }
    meta.innerHTML += `<span class="agent-meta-item"><span class="agent-meta-label">events:</span> ${profile.events.length}</span>`;
    if (profile.startTime) {
      meta.innerHTML += `<span class="agent-meta-item"><span class="agent-meta-label">started:</span> ${formatTime(profile.startTime)}</span>`;
    }
    if (profile.stopTime) {
      meta.innerHTML += `<span class="agent-meta-item"><span class="agent-meta-label">stopped:</span> ${formatTime(profile.stopTime)}</span>`;
    }
    card.appendChild(meta);

    // Task description
    if (profile.taskDescription) {
      const taskEl = document.createElement('div');
      taskEl.className = 'agent-card-task';
      taskEl.textContent = profile.taskDescription;
      card.appendChild(taskEl);
    }

    // Recent activity (last 5 events)
    const recentEvents = profile.events.slice(-5).reverse();
    if (recentEvents.length > 0) {
      const activitySection = document.createElement('div');
      activitySection.className = 'agent-card-activity';
      activitySection.innerHTML = '<div class="agent-card-activity-title">Recent Activity</div>';

      const list = document.createElement('div');
      list.className = 'agent-activity-list';

      for (const ev of recentEvents) {
        const item = document.createElement('div');
        item.className = 'agent-activity-item';

        const style = getEventStyle(extractEventType(ev));
        const time = document.createElement('span');
        time.className = 'agent-activity-time';
        time.textContent = formatTime(ev.timestamp || ev.ts);

        const badge = document.createElement('span');
        badge.className = `type-badge ${style.badge}`;
        badge.textContent = style.label;
        badge.style.fontSize = '9px';
        badge.style.padding = '0 4px';

        const summary = document.createElement('span');
        summary.className = 'agent-activity-summary';
        summary.textContent = extractSummary(ev);

        item.appendChild(time);
        item.appendChild(badge);
        item.appendChild(summary);
        item.addEventListener('click', () => showDetail(ev));
        list.appendChild(item);
      }

      activitySection.appendChild(list);
      card.appendChild(activitySection);
    }

    return card;
  }

  // ── Render: Event Log ──────────────────────────────────────
  function renderEventLog() {
    const filtered = getFilteredEvents();
    const currentCount = dom.eventLogBody.children.length;

    // Only append new rows
    for (let i = currentCount; i < filtered.length; i++) {
      const ev = filtered[i];
      const type = extractEventType(ev);
      const style = getEventStyle(type);
      const tr = document.createElement('tr');
      tr.className = 'new-row';

      tr.innerHTML = `
        <td class="col-time">${formatTime(ev.timestamp || ev.ts)}</td>
        <td class="col-type"><span class="type-badge ${style.badge}">${escapeHtml(type)}</span></td>
        <td class="col-agent" style="color: ${getAgentColor(extractAgentName(ev))}">${escapeHtml(extractAgentName(ev))}</td>
        <td class="col-summary">${escapeHtml(extractSummary(ev))}</td>`;

      tr.addEventListener('click', () => showDetail(ev));
      dom.eventLogBody.appendChild(tr);
    }

    // Auto-scroll log
    if (state.autoScroll) {
      dom.bottomPanelContent.scrollTop = dom.bottomPanelContent.scrollHeight;
    }
  }

  // ── Render: Counters ───────────────────────────────────────
  function renderCounters() {
    dom.eventCount.textContent = `${state.events.length} events`;
  }

  // ── Detail Modal ───────────────────────────────────────────
  function buildParsedView(event) {
    const type = extractEventType(event);
    const agent = extractAgentName(event);
    const badgeStyle = getEventStyle(type);
    let html = '';

    // Section: Overview
    html += `<div class="detail-section">`;
    html += `<div class="detail-section-title">Overview</div>`;
    html += `<div class="detail-fields">`;
    html += field('Event', `<span class="detail-badge type-badge ${badgeStyle.badge}">${escapeHtml(type)}</span>`);
    html += field('Agent', agent);
    html += field('Time', formatTime(event.timestamp || event.ts));
    html += field('Session', event.session_id ? event.session_id.slice(0, 12) + '...' : '-');
    if (event.cwd) html += field('Working Dir', event.cwd);
    html += `</div></div>`;

    // Section: Tool info (for Pre/PostToolUse)
    if (event.tool_name) {
      html += `<div class="detail-section">`;
      html += `<div class="detail-section-title">Tool Call</div>`;
      html += `<div class="detail-fields">`;
      html += field('Tool', event.tool_name);

      if (event.tool_input) {
        const inp = event.tool_input;
        // Show key fields in a readable way per tool type
        if (inp.command) html += field('Command', inp.command);
        if (inp.file_path) html += field('File', inp.file_path);
        if (inp.pattern) html += field('Pattern', inp.pattern);
        if (inp.query) html += field('Query', inp.query);
        if (inp.prompt) html += field('Prompt', truncate(inp.prompt, 200));
        if (inp.description) html += field('Description', inp.description);
        if (inp.subject) html += field('Subject', inp.subject);
        if (inp.taskId) html += field('Task ID', '#' + inp.taskId);
        if (inp.status) html += field('Status', inp.status);
        if (inp.owner) html += field('Owner', inp.owner);
        if (inp.old_string) html += field('Old', truncate(inp.old_string, 100));
        if (inp.new_string) html += field('New', truncate(inp.new_string, 100));
        if (inp.content) html += field('Content', truncate(String(inp.content), 200));
        if (inp.url) html += field('URL', inp.url);
        if (inp.name) html += field('Name', inp.name);
        if (inp.subagent_type) html += field('Agent Type', inp.subagent_type);
        if (inp.team_name) html += field('Team', inp.team_name);
        if (inp.addBlockedBy) html += field('Blocked By', inp.addBlockedBy.map(id => '#' + id).join(', '));
        if (inp.addBlocks) html += field('Blocks', inp.addBlocks.map(id => '#' + id).join(', '));
      }
      html += `</div></div>`;

      // Tool response
      if (event.tool_response) {
        html += `<div class="detail-section">`;
        html += `<div class="detail-section-title">Result</div>`;
        html += `<div class="detail-fields">`;
        const resp = event.tool_response;
        if (typeof resp === 'string') {
          html += field('Output', truncate(resp, 300));
        } else {
          if (resp.success !== undefined) html += field('Success', resp.success ? 'Yes' : 'No');
          if (resp.task) html += field('Task', `#${resp.task.id} ${resp.task.subject || ''}`);
          if (resp.taskId) html += field('Task ID', '#' + resp.taskId);
          if (resp.statusChange) html += field('Status', `${resp.statusChange.from} → ${resp.statusChange.to}`);
          if (resp.updatedFields && resp.updatedFields.length) html += field('Updated', resp.updatedFields.join(', '));
          if (resp.agent_id) html += field('Agent ID', resp.agent_id);
          if (resp.name) html += field('Name', resp.name);
          if (resp.team_name) html += field('Team', resp.team_name);
          if (resp.model) html += field('Model', resp.model);
          if (resp.color) html += field('Color', resp.color);
          // For generic responses, show a truncated JSON
          const shownKeys = ['success','task','taskId','statusChange','updatedFields','agent_id','name','team_name','model','color'];
          const remaining = Object.keys(resp).filter(k => !shownKeys.includes(k));
          if (remaining.length > 0) {
            const subset = {};
            remaining.forEach(k => subset[k] = resp[k]);
            const str = JSON.stringify(subset, null, 2);
            if (str.length > 2) html += field('Other', truncate(str, 300));
          }
        }
        html += `</div></div>`;
      }
    }

    // Section: Agent/Subagent info
    if (type === 'SubagentStart' || type === 'SubagentStop') {
      html += `<div class="detail-section">`;
      html += `<div class="detail-section-title">Agent Info</div>`;
      html += `<div class="detail-fields">`;
      if (event.agent_type) html += field('Type', event.agent_type);
      if (event.agent_id) html += field('Agent ID', event.agent_id);
      if (event.reason) html += field('Reason', event.reason);
      if (event.last_assistant_message) html += field('Last Message', truncate(event.last_assistant_message, 200));
      html += `</div></div>`;
    }

    // Section: Notification
    if (type === 'Notification') {
      html += `<div class="detail-section">`;
      html += `<div class="detail-section-title">Notification</div>`;
      html += `<div class="detail-fields">`;
      if (event.message) html += field('Message', event.message);
      if (event.notification_type) html += field('Type', event.notification_type);
      html += `</div></div>`;
    }

    return html;
  }

  function field(key, value) {
    return `<div class="detail-field-key">${escapeHtml(key)}</div><div class="detail-field-value">${typeof value === 'string' && !value.includes('<') ? escapeHtml(value) : value}</div>`;
  }

  function truncate(str, max) {
    if (!str) return '-';
    str = String(str);
    if (str.length <= max) return str;
    return str.slice(0, max) + '...';
  }

  function showDetail(event) {
    const type = extractEventType(event);
    const agent = extractAgentName(event);
    dom.detailTitle.textContent = `${type} - ${agent}`;

    // Parsed view
    const parsedEl = $('#detail-parsed');
    parsedEl.innerHTML = buildParsedView(event);

    // Raw JSON view
    dom.detailJson.innerHTML = syntaxHighlightJson(event);

    // Reset tabs to Parsed
    for (const tab of document.querySelectorAll('.detail-tab')) {
      tab.classList.toggle('active', tab.dataset.detail === 'parsed');
    }
    parsedEl.classList.add('active');
    dom.detailJson.classList.remove('active');

    dom.detailOverlay.classList.remove('hidden');
  }

  function hideDetail() {
    dom.detailOverlay.classList.add('hidden');
  }

  // ── Full render ────────────────────────────────────────────
  function renderAll() {
    // Clear incremental state for full re-render
    dom.timelineLanes.innerHTML = '';
    dom.eventLogBody.innerHTML = '';

    renderFilterOptions();
    renderAgentList();
    renderCounters();
    renderTimeline();
    renderTaskGraph();
    renderAgentsView();
    renderEventLog();
  }

  function renderIncremental() {
    renderFilterOptions();
    renderAgentList();
    renderCounters();
    renderTimeline();
    renderTaskGraph();
    renderAgentsView();
    renderEventLog();
  }

  // ── Server URL helpers ─────────────────────────────────────
  function getBaseUrl() {
    return `${location.protocol}//${location.host}`;
  }

  function getWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const base = `${proto}//${location.host}/ws`;
    return WORKSPACE_TOKEN ? `${base}?token=${encodeURIComponent(WORKSPACE_TOKEN)}` : base;
  }

  // ── WebSocket ──────────────────────────────────────────────
  function setConnectionStatus(status, message) {
    dom.connectionStatus.className = `status-dot ${status}`;
    if (message) {
      dom.connectionLabel.textContent = message;
    } else {
      dom.connectionLabel.textContent = status === 'connected' ? 'Connected'
        : status === 'connecting' ? 'Connecting...' : 'Disconnected';
    }
    state.wsConnected = status === 'connected';
  }

  function connectWebSocket() {
    if (state.tokenError) return;
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    setConnectionStatus('connecting');
    const wsUrl = getWsUrl();

    try {
      state.ws = new WebSocket(wsUrl);
    } catch (e) {
      console.warn('WebSocket connection failed:', e);
      scheduleReconnect();
      return;
    }

    state.ws.onopen = () => {
      setConnectionStatus('connected');
      state.reconnectDelay = 1000;
      console.log('WebSocket connected');
    };

    state.ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        // Could be a single event or an array
        const events = Array.isArray(data) ? data : [data];
        for (const ev of events) {
          processEvent(ev);
        }
        renderIncremental();
      } catch (e) {
        console.warn('Failed to parse WebSocket message:', e);
      }
    };

    state.ws.onclose = (e) => {
      if (e.code === 4001) {
        state.tokenError = true;
        setConnectionStatus('disconnected', 'Invalid workspace token');
        console.warn('WebSocket closed: invalid workspace token');
        return; // Do not reconnect
      }
      setConnectionStatus('disconnected');
      console.log('WebSocket disconnected');
      scheduleReconnect();
    };

    state.ws.onerror = (err) => {
      console.warn('WebSocket error:', err);
      state.ws.close();
    };
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(() => {
      console.log(`Reconnecting (delay: ${state.reconnectDelay}ms)...`);
      connectWebSocket();
      // Exponential backoff, max 30s
      state.reconnectDelay = Math.min(state.reconnectDelay * 1.5, 30000);
    }, state.reconnectDelay);
  }

  // ── Initial Data Load ──────────────────────────────────────
  function apiUrl(path) {
    const sep = path.includes('?') ? '&' : '?';
    return WORKSPACE_TOKEN ? `${getBaseUrl()}${path}${sep}token=${encodeURIComponent(WORKSPACE_TOKEN)}` : `${getBaseUrl()}${path}`;
  }

  async function loadInitialData() {
    try {
      const res = await fetch(apiUrl('/api/events'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const events = Array.isArray(data) ? data : (data.events || []);
      for (const ev of events) {
        processEvent(ev);
      }
      renderAll();
    } catch (e) {
      console.log('Could not load initial data (server may not be running yet):', e.message);
    }
  }

  // ── Event Handlers ─────────────────────────────────────────
  function setupEventHandlers() {
    // Tab switching
    for (const tab of dom.viewTabs) {
      tab.addEventListener('click', () => {
        for (const t of dom.viewTabs) t.classList.remove('active');
        for (const v of dom.views) v.classList.remove('active');
        tab.classList.add('active');
        const view = document.getElementById(`view-${tab.dataset.view}`);
        if (view) view.classList.add('active');
        if (tab.dataset.view === 'taskgraph') {
          requestAnimationFrame(drawDependencyArrows);
        }
      });
    }

    // Auto-scroll toggle
    dom.btnAutoScroll.addEventListener('click', () => {
      state.autoScroll = !state.autoScroll;
      dom.btnAutoScroll.classList.toggle('active', state.autoScroll);
    });

    // Bottom panel toggle
    dom.bottomPanelHeader.addEventListener('click', () => {
      document.body.classList.toggle('panel-collapsed');
    });

    // Filter changes
    dom.filterSession.addEventListener('change', () => {
      state.filters.session = dom.filterSession.value;
      renderAll();
    });

    dom.filterAgent.addEventListener('change', () => {
      state.filters.agent = dom.filterAgent.value;
      renderAll();
    });

    dom.btnClearFilters.addEventListener('click', () => {
      state.filters.session = '';
      state.filters.agent = '';
      state.filters.types.clear();
      dom.filterSession.value = '';
      dom.filterAgent.value = '';
      for (const cb of dom.filterEventTypes.querySelectorAll('input')) {
        cb.checked = true;
      }
      renderAll();
    });

    // Detail modal
    dom.detailClose.addEventListener('click', hideDetail);
    dom.detailOverlay.addEventListener('click', (e) => {
      if (e.target === dom.detailOverlay) hideDetail();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideDetail();
    });

    // Detail tab switching (Parsed / Raw JSON)
    for (const tab of document.querySelectorAll('.detail-tab')) {
      tab.addEventListener('click', () => {
        for (const t of document.querySelectorAll('.detail-tab')) t.classList.remove('active');
        tab.classList.add('active');
        const parsedEl = $('#detail-parsed');
        const jsonEl = $('#detail-json');
        if (tab.dataset.detail === 'parsed') {
          parsedEl.classList.add('active');
          jsonEl.classList.remove('active');
        } else {
          parsedEl.classList.remove('active');
          jsonEl.classList.add('active');
        }
      });
    }

    // Agents session selector
    dom.agentsSessionSel.addEventListener('change', () => {
      state.activeAgentSession = dom.agentsSessionSel.value;
      renderAgentsView();
    });

    // Redraw dependency arrows on resize
    window.addEventListener('resize', () => {
      requestAnimationFrame(drawDependencyArrows);
    });
  }

  // ── Init ───────────────────────────────────────────────────
  function init() {
    setupEventHandlers();
    renderAll();
    loadInitialData();
    connectWebSocket();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
