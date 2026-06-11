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
const { computeFlushLeftPosition, rectsOverlap } = require('./src/utils/snap');

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

// Cached Claude/terminal bounds — populated by every code path that
// successfully calls findClaudeWindow() (follow loop, snap-to-claude
// IPC, and the new launch auto-snap). Read by the debounced 'moved'
// handler so a drag that puts the widget back on top of the terminal
// is not persisted to disk (otherwise the next cold start would
// re-create the original "widget covers terminal content" bug).
let lastClaudeBounds = null;

// 'moved' fires 30+ times per second during a drag. We coalesce those
// into a single persist call so we don't thrash the config file, and
// so `lastClaudeBounds` has time to settle if the auto-snap lands
// milliseconds after a drag ends. 250 ms feels instant to the user.
let moveDebounceTimer = null;
const MOVE_PERSIST_DEBOUNCE_MS = 250;

// ---- Follow Terminal: dynamically snap to terminal window position ----

// Re-poll the terminal every Nth loop tick (300ms * 5 = 1.5s) instead of
// every tick. EnumWindows' z-order is not stable across calls when
// several terminal-class windows exist (a user-launched `cmd`/`pwsh`, a
// PowerShell probe, a hidden wmic window, etc.) — polling every tick
// meant the loop could latch onto a different window on alternating
// iterations and visibly jitter the widget between two snap targets.
// Between polls we honor the most recent bounds, which is stable.
const FOLLOW_POLL_INTERVAL_TICKS = 5;
let followTickCount = 0;

// Deadband in pixels for the snap move. A 1px diff still produces a
// real `moved` event → debounced persist → potential round-trip
// drift on the next cold start. Anything smaller than this is treated
// as "already in place" and skipped.
const SNAP_DEADBAND_PX = 2;

async function followTerminalLoop() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    stopFollowTerminal();
    return;
  }

  try {
    // Re-poll only every Nth tick. CRITICAL: skip the first tick so
    // we honor the `lastClaudeBounds` that `autoSnapAtLaunch` already
    // populated with the user's main terminal. `findClaudeWindow`
    // walks EnumWindows in z-order, which is NOT stable when several
    // terminal-class windows are open (the running Claude Code
    // terminal, plus a `cmd` from the user, plus a hidden wmic
    // window, plus a momentary PowerShell probe, etc.). On the very
    // first follow-loop tick, polling would race with the auto-snap
    // and could latch onto a *different* window — computing a snap
    // target that lands the widget at the screen edge instead of
    // flush-left of the user's main terminal. By skipping tick 0
    // and only re-polling from tick FOLLOW_POLL_INTERVAL_TICKS
    // onwards, we trust the auto-snap's pick for the first 1.5s
    // and refresh on a stable cadence after that.
    if (
      followTickCount > 0 &&
      followTickCount % FOLLOW_POLL_INTERVAL_TICKS === 0
    ) {
      const polled = await findClaudeWindow();
      if (polled) lastClaudeBounds = polled;
    }
    followTickCount++;
    const claudeBounds = lastClaudeBounds;
    if (!claudeBounds) {
      // No terminal known yet — keep current position; the auto-snap
      // at launch has the first chance to populate this.
      throw new Error('no terminal bounds yet');
    }

    // Read the actual widget width. We deliberately do NOT call
    // lockWidgetSize() here: it would push the height back to the
    // aspect-ratio-conforming value and "jump back" any size the
    // user just dragged. The snap target is computed from the live
    // width, so the position is correct even when the widget is at
    // a non-conforming size.
    const widgetBounds = mainWindow.getBounds();
    const widgetW = widgetBounds.width;

    const { x: targetX, y: targetY } = computeFlushLeftPosition(
      claudeBounds,
      widgetW,
    );

    // Apply the deadband. If the position is within SNAP_DEADBAND_PX
    // of the current position we treat it as "already snapped" — no
    // setBounds call, no 'moved' event, no debounced persist churn.
    // CRITICAL: do NOT `return` here. The setTimeout that re-arms
    // the loop lives AFTER the try/catch at the bottom of this
    // function. An early `return` would skip it, and the loop would
    // die on the first tick (the widget is already at the snap
    // target after autoSnapAtLaunch, so the deadband always trips
    // immediately). Use inverted `if` so both branches fall through
    // to the schedule-at-bottom.
    const dx = targetX - widgetBounds.x;
    const dy = targetY - widgetBounds.y;
    if (Math.abs(dx) > SNAP_DEADBAND_PX || Math.abs(dy) > SNAP_DEADBAND_PX) {
      // Atomic position+size write: if the position OR size is off,
      // push both in a single setBounds call. setPosition alone
      // would leave a window where the renderer is still painting at
      // the old size, and a subsequent getBounds() could read a
      // stale width into the next iteration's snap target — causing
      // the widget to walk left by 1px per loop. setBounds closes
      // that window in one call.
      mainWindow.setBounds({
        x: targetX,
        y: targetY,
        width: widgetW,
        height: widgetBounds.height,
      });
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
  // Reset the poll-throttle counter so the first iteration polls
  // immediately instead of waiting FOLLOW_POLL_INTERVAL_TICKS ticks.
  followTickCount = 0;
  followTerminalLoop();
}

function stopFollowTerminal() {
  if (followTimer) {
    clearTimeout(followTimer);
    followTimer = null;
  }
}

// ---- Launch auto-snap: dock the widget next to the terminal on cold start ----
//
// The previous cold-start path only restored `savedBounds` or fell back to
// the screen's bottom-right corner. Either could land the widget on top of
// a terminal window. This helper fires once, ~400ms after the first show,
// and snaps the widget to the terminal's top-left (flush-left, top-aligned).
// We delay so the terminal has time to settle at its final bounds after the
// user double-clicked the terminal icon — PowerShell's EnumWindows picks
// whatever is visible at the moment it runs, and a half-open terminal has
// transient bounds that we don't want to latch onto.
//
// Fire-and-forget: the caller (ready-to-show) is not async, and the widget
// is already visible to the user. Any failure is silent — we leave the
// widget at its saved/default position, same as if follow mode had been
// running and the terminal had gone away.
async function autoSnapAtLaunch() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await new Promise((r) => setTimeout(r, 400));
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const claudeBounds = await findClaudeWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    lastClaudeBounds = claudeBounds;
    // We do NOT call lockWidgetSize() here. The user may have
    // resized the widget freely; the snap target is computed from
    // the live width, so the position is correct regardless of the
    // height. Forcing a conforming height here would also "jump
    // back" the user's chosen size.
    const widgetBounds = mainWindow.getBounds();
    const widgetW = widgetBounds.width;
    const { x, y } = computeFlushLeftPosition(claudeBounds, widgetW);
    console.log(
      `[traffic-light] auto-snap: claudeBounds=${JSON.stringify(claudeBounds)} ` +
      `widgetW=${widgetW} → (${x}, ${y})`,
    );
    // Atomic setBounds: position + size in a single Electron call.
    // setPosition alone races the next getBounds() read on Windows;
    // combining both into setBounds makes the snap target and the
    // window's actual pixel rect land in the same paint frame.
    mainWindow.setBounds({
      x,
      y,
      width: widgetW,
      height: widgetBounds.height,
    });
    // Do NOT write windowBounds here. The setPosition above will fire
    // a 'moved' event, and the overlap guard returns false for a flush
    // widget (touching-edges semantics in rectsOverlap), so the result
    // is persisted automatically. Keeping the write path single-source
    // is the whole point of the guard.
  } catch {
    // No terminal running (or DWM hiccup) — leave the widget where it is.
    console.log('[traffic-light] auto-snap: no terminal found, keeping current position');
  }
}

function createWindow() {
  const savedBounds = store.get('windowBounds');
  const allDisplays = screen.getAllDisplays();

  // Validate the saved scale against the same range we use in the wheel
  // handler (0.5x–2.0x). A scale outside this range — e.g. the 2.8
  // that an earlier version of the resize handler recorded before
  // we removed the aspect-ratio enforcement — would produce a
  // widget so large it no longer fits flush-left of a terminal on a
  // typical screen. Fall back to the default in that case.
  const rawScale = store.get('scale');
  const scale = Number.isFinite(rawScale) && rawScale >= 0.5 && rawScale <= 2.0
    ? rawScale
    : DEFAULT_SCALE;
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

  // On window resize, record the new scale and notify the renderer.
  // We do NOT enforce the aspect ratio here. The user is the one
  // dragging the corner, and pushing the height back to match the
  // width (the way we used to) made the resize feel sticky: the user
  // would drag to (60, 200) and watch the window snap back to
  // (60, 157) — that "跳回去" the user just reported. The downside
  // is that the saved scale is width-derived only, so a non-
  // conforming height is not restored on the next cold start. That's
  // an acceptable trade for letting the user freely resize.
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
    // Diagnostic: dump create-time facts so we can see the real
    // window size and saved bounds at startup. Helps catch cases
    // where the BrowserWindow's actual width disagrees with the
    // computed contentW.
    const cb = mainWindow.getBounds();
    console.log(
      `[traffic-light] create: savedBounds=${JSON.stringify(store.get('windowBounds'))} ` +
      `scale=${store.get('scale')} winW=${cb.width} winH=${cb.height} ` +
      `startX=${cb.x} startY=${cb.y} follow=${store.get('followTerminal')}`,
    );
    // Fire-and-forget launch auto-snap. The widget first appears at its
    // savedBounds/defaultBounds position (so the user sees something
    // immediately), then autoSnapAtLaunch settles it next to the
    // terminal ~400ms later. Errors are swallowed inside the helper.
    autoSnapAtLaunch();
  });

  mainWindow.on('moved', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    // Coalesce drag-event spam (30+ fires/sec) into a single persist call.
    if (moveDebounceTimer) clearTimeout(moveDebounceTimer);
    moveDebounceTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const bounds = mainWindow.getBounds();
      // Skip persisting any position that overlaps the known terminal
      // bounds. Without this guard, dragging the widget back on top of
      // the terminal would persist an overlap position, and the next
      // cold start would re-create the original "widget covers terminal
      // content" bug. A flush widget sits edge-to-edge with the
      // terminal, and rectsOverlap returns false for touching edges —
      // so legitimate snap positions are still saved.
      if (
        lastClaudeBounds &&
        rectsOverlap(
          { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          {
            x: lastClaudeBounds.left,
            y: lastClaudeBounds.top,
            width: lastClaudeBounds.right - lastClaudeBounds.left,
            height: lastClaudeBounds.bottom - lastClaudeBounds.top,
          },
        )
      ) {
        return;
      }
      store.set('windowBounds', { x: bounds.x, y: bounds.y });
    }, MOVE_PERSIST_DEBOUNCE_MS);
  });

  mainWindow.on('closed', () => {
    if (moveDebounceTimer) {
      clearTimeout(moveDebounceTimer);
      moveDebounceTimer = null;
    }
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

  // 'screen-saver' is Electron's highest alwaysOnTop level. On Windows
  // every level still maps to HWND_TOPMOST, so on its own this is not
  // enough to out-rank a previously-activated widget — that's what
  // `moveTop()` after every setBounds is for (see below). But combined
  // with `moveTop()`, the level upgrade at least keeps the tooltip in
  // the "topmost" tier the widget is also in, and it future-proofs
  // against any future Electron change that re-introduces per-level
  // z-order separation on Windows.
  tooltipWindow.setAlwaysOnTop(true, 'screen-saver');
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
      // Belt-and-suspenders on top of setOwnerWindow: explicitly
      // raise to the top of the z-order after every move. The widget
      // may be re-shown (e.g. by the tray menu) which can flip the
      // z-order, so we re-assert on every hover.
      tooltipWindow.moveTop();
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
      lastClaudeBounds = claudeBounds;

      // Place flush against the terminal's top-left corner — no gap.
      // Routed through the shared helper so this site picks up the
      // "< 0 ⇒ fall back to terminal's right side" branch. We do
      // NOT call lockWidgetSize() — the user can resize freely and
      // the snap target is computed from the live width.
      const widgetBounds = mainWindow.getBounds();
      const widgetW = widgetBounds.width;
      const { x, y } = computeFlushLeftPosition(claudeBounds, widgetW);

      // Atomic setBounds keeps position and size in the same paint
      // frame — setPosition alone has been seen to leave a 1-frame
      // window where getBounds() returns the old width, which the
      // next snap iteration would then read and use to walk the
      // target left.
      mainWindow.setBounds({
        x,
        y,
        width: widgetW,
        height: widgetBounds.height,
      });
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
