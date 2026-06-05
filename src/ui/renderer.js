// Claude Traffic Light — Renderer

const STATUS_LABELS = { idle: '空闲', waiting: '等待输入', working: '工作中' };
const STATUS_COLORS = { idle: 'green', waiting: 'yellow', working: 'red' };

let currentStatus = 'idle';
let sessions = [];
let activeSessionId = null;
let currentScale = 1.0;
let isLocked = false;

const redLight = document.getElementById('redLight');
const yellowLight = document.getElementById('yellowLight');
const greenLight = document.getElementById('greenLight');
const widget = document.getElementById('lightWidget');
const sessionDotsContainer = document.getElementById('sessionDots');
const lockBtn = document.getElementById('lockBtn');

// ---- Tooltip via IPC: sends position to main process for overlay window ----

let tooltipHideTimer = null;

function showTooltipFor(anchorEl, text, placement) {
  clearTimeout(tooltipHideTimer);

  const anchorRect = anchorEl.getBoundingClientRect();

  // Calculate screen position using Electron's screenX/screenY
  let screenX = window.screenX + anchorRect.left + anchorRect.width / 2;
  let screenY;

  if (placement === 'top') {
    screenY = window.screenY + anchorRect.top - 8;
  } else {
    screenY = window.screenY + anchorRect.bottom + 8;
  }

  window.__claudeLight.showTooltip(text, Math.round(screenX), Math.round(screenY));
}

function hideTooltip() {
  tooltipHideTimer = setTimeout(() => {
    window.__claudeLight.hideTooltip();
  }, 150);
}

// ---- Status ----

function setActiveLight(status) {
  const lights = { red: redLight, yellow: yellowLight, green: greenLight };
  Object.entries(lights).forEach(([color, el]) => {
    el.classList.toggle('active', color === STATUS_COLORS[status]);
  });
  currentStatus = status;
}

function handleStatusUpdate(data) {
  sessions = data.sessions || [];

  // Only auto-switch active session if NOT locked
  if (!isLocked && data.activeSessionId) {
    activeSessionId = data.activeSessionId;
  }

  // If locked session no longer exists, unlock
  if (isLocked && activeSessionId && !sessions.find((s) => s.id === activeSessionId)) {
    isLocked = false;
    lockBtn.classList.remove('locked');
    lockBtn.textContent = '🔓';
    if (data.activeSessionId) activeSessionId = data.activeSessionId;
  }

  const activeSession = sessions.find((s) => s.id === activeSessionId) || sessions[0];
  if (activeSession) {
    setActiveLight(activeSession.status);
  } else {
    setActiveLight('idle');
  }

  // Session dots — one dot per session, colored by status
  sessionDotsContainer.innerHTML = '';
  if (sessions.length >= 1) {
    sessions.forEach((session) => {
      const dot = document.createElement('div');
      dot.className = `session-dot ${session.id === activeSessionId ? 'active' : ''}`;
      dot.dataset.status = session.status;

      // Build tooltip text — show label (project dir) if available, else PID
      const statusLabel = STATUS_LABELS[session.status] || session.status;
      const toolInfo = session.status === 'working' && session.toolName ? ` · ${session.toolName}` : '';
      const namePart = session.label || `#${session.id.replace('claude-', '')}`;
      const tooltipContent = `${namePart} · ${statusLabel}${toolInfo}`;

      dot.addEventListener('mouseenter', () => showTooltipFor(dot, tooltipContent, 'top'));
      dot.addEventListener('mouseleave', hideTooltip);
      dot.addEventListener('click', () => {
        activeSessionId = session.id;
        window.__claudeLight.switchSession(session.id);
        updateDotsActiveState();
        updateLockTooltip();
      });
      sessionDotsContainer.appendChild(dot);
    });
    updateLockTooltip();
  }
}

function updateDotsActiveState() {
  const dots = sessionDotsContainer.querySelectorAll('.session-dot');
  dots.forEach((dot, i) => {
    const session = sessions[i];
    if (session) {
      dot.classList.toggle('active', session.id === activeSessionId);
    }
  });
}

// ---- Lock toggle ----
function updateLockTooltip() {
  if (isLocked) {
    const activeSession = sessions.find(s => s.id === activeSessionId);
    if (activeSession) {
      const name = activeSession.label || `#${activeSession.id.replace('claude-', '')}`;
      const statusLabel = STATUS_LABELS[activeSession.status] || '';
      lockBtn.dataset.tooltipText = `已锁定 · ${name} · ${statusLabel}`;
    } else {
      lockBtn.dataset.tooltipText = '已锁定';
    }
  } else {
    lockBtn.dataset.tooltipText = '点击锁定当前会话';
  }
}

lockBtn.addEventListener('mouseenter', () => {
  const text = lockBtn.dataset.tooltipText || '点击锁定当前会话';
  showTooltipFor(lockBtn, text, 'top');
});
lockBtn.addEventListener('mouseleave', hideTooltip);

lockBtn.addEventListener('click', () => {
  isLocked = !isLocked;
  lockBtn.classList.toggle('locked', isLocked);
  lockBtn.textContent = isLocked ? '🔒' : '🔓';
  updateLockTooltip();
});

function handleSizeChange(mode) {
  widget.classList.toggle('mini', mode === 'mini');
}

// ---- Ctrl + Scroll: Custom Scale ----
// Note: the widget uses a responsive layout (fills the BrowserWindow), so
// we don't apply CSS transforms here — that would just create a layout
// overflow and get clipped. Instead, we ask the main process to resize
// the window, and the widget fills the new size automatically.
document.addEventListener('wheel', (event) => {
  if (!event.ctrlKey) return;
  event.preventDefault();

  const delta = event.deltaY > 0 ? -0.05 : 0.05;
  currentScale = Math.max(0.5, Math.min(2.0, currentScale + delta));

  // Notify main process of new size — main resizes the window, CSS handles the rest
  window.__claudeLight.setScale(currentScale);
}, { passive: false });

document.addEventListener('dblclick', () => {
  widget.classList.add('switching');
  setTimeout(() => widget.classList.remove('switching'), 300);
  window.__claudeLight.snapToClaude();
});

async function init() {
  try {
    const state = await window.__claudeLight.getWindowState();
    handleSizeChange(state.sizeMode);
    currentScale = state.scale ?? 0.4;
    // No CSS transform here — the window is already sized correctly by main.js,
    // and the widget fills the window via responsive CSS.
  } catch {}

  try {
    const status = await window.__claudeLight.getInitialStatus();
    handleStatusUpdate(status);
  } catch {}

  window.__claudeLight.onStatusUpdate(handleStatusUpdate);
  window.__claudeLight.onSizeChanged(handleSizeChange);
  window.__claudeLight.onScaleChanged((scale) => {
    // Main process resized the window; just sync our local scale value.
    currentScale = scale;
  });

  updateLockTooltip();
}

init();
