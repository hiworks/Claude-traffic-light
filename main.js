const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  screen,
  nativeImage,
} = require('electron');
const path = require('path');
const { createHttpServer } = require('./src/status/http-server');
const { createSessionManager } = require('./src/status/session-manager');
const { createTrayManager } = require('./src/tray/tray');
const { createStore } = require('./src/config/store');
const { install: installHooks, uninstall: uninstallHooks, isInstalled: isHooksInstalled } = require('./src/config/hook-installer');
const { findClaudeWindow } = require('./src/utils/find-claude-window');

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

    // Place to the left of terminal; if no room, place to the right
    // Use content width (widget) not full window width (includes tooltip padding)
    const scale = store.get('scale') ?? DEFAULT_SCALE;
    const contentW = Math.round(BASE_SIZE.width * scale);
    let targetX = claudeBounds.left - contentW - 4;
    if (targetX < 0) {
      targetX = claudeBounds.right + 4;
    }
    const targetY = claudeBounds.top;

    const [currentX, currentY] = mainWindow.getPosition();
    if (currentX !== targetX || currentY !== targetY) {
      mainWindow.setPosition(targetX, targetY);
    }
  } catch {
    // Terminal not found — keep current position
  }

  // Re-schedule only if still enabled
  if (store.get('followTerminal')) {
    followTimer = setTimeout(followTerminalLoop, 50);
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
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  const scale = store.get('scale') ?? DEFAULT_SCALE;
  const winW = Math.round(BASE_SIZE.width * scale);
  const winH = Math.round(BASE_SIZE.height * scale);

  const defaultX = screenWidth - winW - 20;
  const defaultY = screenHeight - winH - 20;

  // Validate saved bounds are within visible screen area
  let startX = savedBounds?.x ?? defaultX;
  let startY = savedBounds?.y ?? defaultY;
  if (startX < -2000 || startX > screenWidth || startY < -2000 || startY > screenHeight) {
    startX = defaultX;
    startY = defaultY;
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
    hasShadow: true,
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

      // Place to the left of terminal's top-left corner
      const scale = store.get('scale') ?? DEFAULT_SCALE;
      const contentW = Math.round(BASE_SIZE.width * scale);
      let x = claudeBounds.left - contentW - 4;
      let y = claudeBounds.top;

      mainWindow.setPosition(x, y);
      store.set('windowBounds', { x, y });
    } catch {
      // Terminal not found — leave widget in place
    }
  });

  ipcMain.on('hide-window', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
  });

  ipcMain.on('show-window', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
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
  const actualPort = await httpServer.start();

  // Auto-install hooks with the actual port
  const hookResult = installHooks(actualPort);
  if (hookResult.success) {
    console.log(`Hooks auto-configured on port ${actualPort}`);
  } else {
    console.log(`Hook auto-config failed: ${hookResult.error}`);
  }

  createWindow();
  createTooltipWindow();

  tray = createTrayManager(mainWindow, sessionManager, store, actualPort, {
    startFollowTerminal,
    stopFollowTerminal,
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
