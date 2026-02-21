// Mohano - Multi-agent monitoring server
// Node.js server for Claude Code hook event ingestion and visualization

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '7777', 10);
const MAX_EVENTS = parseInt(process.env.MAX_EVENTS || '2000', 10);
const API_KEY = process.env.MOHANO_API_KEY || '';
const FRONTEND_DIR = resolve(__dirname, '../frontend');
const WORKSPACE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // check every hour

// --- Circular buffer ---

class CircularBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.buf = new Array(capacity);
    this.head = 0;
    this.count = 0;
  }

  push(item) {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  toArray() {
    if (this.count === 0) return [];
    if (this.count < this.capacity) {
      return this.buf.slice(0, this.count);
    }
    return [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)];
  }

  get size() {
    return this.count;
  }
}

// --- Per-workspace state ---

const workspaces = new Map(); // token -> { events, agents, wsClients, seq, lastActivity, createdAt }

function createWorkspace() {
  return {
    events: new CircularBuffer(MAX_EVENTS),
    agents: new Map(),
    wsClients: new Set(),
    seq: 0,
    lastActivity: Date.now(),
    createdAt: Date.now(),
  };
}

// Global/default workspace for backward compat (local dev with no tokens)
const globalWorkspace = createWorkspace();

function getWorkspace(token) {
  if (!token) return null;
  const ws = workspaces.get(token);
  if (ws) {
    ws.lastActivity = Date.now();
  }
  return ws || null;
}

function resolveWorkspace(token) {
  // Workspace tokens (moh_*) route to their isolated workspace
  if (token && token.startsWith('moh_')) {
    const ws = getWorkspace(token);
    if (ws) return ws;
    return null; // workspace token provided but not found = invalid
  }
  // No token or non-workspace token (e.g., global API key): use global workspace
  return globalWorkspace;
}

// --- Workspace cleanup ---

function cleanupWorkspaces() {
  const now = Date.now();
  for (const [token, ws] of workspaces) {
    if (now - ws.lastActivity > WORKSPACE_TTL_MS) {
      // Close all WebSocket clients
      for (const client of ws.wsClients) {
        try { client.close(4002, 'Workspace expired'); } catch { /* ignore */ }
      }
      workspaces.delete(token);
    }
  }
}

const cleanupTimer = setInterval(cleanupWorkspaces, CLEANUP_INTERVAL_MS);
cleanupTimer.unref(); // don't prevent process exit

// --- Rate limiter for workspace creation ---

const createRateLimit = { count: 0, resetAt: 0 };
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 20; // max 20 workspaces per minute

function checkCreateRateLimit() {
  const now = Date.now();
  if (now > createRateLimit.resetAt) {
    createRateLimit.count = 0;
    createRateLimit.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  if (createRateLimit.count >= RATE_LIMIT_MAX) return false;
  createRateLimit.count++;
  return true;
}

// --- Helpers ---

function trackAgent(workspace, event) {
  const key = (event.session_id || '') + ':' + (event.agent_id || event.agent_name || 'default');
  workspace.agents.set(key, {
    agent_id: event.agent_id || event.session_id || '',
    agent_type: event.agent_type,
    agent_name: event.agent_name,
    session_id: event.session_id || '',
    teammate_name: event.teammate_name,
    team_name: event.team_name,
    last_seen: event.timestamp,
  });
}

function broadcastToWorkspace(workspace, event) {
  const msg = JSON.stringify(event);
  for (const ws of workspace.wsClients) {
    try {
      ws.send(msg);
    } catch {
      workspace.wsClients.delete(ws);
    }
  }
}

function extractBearerToken(req) {
  const auth = req.headers['authorization'] || '';
  const match = auth.match(/^Bearer\s+(.+)$/);
  return match ? match[1] : null;
}

// --- Task file scanner ---

function scanTaskFiles() {
  const tasksDir = join(process.env.HOME, '.claude/tasks');
  const results = [];
  try {
    if (!existsSync(tasksDir)) return results;
    const teams = readdirSync(tasksDir);
    for (const team of teams) {
      const teamDir = join(tasksDir, team);
      if (!statSync(teamDir).isDirectory()) continue;
      const files = readdirSync(teamDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const content = readFileSync(join(teamDir, file), 'utf-8');
          const parsed = JSON.parse(content);
          results.push({ path: `${team}/${file}`, team, ...parsed });
        } catch { /* skip */ }
      }
    }
  } catch { /* tasks dir may not exist */ }
  return results;
}

// --- Static file serving ---

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveFile(filePath, res) {
  if (existsSync(filePath) && !statSync(filePath).isDirectory()) {
    const ext = extname(filePath);
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
    return true;
  }
  return false;
}

function serveStatic(pathname, res) {
  let filePath = join(FRONTEND_DIR, pathname);
  if (pathname === '/' || pathname === '') {
    filePath = join(FRONTEND_DIR, 'index.html');
  }

  if (serveFile(filePath, res)) return true;

  // SPA fallback
  if (!pathname.includes('.')) {
    const indexPath = join(FRONTEND_DIR, 'index.html');
    if (existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(indexPath));
      return true;
    }
  }

  return false;
}

function serveDashboard(res) {
  const indexPath = join(FRONTEND_DIR, 'index.html');
  if (existsSync(indexPath)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(indexPath));
    return true;
  }
  return false;
}

function serveLanding(res) {
  const landingPath = join(FRONTEND_DIR, 'landing.html');
  if (existsSync(landingPath)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(landingPath));
    return true;
  }
  // Fallback to index.html if no landing page exists
  return serveDashboard(res);
}

// --- Parse request body ---

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// --- HTTP Server ---

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function checkApiKey(req) {
  if (!API_KEY) return true; // no key configured = open access
  const auth = req.headers['authorization'] || '';
  if (auth === `Bearer ${API_KEY}`) return true;
  // Also accept as query param for WebSocket connections
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.searchParams.get('api_key') === API_KEY) return true;
  return false;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  // --- Dashboard route: GET /d/:token ---
  const dashboardMatch = pathname.match(/^\/d\/([^/]+)$/);
  if (dashboardMatch && req.method === 'GET') {
    const token = dashboardMatch[1];
    // Validate token exists
    if (!workspaces.has(token)) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>Workspace not found</h1><p>This workspace does not exist or has expired.</p>');
      return;
    }
    serveDashboard(res);
    return;
  }

  // --- Landing page: GET / ---
  if (pathname === '/' && req.method === 'GET') {
    serveLanding(res);
    return;
  }

  // --- POST /api/workspaces - create a new workspace ---
  if (pathname === '/api/workspaces' && req.method === 'POST') {
    if (!checkCreateRateLimit()) {
      res.writeHead(429, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: 'Rate limit exceeded. Try again later.' }));
      return;
    }

    const token = 'moh_' + randomBytes(24).toString('base64url');
    workspaces.set(token, createWorkspace());

    const host = req.headers['host'] || `localhost:${PORT}`;
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const dashboardUrl = `${protocol}://${host}/d/${token}`;

    res.writeHead(201, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ token, dashboard_url: dashboardUrl }));
    return;
  }

  // --- API key check for POST /api/ endpoints (except /api/workspaces handled above) ---
  if (pathname.startsWith('/api/') && req.method === 'POST') {
    // For workspace-token-based requests, check the token instead of API_KEY
    const bearerToken = extractBearerToken(req);
    if (bearerToken && bearerToken.startsWith('moh_')) {
      // Workspace token auth - just need a valid workspace
      if (!workspaces.has(bearerToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: 'Invalid workspace token' }));
        return;
      }
    } else if (!checkApiKey(req)) {
      // Fall back to API key check for non-workspace tokens
      res.writeHead(401, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  // --- POST /api/events ---
  if (pathname === '/api/events' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const bearerToken = extractBearerToken(req);
      const workspace = resolveWorkspace(bearerToken);

      if (!workspace) {
        res.writeHead(401, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: 'Invalid workspace token' }));
        return;
      }

      const event = {
        ...body,
        timestamp: body.timestamp || new Date().toISOString(),
        _seq: ++workspace.seq,
      };
      workspace.events.push(event);
      trackAgent(workspace, event);
      broadcastToWorkspace(workspace, event);
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ ok: true, seq: event._seq }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  // --- GET /api/events ---
  if (pathname === '/api/events' && req.method === 'GET') {
    const token = url.searchParams.get('token');
    const workspace = resolveWorkspace(token);

    if (!workspace) {
      res.writeHead(401, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: 'Invalid workspace token' }));
      return;
    }

    let result = workspace.events.toArray();

    const sessionId = url.searchParams.get('session_id');
    const agentType = url.searchParams.get('agent_type');
    const toolName = url.searchParams.get('tool_name');
    const hookEventName = url.searchParams.get('hook_event_name');
    const since = url.searchParams.get('since_seq');
    const limit = url.searchParams.get('limit');

    if (sessionId) result = result.filter(e => e.session_id === sessionId);
    if (agentType) result = result.filter(e => e.agent_type === agentType);
    if (toolName) result = result.filter(e => e.tool_name === toolName);
    if (hookEventName) result = result.filter(e => e.hook_event_name === hookEventName);
    if (since) {
      const sinceSeq = parseInt(since, 10);
      result = result.filter(e => (e._seq || 0) > sinceSeq);
    }
    if (limit) {
      const n = parseInt(limit, 10);
      if (n > 0) result = result.slice(-n);
    }

    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(result));
    return;
  }

  // --- GET /api/agents ---
  if (pathname === '/api/agents' && req.method === 'GET') {
    const token = url.searchParams.get('token');
    const workspace = resolveWorkspace(token);

    if (!workspace) {
      res.writeHead(401, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: 'Invalid workspace token' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify([...workspace.agents.values()]));
    return;
  }

  // --- GET /api/tasks ---
  if (pathname === '/api/tasks' && req.method === 'GET') {
    const tasks = scanTaskFiles();
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(tasks));
    return;
  }

  // Static files (CSS, JS, images, etc.)
  if (serveStatic(pathname, res)) return;

  res.writeHead(404);
  res.end('Not Found');
});

// --- WebSocket Server ---

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const token = url.searchParams.get('token');
  const workspace = resolveWorkspace(token);

  if (!workspace) {
    // Send HTTP 401 response before destroying
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    workspace.wsClients.add(ws);
    ws.on('close', () => workspace.wsClients.delete(ws));
    ws.on('error', () => workspace.wsClients.delete(ws));
  });
});

// --- Start ---

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mohano server running at http://0.0.0.0:${PORT}`);
  console.log(`WebSocket endpoint: ws://0.0.0.0:${PORT}/ws`);
  console.log(`Serving frontend from: ${FRONTEND_DIR}`);
  console.log(`API key: ${API_KEY ? 'enabled' : 'disabled (open access)'}`);
  console.log(`Multi-tenant: workspace isolation enabled`);
});
