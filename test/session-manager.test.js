// Session Manager — state machine and pure helpers
//
// Uses node:test (Node 20+ built-in). Pure logic only — no Electron.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSessionManager,
  extractCwdBasename,
} = require('../src/status/session-manager');

// ---- extractCwdBasename -----------------------------------------------------

test('extractCwdBasename: standard Windows backslash path', () => {
  assert.equal(extractCwdBasename('C:\\Users\\me\\projects\\foo'), 'foo');
});

test('extractCwdBasename: forward-slash path', () => {
  assert.equal(extractCwdBasename('/home/me/projects/foo'), 'foo');
});

test('extractCwdBasename: strips trailing slash', () => {
  assert.equal(extractCwdBasename('C:\\Users\\me\\projects\\foo\\'), 'foo');
  assert.equal(extractCwdBasename('/home/me/foo/'), 'foo');
});

test('extractCwdBasename: empty / null / undefined / non-string', () => {
  assert.equal(extractCwdBasename(''), '');
  assert.equal(extractCwdBasename(null), '');
  assert.equal(extractCwdBasename(undefined), '');
  assert.equal(extractCwdBasename(42), '');
});

test('extractCwdBasename: bare drive root returns empty', () => {
  // Last segment is "C:" — only 2 chars and counts as drive letter, skipped.
  assert.equal(extractCwdBasename('C:\\'), '');
  assert.equal(extractCwdBasename('C:/'), '');
});

test('extractCwdBasename: Chinese / Unicode preserved', () => {
  assert.equal(
    extractCwdBasename('C:\\Users\\me\\项目\\claude-红绿灯'),
    'claude-红绿灯',
  );
});

// ---- State machine: basic transitions ---------------------------------------

test('PreToolUse creates a working session and sets it active', () => {
  const mgr = createSessionManager(() => {});
  mgr.handleHookEvent('PreToolUse', { sessionId: 's1', tool: 'Bash' });

  const status = mgr.getStatus();
  assert.equal(status.sessions.length, 1);
  assert.equal(status.sessions[0].id, 's1');
  assert.equal(status.sessions[0].status, 'working');
  assert.equal(status.sessions[0].toolName, 'Bash');
  assert.equal(status.activeSessionId, 's1');
  assert.equal(status.active, 'working');
});

test('PreToolUse accepts tool_name as fallback to tool', () => {
  const mgr = createSessionManager(() => {});
  mgr.handleHookEvent('PreToolUse', { sessionId: 's1', tool_name: 'Read' });
  assert.equal(mgr.getStatus().sessions[0].toolName, 'Read');
});

test('Unknown event is dropped: no broadcast, no state transition', () => {
  const broadcasts = [];
  const mgr = createSessionManager(() => broadcasts.push(true));
  mgr.handleHookEvent('WeirdThing', { sessionId: 's1' });
  // Session is still created (so timers refresh and activeSessionId is set),
  // but the unknown event must not change status and must not broadcast.
  assert.equal(mgr.getStatus().sessions[0].status, 'idle');
  assert.equal(broadcasts.length, 0);
});

test('Event without sessionId / claudePid is dropped', () => {
  const mgr = createSessionManager(() => {});
  mgr.handleHookEvent('PreToolUse', { tool: 'Bash' });
  assert.equal(mgr.getStatus().sessions.length, 0);
});

test('Stop / SessionEnd / ElicitationResult transition to idle', () => {
  for (const evt of ['Stop', 'SessionEnd', 'ElicitationResult']) {
    const mgr = createSessionManager(() => {});
    mgr.handleHookEvent('PreToolUse', { sessionId: 's1' });
    mgr.handleHookEvent(evt, { sessionId: 's1' });
    assert.equal(mgr.getStatus().active, 'idle', `event=${evt} should idle`);
  }
});

// ---- Notification -----------------------------------------------------------

test('Notification with idle_prompt transitions to idle', () => {
  const mgr = createSessionManager(() => {});
  mgr.handleHookEvent('PreToolUse', { sessionId: 's1' });
  mgr.handleHookEvent('Notification', { sessionId: 's1', notification_type: 'idle_prompt' });
  assert.equal(mgr.getStatus().active, 'idle');
});

test('Notification with permission_prompt transitions to idle', () => {
  const mgr = createSessionManager(() => {});
  mgr.handleHookEvent('PreToolUse', { sessionId: 's1' });
  mgr.handleHookEvent('Notification', { sessionId: 's1', notification_type: 'permission_prompt' });
  assert.equal(mgr.getStatus().active, 'idle');
});

test('Notification with unrelated subtype leaves state alone AND does not broadcast', () => {
  const broadcasts = [];
  const mgr = createSessionManager(() => broadcasts.push(true));
  mgr.handleHookEvent('PreToolUse', { sessionId: 's1' });
  broadcasts.length = 0; // clear the initial debounced broadcast

  mgr.handleHookEvent('Notification', { sessionId: 's1', notification_type: 'random' });

  assert.equal(mgr.getStatus().sessions[0].status, 'working');
  assert.equal(broadcasts.length, 0, 'return must skip the trailing scheduleBroadcast');
});

test('Notification without subtype leaves state alone', () => {
  const mgr = createSessionManager(() => {});
  mgr.handleHookEvent('PreToolUse', { sessionId: 's1' });
  mgr.handleHookEvent('Notification', { sessionId: 's1' });
  assert.equal(mgr.getStatus().sessions[0].status, 'working');
});

// ---- PostToolUse → waiting --------------------------------------------------

test('PostToolUse transitions to waiting after WAITING_TIMEOUT_MS', async () => {
  const mgr = createSessionManager(() => {});
  mgr.handleHookEvent('PreToolUse', { sessionId: 's1', tool: 'Bash' });
  mgr.handleHookEvent('PostToolUse', { sessionId: 's1', tool: 'Bash' });
  assert.equal(mgr.getStatus().active, 'working');

  // WAITING_TIMEOUT_MS is 3000; wait a bit longer than that to absorb scheduling
  // slop, but don't wait the full 60s stale timeout.
  await new Promise((r) => setTimeout(r, 3200));
  assert.equal(mgr.getStatus().active, 'waiting');
});

// ---- Identity / fallback ----------------------------------------------------

test('Falls back to claude-${pid} when sessionId is missing', () => {
  const mgr = createSessionManager(() => {});
  mgr.handleHookEvent('PreToolUse', { claudePid: 12345, tool: 'Bash' });
  const s = mgr.getStatus().sessions[0];
  assert.equal(s.id, 'claude-12345');
  assert.equal(s.pid, 12345);
});

test('Accepts both sessionId and session_id spellings', () => {
  const mgr = createSessionManager(() => {});
  mgr.handleHookEvent('PreToolUse', { session_id: 's-snake' });
  assert.equal(mgr.getStatus().sessions[0].id, 's-snake');
});

test('Label is set from cwd basename on first event for a session', () => {
  const mgr = createSessionManager(() => {});
  mgr.handleHookEvent('PreToolUse', { sessionId: 's1', cwd: 'C:\\Users\\me\\projects\\foo' });
  const s = mgr.getStatus().sessions[0];
  assert.equal(s.label, 'foo');
  assert.equal(s.cwd, 'C:\\Users\\me\\projects\\foo');
});

test('Label is not overwritten on subsequent events', () => {
  const mgr = createSessionManager(() => {});
  mgr.handleHookEvent('PreToolUse', { sessionId: 's1', cwd: 'C:\\foo' });
  mgr.handleHookEvent('PreToolUse', { sessionId: 's1', cwd: 'C:\\bar' });
  assert.equal(mgr.getStatus().sessions[0].label, 'foo');
});

// ---- Multi-session / active management -------------------------------------

test('Multiple sessions coexist; active follows latest event', () => {
  const mgr = createSessionManager(() => {});
  mgr.handleHookEvent('PreToolUse', { sessionId: 'a' });
  mgr.handleHookEvent('PreToolUse', { sessionId: 'b' });
  const status = mgr.getStatus();
  assert.equal(status.sessions.length, 2);
  assert.equal(status.activeSessionId, 'b');
  assert.equal(status.active, 'working');
});

test('setActiveSession switches active and broadcasts (after debounce)', async () => {
  const broadcasts = [];
  const mgr = createSessionManager(() => broadcasts.push(true));
  mgr.handleHookEvent('PreToolUse', { sessionId: 'a' });
  mgr.handleHookEvent('PreToolUse', { sessionId: 'b' });
  broadcasts.length = 0;

  mgr.setActiveSession('a');
  assert.equal(mgr.getStatus().activeSessionId, 'a');
  // DEBOUNCE_MS = 50; nothing fires synchronously
  assert.equal(broadcasts.length, 0);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(broadcasts.length, 1);
});

test('setActiveSession ignores unknown id', () => {
  const mgr = createSessionManager(() => {});
  mgr.handleHookEvent('PreToolUse', { sessionId: 'a' });
  mgr.setActiveSession('does-not-exist');
  assert.equal(mgr.getStatus().activeSessionId, 'a');
});

// ---- Cleanup ----------------------------------------------------------------

test('cleanup clears all sessions', () => {
  const mgr = createSessionManager(() => {});
  mgr.handleHookEvent('PreToolUse', { sessionId: 'a' });
  mgr.handleHookEvent('PreToolUse', { sessionId: 'b' });
  mgr.cleanup();
  assert.equal(mgr.getStatus().sessions.length, 0);
});

// ---- Broadcast debounce -----------------------------------------------------

test('Rapid back-to-back events are coalesced into a single broadcast', async () => {
  const broadcasts = [];
  const mgr = createSessionManager(() => broadcasts.push(true));
  mgr.handleHookEvent('PreToolUse', { sessionId: 'a' });
  mgr.handleHookEvent('PostToolUse', { sessionId: 'a', tool: 'Edit' });
  mgr.handleHookEvent('PreToolUse', { sessionId: 'a', tool: 'Bash' });
  mgr.handleHookEvent('PreToolUse', { sessionId: 'a', tool: 'Read' });

  // DEBOUNCE_MS = 50; nothing should have fired yet.
  assert.equal(broadcasts.length, 0);

  await new Promise((r) => setTimeout(r, 80));
  assert.equal(broadcasts.length, 1);
});
