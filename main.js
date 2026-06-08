const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  screen,
  nativeImage,
  dialog,
} = require('electron');
const path = require('path');
const { createHttpServer } = require('./src/status/http-server');
const { createSessionManager } = require('./src/status/session-manager');
const { createTrayManager } = require('./src/tray/tray');
const { createStore } = require('./src/config/store');
const { install: installHooks } = require('./src/config/hook-installer');
const { findClaudeWindow } = require('./src/utils/find-claude-window');
const { isBoundsVisible, defaultBounds } = require('./src/utils/bounds');
const { disableDwmShadow } = require('./src/utils/dwm-shadow');

// Suppress GPU cache errors on Windows
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

const BASE_SIZE = { width: 130, height: 340 };
const NORMAL_SIZE = { width: 130, height: 340 };
const MINI_SIZE = { width: 76, height: 196 };
const DEFAULT_SCALE = 1 / 2.5; // 0.4

let mainWindow = null;
let tooltipWindow = null;
let tray = null;
let httpServer = null;
let sessionManager = null;
let store = null;
let followTimer = null;

// ---- Follow Terminal: dynamically snap to terminal window position ----

async function followTerminalLoop() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    stopFollowTerminal();
    return;
  }

  try {
    const claudeBounds = await findClaudeWindow();
    const trafficBounds = mainWindow.getBounds();

    // Place flush against the terminal's perceived edge — no breathing
    // room. The widget is meant to sit tightly beside Claude Code, like
    // a real hardware indicator panel. We use content width (BASE_SIZE
    // × scale), not the full window width, so any future chrome/frame
    // doesn't widen the gap.
    const scale = store.get('scale') ?? DEFAULT_SCALE;
    const contentW = Math.round(BASE_SIZE.width * scale);
    let targetX = claudeBounds.left - contentW;
    if (targetX < 0) {
      targetX = claudeBounds.right;
    }
    const targetY = claudeBounds.top;

    const [currentX, currentY] = mainWindow.getPosition();
    if (currentX !== targetX || currentY !== targetY) {
      mainWindow.setPosition(targetX, targetY);
    }
  } catch {
    // Terminal not found — keep current position
  }

  // Re-schedule only if still enabled. 300ms keeps the widget visibly
  // tracking the terminal without spawning a PowerShell process every 50ms
  // (which would burn CPU for as long as follow-terminal stays on).
  if (store.get('followTerminal')) {
    followTimer = setTimeout(followTerminalLoop, 300);
  }
}

function startFollowTerminal() {
  if (followTimer) return; // already running
  followTerminalLoop();
}

function stopFollowTerminal() {
  if (followTimer) {
    clearTimeout(followTimer);
    followTimer = null;
  }
}

function createWindow() {
  const savedBounds = store.get('windowBounds');
  const allDisplays = screen.getAllDisplays();

  const scale = store.get('scale') ?? DEFAULT_SCALE;
  const winW = Math.round(BASE_SIZE.width * scale);
  const winH = Math.round(BASE_SIZE.height * scale);

  // Validate saved bounds are within visible screen area on ANY current
  // display. The old check only tested against the primary display, so a
  // resolution change or unplugged secondary monitor could leave the
  // window outside any visible work area — process alive, widget invisible.
  let startX;
  let startY;
  if (
    savedBounds &&
    isBoundsVisible(
      { x: savedBounds.x, y: savedBounds.y, width: winW, height: winH },
      allDisplays,
    )
  ) {
    startX = savedBounds.x;
    startY = savedBounds.y;
  } else {
    const fallback = defaultBounds(allDisplays, winW, winH);
    startX = fallback.x;
    startY = fallback.y;
  }

  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x: startX,
    y: startY,
    frame: false,
    transparent: false,
    backgroundColor: '#2e2e33',
    resizable: true,
    alwaysOnTop: store.get('alwaysOnTop') ?? true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Proportional resize: lock aspect ratio, set min/max
  mainWindow.setAspectRatio(BASE_SIZE.width / BASE_SIZE.height);
  mainWindow.setMinimumSize(
    Math.round(BASE_SIZE.width * 0.2),
    Math.round(BASE_SIZE.height * 0.2),
  );
  mainWindow.setMaximumSize(
    Math.round(BASE_SIZE.width * 3),
    Math.round(BASE_SIZE.height * 3),
  );

  // On window resize, calculate new scale and notify renderer
  mainWindow.on('resize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const [w] = mainWindow.getSize();
    const newScale = w / BASE_SIZE.width;
    store.set('scale', newScale);
    mainWindow.webContents.send('scale-changed', newScale);
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'ui', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    const opacity = store.get('opacity') ?? 1.0;
    mainWindow.setOpacity(opacity);
    // Disable DWM non-client rendering — Electron's `hasShadow: false`
    // does not stop Windows' DWM from drawing a 5-10px halo around the
    // window. The halo is what makes the widget look "floating" beside
    // the terminal even when the rects are flush. Setting
    // DWMWA_NCRENDERING_POLICY = DWMNCRP_DISABLED tells DWM to skip the
    // non-client paint pass entirely.
    disableDwmShadow(mainWindow);
    mainWindow.show();
  });

  mainWindow.on('moved', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getBounds();
      store.set('windowBounds', { x: bounds.x, y: bounds.y });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Recover from "widget disappeared, process still in tray" by clearing
// the saved bounds and snapping the window back to a visible default.
function resetWindowPosition() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const scale = store.get('scale') ?? DEFAULT_SCALE;
  const winW = Math.round(BASE_SIZE.width * scale);
  const winH = Math.round(BASE_SIZE.height * scale);
  const fallback = defaultBounds(screen.getAllDisplays(), winW, winH);

  store.set('windowBounds', { x: fallback.x, y: fallback.y });
  mainWindow.setPosition(fallback.x, fallback.y);
  mainWindow.show();
  mainWindow.focus();
}

// ---- Tooltip Window: always-on-top, transparent overlay for tooltip text ----

let tooltipReady = false;

function createTooltipWindow() {
  // Use data URL for instant loading (no file I/O delay)
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:transparent;overflow:hidden;font-family:'Segoe UI',system-ui,sans-serif}
    .tip{display:none;position:fixed;top:0;left:0;background:rgba(0,0,0,0.92);color:#fff;
      font-size:12px;line-height:1.5;padding:4px 8px;border-radius:4px;white-space:nowrap;
      box-shadow:0 2px 8px rgba(0,0,0,0.35)}
  </style></head><body><div class="tip" id="tip"></div></body></html>`;

  tooltipWindow = new BrowserWindow({
    width: 1,
    height: 1,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    focusable: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  tooltipWindow.setAlwaysOnTop(true, 'pop-up');
  tooltipWindow.setVisibleOnAllWorkspaces(true);
  tooltipWindow.setIgnoreMouseEvents(true, { forward: true });

  tooltipWindow.webContents.on('did-finish-load', () => {
    tooltipReady = true;
  });

  tooltipWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function showTooltipAtMainScreen(text, screenX, screenY) {
  if (!tooltipReady || !tooltipWindow || tooltipWindow.isDestroyed()) return;

  tooltipWindow.webContents.executeJavaScript(`
    (function() {
      var box = document.getElementById('tip');
      box.textContent = ${JSON.stringify(text)};
      box.style.display = 'block';
      var r = box.getBoundingClientRect();
      return JSON.stringify({ w: Math.ceil(r.width) + 4, h: Math.ceil(r.height) + 4 });
    })();
  `).then((result) => {
    if (!tooltipWindow || tooltipWindow.isDestroyed()) return;
    try {
      const { w, h } = JSON.parse(result);
      // Center tooltip horizontally at screenX, place bottom edge at screenY (above anchor)
      const x = Math.round(screenX - w / 2);
      const y = Math.round(screenY - h);
      tooltipWindow.setBounds({ x, y, width: w, height: h });
      if (!tooltipWindow.isVisible()) tooltipWindow.showInactive();
    } catch {}
  }).catch(() => {});
}

function hideTooltipWindow() {
  if (!tooltipWindow || tooltipWindow.isDestroyed()) return;
  try { tooltipWindow.hide(); } catch {}
}

function setupIpc() {
  ipcMain.handle('get-initial-status', () => {
    return sessionManager ? sessionManager.getStatus() : { sessions: [], active: 'idle' };
  });

  ipcMain.handle('get-window-state', () => {
    return {
      opacity: store.get('opacity') ?? 1.0,
      alwaysOnTop: store.get('alwaysOnTop') ?? true,
      sizeMode: store.get('sizeMode') ?? 'normal',
      scale: store.get('scale') ?? DEFAULT_SCALE,
    };
  });

  ipcMain.on('set-opacity', (_event, value) => {
    store.set('opacity', value);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setOpacity(value);
    }
  });

  ipcMain.on('toggle-always-on-top', () => {
    const current = store.get('alwaysOnTop') ?? true;
    store.set('alwaysOnTop', !current);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(!current);
    }
  });

  ipcMain.on('switch-session', (_event, sessionId) => {
    if (sessionManager) {
      sessionManager.setActiveSession(sessionId);
    }
  });

  ipcMain.on('toggle-size', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const currentMode = store.get('sizeMode') ?? 'normal';
    const newMode = currentMode === 'normal' ? 'mini' : 'normal';
    const size = newMode === 'normal' ? NORMAL_SIZE : MINI_SIZE;
    store.set('sizeMode', newMode);
    mainWindow.setSize(size.width, size.height);
    mainWindow.webContents.send('size-changed', newMode);
  });

  ipcMain.on('set-scale', (_event, scale) => {
    store.set('scale', scale);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setSize(
        Math.round(BASE_SIZE.width * scale),
        Math.round(BASE_SIZE.height * scale),
      );
    }
  });

  ipcMain.on('snap-to-claude', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const claudeBounds = await findClaudeWindow();

      // Place flush against the terminal's top-left corner — no gap.
      const scale = store.get('scale') ?? DEFAULT_SCALE;
      const contentW = Math.round(BASE_SIZE.width * scale);
      let x = claudeBounds.left - contentW;
      let y = claudeBounds.top;

      mainWindow.setPosition(x, y);
      store.set('windowBounds', { x, y });
    } catch {
      // Terminal not found — leave widget in place
    }
  });

  // Tooltip IPC: renderer → main → tooltip window
  ipcMain.on('show-tooltip', (_event, data) => {
    showTooltipAtMainScreen(data.text, data.x, data.y);
  });

  ipcMain.on('hide-tooltip', () => {
    hideTooltipWindow();
  });
}

function broadcastStatus() {
  if (!sessionManager || !mainWindow || mainWindow.isDestroyed()) return;
  const status = sessionManager.getStatus();
  mainWindow.webContents.send('status-update', status);

  if (tray) {
    tray.updateIcon(status.active);
  }
}

app.whenReady().then(async () => {
  store = createStore();

  sessionManager = createSessionManager(broadcastStatus);

  httpServer = createHttpServer(sessionManager);
  let actualPort;
  try {
    actualPort = await httpServer.start();
  } catch (err) {
    dialog.showErrorBox(
      'Claude 红绿灯启动失败',
      `HTTP server 无法启动: ${err.message}\n\n` +
        '可能原因: 端口 9527-9531 全部被其他程序占用。\n' +
        '请关闭可能占用这些端口的程序后重试。',
    );
    app.quit();
    return;
  }

  // Auto-install hooks with the actual port
  const hookResult = installHooks(actualPort);
  if (hookResult.success) {
    console.log(`Hooks auto-configured on port ${actualPort}`);
  } else {
    dialog.showErrorBox(
      'Hook 自动配置失败',
      `${hookResult.error}\n\n` +
        '红绿灯将无法收到 Claude Code 的事件，状态会一直停留在空闲。\n' +
        '可在系统托盘菜单点 "重新配置 Hook" 重试。',
    );
  }

  createWindow();
  createTooltipWindow();

  tray = createTrayManager(mainWindow, sessionManager, store, actualPort, {
    startFollowTerminal,
    stopFollowTerminal,
    resetWindowPosition,
  });

  setupIpc();

  // Auto-start follow terminal if previously enabled
  if (store.get('followTerminal')) {
    startFollowTerminal();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  if (httpServer) httpServer.stop();
  stopFollowTerminal();
});
