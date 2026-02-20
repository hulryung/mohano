// Mohano - Multi-agent monitoring server
// Node.js server for Claude Code hook event ingestion and visualization

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '7777', 10);
const MAX_EVENTS = parseInt(process.env.MAX_EVENTS || '2000', 10);
const API_KEY = process.env.MOHANO_API_KEY || '';
const FRONTEND_DIR = resolve(__dirname, '../frontend');

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

// --- State ---

const events = new CircularBuffer(MAX_EVENTS);
const agents = new Map();
const wsClients = new Set();
let seq = 0;

// --- Helpers ---

function trackAgent(event) {
  const key = (event.session_id || '') + ':' + (event.agent_id || event.agent_name || 'default');
  agents.set(key, {
    agent_id: event.agent_id || event.session_id || '',
    agent_type: event.agent_type,
    agent_name: event.agent_name,
    session_id: event.session_id || '',
    teammate_name: event.teammate_name,
    team_name: event.team_name,
    last_seen: event.timestamp,
  });
}

function broadcast(event) {
  const msg = JSON.stringify(event);
  for (const ws of wsClients) {
    try {
      ws.send(msg);
    } catch {
      wsClients.delete(ws);
    }
  }
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

function serveStatic(pathname, res) {
  let filePath = join(FRONTEND_DIR, pathname);
  if (pathname === '/' || pathname === '') {
    filePath = join(FRONTEND_DIR, 'index.html');
  }

  if (existsSync(filePath) && !statSync(filePath).isDirectory()) {
    const ext = extname(filePath);
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
    return true;
  }

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

  // API key check for POST /api/ endpoints only (GET and WebSocket are public)
  if (pathname.startsWith('/api/') && req.method === 'POST' && !checkApiKey(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  // POST /api/events
  if (pathname === '/api/events' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const event = {
        ...body,
        timestamp: body.timestamp || new Date().toISOString(),
        _seq: ++seq,
      };
      events.push(event);
      trackAgent(event);
      broadcast(event);
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ ok: true, seq: event._seq }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
    return;
  }

  // GET /api/events
  if (pathname === '/api/events' && req.method === 'GET') {
    let result = events.toArray();

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

  // GET /api/agents
  if (pathname === '/api/agents' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify([...agents.values()]));
    return;
  }

  // GET /api/tasks
  if (pathname === '/api/tasks' && req.method === 'GET') {
    const tasks = scanTaskFiles();
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(tasks));
    return;
  }

  // Static files
  if (serveStatic(pathname, res)) return;

  res.writeHead(404);
  res.end('Not Found');
});

// --- WebSocket Server ---

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
});

// --- Start ---

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mohano server running at http://0.0.0.0:${PORT}`);
  console.log(`WebSocket endpoint: ws://0.0.0.0:${PORT}/ws`);
  console.log(`Serving frontend from: ${FRONTEND_DIR}`);
  console.log(`API key: ${API_KEY ? 'enabled' : 'disabled (open access)'}`);
});
