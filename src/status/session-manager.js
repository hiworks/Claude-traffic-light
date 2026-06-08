// Session Manager — Single source of truth for Claude Code sessions.
//
// State machine (per session):
//   idle → working     (PreToolUse received)
//   working → working  (PostToolUse, start 3s waiting timer)
//   working → waiting  (3s timeout, no new action)
//   waiting → working  (PreToolUse received)
//   * → idle           (Stop / SessionEnd, or stale timeout)
//   * → removed        (idle for 5 minutes → cleaned up)
//
// Session identity (in priority order):
//   1. data.session_id from Claude Code hook payload
//   2. claude-${claudePid} as fallback (always set by helper script)
//
// Label source: basename of cwd from hook payload. Set once on first event.

const WAITING_TIMEOUT_MS = 3000;
const STALE_TIMEOUT_MS = 60000;      // 60s no events → mark idle
const REMOVAL_TIMEOUT_MS = 300000;   // 5 min idle → remove session
const DEBOUNCE_MS = 50;

function createSession(id, pid) {
  return {
    id,
    pid: pid || null,
    status: 'idle',
    toolName: null,
    cwd: '',
    label: '',
    lastActivity: Date.now(),
    staleTimer: null,
    waitingTimer: null,
    removalTimer: null,
  };
}

function extractCwdBasename(cwd) {
  if (!cwd || typeof cwd !== 'string') return '';
  // Strip trailing slashes, then take last segment
  const normalized = cwd.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]/);
  const last = parts[parts.length - 1] || '';
  // Skip if it's just a drive letter ("C:") or shorter
  if (last.length < 2) return '';
  if (/^[A-Za-z]:$/.test(last)) return '';
  return last;
}

function createSessionManager(broadcastFn) {
  const sessions = new Map();
  let activeSessionId = null;
  let debounceTimer = null;

  function scheduleBroadcast() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      try { broadcastFn(); } catch {}
    }, DEBOUNCE_MS);
  }

  function getOrCreateSession(id, pid) {
    let s = sessions.get(id);
    if (!s) {
      s = createSession(id, pid);
      sessions.set(id, s);
      if (!activeSessionId) activeSessionId = id;
    } else if (pid && !s.pid) {
      s.pid = pid;
    }
    return s;
  }

  function clearTimers(session) {
    if (session.staleTimer) { clearTimeout(session.staleTimer); session.staleTimer = null; }
    if (session.waitingTimer) { clearTimeout(session.waitingTimer); session.waitingTimer = null; }
    if (session.removalTimer) { clearTimeout(session.removalTimer); session.removalTimer = null; }
  }

  function restartStaleTimer(session) {
    if (session.staleTimer) clearTimeout(session.staleTimer);
    session.staleTimer = setTimeout(() => {
      // No events for 60s → mark idle
      if (session.status === 'working' || session.status === 'waiting') {
        session.status = 'idle';
        session.toolName = null;
        scheduleBroadcast();
      }
      // Schedule removal after extended idle
      if (!session.removalTimer) {
        session.removalTimer = setTimeout(() => {
          sessions.delete(session.id);
          if (activeSessionId === session.id) {
            activeSessionId = sessions.size > 0 ? sessions.keys().next().value : null;
          }
          scheduleBroadcast();
        }, REMOVAL_TIMEOUT_MS);
      }
    }, STALE_TIMEOUT_MS);
  }

  function handleHookEvent(event, data) {
    // Resolve session id
    const pid = data.claudePid || null;
    let sessionId = data.sessionId || data.session_id || (pid ? `claude-${pid}` : null);
    if (!sessionId) return;

    // Resolve cwd → label (one-shot, set on first event for this session)
    const cwd = data.cwd || '';
    const label = extractCwdBasename(cwd);

    const session = getOrCreateSession(sessionId, pid);
    clearTimers(session);
    restartStaleTimer(session);
    session.lastActivity = Date.now();

    // Set label/cwd on first encounter
    if (!session.label && label) {
      session.label = label;
      session.cwd = cwd;
    } else if (label && cwd && !session.cwd) {
      // cwd was missing initially but provided now
      session.cwd = cwd;
    }

    // Make this the active session
    activeSessionId = sessionId;

    // State machine transitions
    switch (event) {
      case 'PreToolUse': {
        session.status = 'working';
        session.toolName = data.tool || data.tool_name || 'unknown';
        break;
      }
      case 'PostToolUse': {
        session.status = 'working';
        session.toolName = data.tool || data.tool_name || 'unknown';
        // After a tool completes, if no new tool starts within 3s, mark waiting
        if (session.waitingTimer) clearTimeout(session.waitingTimer);
        session.waitingTimer = setTimeout(() => {
          session.waitingTimer = null;
          // Only transition if the session has been quiet for at least the full timeout
          if (session.status === 'working' && Date.now() - session.lastActivity >= WAITING_TIMEOUT_MS - 100) {
            session.status = 'waiting';
            session.toolName = null;
            scheduleBroadcast();
          }
        }, WAITING_TIMEOUT_MS);
        break;
      }
      case 'Stop':
      case 'SessionEnd':
      case 'ElicitationResult':
      case 'Notification': {
        if (event === 'Notification') {
          // Some Notification types are idle-intent. Treat conservatively.
          const subtype = data.notification_type || data.subtype;
          if (subtype !== 'idle_prompt' && subtype !== 'permission_prompt') {
            // Not idle-intent — skip state change AND the broadcast at
            // the bottom of this function (break would still trigger one).
            return;
          }
        }
        session.status = 'idle';
        session.toolName = null;
        break;
      }
      default:
        return;
    }

    scheduleBroadcast();
  }

  function getStatus() {
    const sessionList = Array.from(sessions.values()).map((s) => ({
      id: s.id,
      pid: s.pid,
      status: s.status,
      toolName: s.toolName,
      label: s.label,
      cwd: s.cwd,
      lastActivity: s.lastActivity,
    }));

    const active = sessions.get(activeSessionId);
    const overallStatus = active ? active.status : (sessionList[0]?.status || 'idle');

    return {
      sessions: sessionList,
      activeSessionId,
      active: overallStatus,
    };
  }

  function setActiveSession(sessionId) {
    if (sessions.has(sessionId)) {
      activeSessionId = sessionId;
      scheduleBroadcast();
    }
  }

  function cleanup() {
    for (const session of sessions.values()) {
      clearTimers(session);
    }
    sessions.clear();
  }

  return {
    handleHookEvent,
    setActiveSession,
    getStatus,
    cleanup,
  };
}

module.exports = { createSessionManager, extractCwdBasename };
