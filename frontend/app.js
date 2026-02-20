// Mohano - Claude Code Agent Visualizer
// Vanilla JS frontend for real-time multi-agent monitoring

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  const state = {
    events: [],
    tasks: [],
    agents: new Map(),       // agentName -> { color, eventCount, lastSeen }
    sessions: new Set(),
    eventTypes: new Set(),
    filters: { session: '', agent: '', types: new Set() },
    autoScroll: true,
    wsConnected: false,
    reconnectDelay: 1000,
    reconnectTimer: null,
    ws: null,
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

    // Extract tasks from task-related events
    if (type === 'TaskStart' || type === 'TaskCompleted' || type === 'TaskUpdate') {
      upsertTask(event);
    }
  }

  function upsertTask(event) {
    const id = event.taskId || event.task_id || event.id;
    if (!id) return;
    const existing = state.tasks.find((t) => t.id === id);
    const status = event.taskStatus || event.status ||
      (extractEventType(event) === 'TaskCompleted' ? 'completed' : undefined);
    if (existing) {
      if (event.subject) existing.subject = event.subject;
      if (event.owner) existing.owner = event.owner;
      if (status) existing.status = status;
      if (event.blockedBy) existing.blockedBy = event.blockedBy;
      if (event.blocks) existing.blocks = event.blocks;
    } else {
      state.tasks.push({
        id,
        subject: event.subject || event.taskSubject || `Task #${id}`,
        owner: event.owner || extractAgentName(event),
        status: status || 'pending',
        blockedBy: event.blockedBy || [],
        blocks: event.blocks || [],
        raw: event,
      });
    }
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

  // ── Render: Task Graph ─────────────────────────────────────
  function renderTaskGraph() {
    dom.colPending.innerHTML = '';
    dom.colInProgress.innerHTML = '';
    dom.colCompleted.innerHTML = '';

    if (state.tasks.length === 0) {
      dom.colPending.innerHTML = '<div class="empty-state"><div>No tasks</div></div>';
      return;
    }

    for (const task of state.tasks) {
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
          ${task.blockedBy && task.blockedBy.length ? `<span class="task-card-deps">blocked by: ${task.blockedBy.join(', ')}</span>` : ''}
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
    dom.depArrows.innerHTML = '';
    const boardRect = dom.taskBoard.getBoundingClientRect();

    for (const task of state.tasks) {
      if (!task.blockedBy || task.blockedBy.length === 0) continue;
      const toCard = dom.taskBoard.querySelector(`[data-task-id="${task.id}"]`);
      if (!toCard) continue;
      const toRect = toCard.getBoundingClientRect();

      for (const depId of task.blockedBy) {
        const fromCard = dom.taskBoard.querySelector(`[data-task-id="${depId}"]`);
        if (!fromCard) continue;
        const fromRect = fromCard.getBoundingClientRect();

        const x1 = fromRect.right - boardRect.left;
        const y1 = fromRect.top + fromRect.height / 2 - boardRect.top;
        const x2 = toRect.left - boardRect.left;
        const y2 = toRect.top + toRect.height / 2 - boardRect.top;

        const midX = (x1 + x2) / 2;

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`);
        path.setAttribute('class', 'dep-arrow');
        dom.depArrows.appendChild(path);

        // Arrowhead
        const head = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        const hs = 5;
        head.setAttribute('points', `${x2},${y2} ${x2 - hs * 2},${y2 - hs} ${x2 - hs * 2},${y2 + hs}`);
        head.setAttribute('class', 'dep-arrow-head');
        dom.depArrows.appendChild(head);
      }
    }
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
  function showDetail(event) {
    dom.detailTitle.textContent = `${extractEventType(event)} - ${extractAgentName(event)}`;
    dom.detailJson.innerHTML = syntaxHighlightJson(event);
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
    renderEventLog();
  }

  function renderIncremental() {
    renderFilterOptions();
    renderAgentList();
    renderCounters();
    renderTimeline();
    renderTaskGraph();
    renderEventLog();
  }

  // ── WebSocket ──────────────────────────────────────────────
  function setConnectionStatus(status) {
    dom.connectionStatus.className = `status-dot ${status}`;
    dom.connectionLabel.textContent = status === 'connected' ? 'Connected'
      : status === 'connecting' ? 'Connecting...' : 'Disconnected';
    state.wsConnected = status === 'connected';
  }

  function connectWebSocket() {
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    setConnectionStatus('connecting');
    const wsUrl = `ws://${location.hostname || 'localhost'}:7777/ws`;

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

    state.ws.onclose = () => {
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
  async function loadInitialData() {
    try {
      const baseUrl = `http://${location.hostname || 'localhost'}:7777`;
      const res = await fetch(`${baseUrl}/api/events`);
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
