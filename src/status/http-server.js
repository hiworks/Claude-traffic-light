// HTTP Server — Receives Claude Code hook notifications
//
// Endpoints:
//   POST /hook  — receives hook events from Claude Code
//   GET /status — returns current session status (for debugging)

const http = require('http');

const BASE_PORT = 9527;
const MAX_PORT_ATTEMPTS = 5;
const PORT_RANGE_END = BASE_PORT + MAX_PORT_ATTEMPTS;

function createHttpServer(sessionManager, options = {}) {
  const basePort = options.basePort ?? BASE_PORT;
  const maxAttempts = options.maxAttempts ?? MAX_PORT_ATTEMPTS;
  const portRangeEnd = basePort + maxAttempts - 1;
  let server = null;
  let actualPort = null;

  function findAvailablePort(startPort) {
    return new Promise((resolve, reject) => {
      let port = startPort;

      function tryPort() {
        if (port > portRangeEnd) {
          reject(new Error(`No available port in range ${startPort}-${portRangeEnd}`));
          return;
        }

        const testServer = http.createServer();
        testServer.on('error', () => {
          port++;
          tryPort();
        });
        testServer.listen(port, '127.0.0.1', () => {
          testServer.close(() => resolve(port));
        });
      }

      tryPort();
    });
  }

  function parseHookData(body) {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }

  async function handleHook(req, res) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    const data = parseHookData(body);

    // Extract event type from the hook data
    const event = data.event || 'Unknown';

    // Forward the enriched payload to the session manager
    // (Claude Code's hook payload already contains session_id, cwd, tool_name)
    sessionManager.handleHookEvent(event, data);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, event }));
  }

  function handleStatus(req, res) {
    const status = sessionManager.getStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  }

  function handleRequest(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/hook') {
      handleHook(req, res);
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      handleStatus(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  async function start() {
    actualPort = await findAvailablePort(basePort);

    server = http.createServer(handleRequest);

    return new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(actualPort, '127.0.0.1', () => {
        console.log(`Traffic Light HTTP server listening on port ${actualPort}`);
        resolve(actualPort);
      });
    });
  }

  function stop() {
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => {
        server = null;
        resolve();
      });
    });
  }

  function getPort() {
    return actualPort;
  }

  return { start, stop, getPort };
}

module.exports = { createHttpServer };
