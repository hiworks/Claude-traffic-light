// HTTP Server — endpoint smoke tests
//
// Uses node:test (Node 20+ built-in). Each test gets its own port range
// (20000 + Math.random() * 1000) so port-reuse across tests is impossible.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHttpServer } = require('../src/status/http-server');
const { createSessionManager } = require('../src/status/session-manager');

function makeServer() {
  // Pick a unique port range for each test to avoid cross-test interference.
  const basePort = 20000 + Math.floor(Math.random() * 1000);
  const sessionMgr = createSessionManager(() => {});
  const httpServer = createHttpServer(sessionMgr, { basePort });
  return { sessionMgr, httpServer };
}

test('start binds a port and stop releases it', async () => {
  const { httpServer } = makeServer();
  const port = await httpServer.start();
  assert.ok(Number.isInteger(port) && port > 0);
  assert.equal(httpServer.getPort(), port);
  await httpServer.stop();
  assert.equal(httpServer.getPort(), port, 'port stays readable after stop');
});

test('GET /status returns 200 with sessions array', async () => {
  const { httpServer } = makeServer();
  const port = await httpServer.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body = await res.json();
    assert.ok(Array.isArray(body.sessions));
    assert.equal(body.sessions.length, 0);
  } finally {
    await httpServer.stop();
  }
});

test('GET /status reflects current sessions', async () => {
  const { httpServer, sessionMgr } = makeServer();
  sessionMgr.handleHookEvent('PreToolUse', { sessionId: 's1', tool: 'Bash' });
  const port = await httpServer.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    const body = await res.json();
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].id, 's1');
    assert.equal(body.active, 'working');
  } finally {
    await httpServer.stop();
  }
});

test('POST /hook accepts event and updates session', async () => {
  const { httpServer, sessionMgr } = makeServer();
  const port = await httpServer.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'PreToolUse',
        tool: 'Bash',
        sessionId: 's1',
        cwd: 'C:\\projects\\demo',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.event, 'PreToolUse');

    assert.equal(sessionMgr.getStatus().sessions[0].label, 'demo');
  } finally {
    await httpServer.stop();
  }
});

test('POST /hook with invalid JSON still returns 200 (defensive parse)', async () => {
  const { httpServer } = makeServer();
  const port = await httpServer.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-valid-json{',
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  } finally {
    await httpServer.stop();
  }
});

test('POST /hook without sessionId / claudePid silently no-ops', async () => {
  const { httpServer, sessionMgr } = makeServer();
  const port = await httpServer.start();
  try {
    await fetch(`http://127.0.0.1:${port}/hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'PreToolUse', tool: 'Bash' }),
    });
    assert.equal(sessionMgr.getStatus().sessions.length, 0);
  } finally {
    await httpServer.stop();
  }
});

test('GET /unknown-path returns 404', async () => {
  const { httpServer } = makeServer();
  const port = await httpServer.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'Not found');
  } finally {
    await httpServer.stop();
  }
});

test('OPTIONS preflight returns 204 with CORS headers', async () => {
  const { httpServer } = makeServer();
  const port = await httpServer.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/hook`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.ok(res.headers.get('access-control-allow-methods').includes('POST'));
  } finally {
    await httpServer.stop();
  }
});

test('CORS headers present on regular responses', async () => {
  const { httpServer } = makeServer();
  const port = await httpServer.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  } finally {
    await httpServer.stop();
  }
});

test('Falls back to next port when basePort is busy', async () => {
  // Occupy a port first
  const blocker = createHttpServer(createSessionManager(() => {}), { basePort: 25000 });
  const occupiedPort = await blocker.start();

  const { httpServer } = makeServer();
  // Pick the same basePort as the blocker to force fallback
  const fallback = createHttpServer(createSessionManager(() => {}), { basePort: 25000 });
  try {
    const port = await fallback.start();
    assert.notEqual(port, occupiedPort, 'should not bind the occupied port');
    assert.ok(port > occupiedPort, 'should have moved to a higher port');
  } finally {
    await fallback.stop();
    await blocker.stop();
  }
});

test('start rejects when no port in range is available', async () => {
  // Block a small range and then try to start a server on the same range
  // with maxAttempts=1 so there's no room to fall back.
  const blocker = createHttpServer(createSessionManager(() => {}), { basePort: 25100, maxAttempts: 1 });
  await blocker.start();

  const starved = createHttpServer(createSessionManager(() => {}), { basePort: 25100, maxAttempts: 1 });
  try {
    await assert.rejects(starved.start(), /No available port/);
  } finally {
    await blocker.stop();
    await starved.stop();
  }
});
