// System Tray Manager — Uses .ico files from assets/

const { Tray, Menu, app, nativeImage, dialog } = require('electron');
const path = require('path');
const {
  install: installHooks,
  uninstall: uninstallHooks,
  isInstalled: isHooksInstalled,
} = require('../config/hook-installer');

const ASSETS = path.join(__dirname, '..', '..', 'assets');

function createTrayIcon(status) {
  const iconMap = {
    idle: 'tray-icon-green.ico',
    waiting: 'tray-icon-yellow.ico',
    working: 'tray-icon-red.ico',
  };
  const file = iconMap[status] || iconMap.idle;
  const iconPath = path.join(ASSETS, file);

  try {
    return nativeImage.createFromPath(iconPath);
  } catch {
    // Fallback: create a simple colored icon
    return nativeImage.createEmpty();
  }
}

function createTrayManager(mainWindow, sessionManager, store, httpPort, followFns) {
  const initialIcon = createTrayIcon('idle');
  const tray = new Tray(initialIcon);

  tray.setToolTip('Claude Traffic Light — 空闲');

  function buildContextMenu() {
    const alwaysOnTop = store.get('alwaysOnTop') ?? true;
    const hooksInstalled = isHooksInstalled();

    return Menu.buildFromTemplate([
      {
        label: '显示 / 隐藏',
        click: () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isVisible()) {
              mainWindow.hide();
            } else {
              mainWindow.show();
            }
          }
        },
      },
      {
        label: '重置窗口位置',
        click: () => {
          if (followFns && typeof followFns.resetWindowPosition === 'function') {
            followFns.resetWindowPosition();
          }
        },
      },
      { type: 'separator' },
      {
        label: '始终置顶',
        type: 'checkbox',
        checked: alwaysOnTop,
        click: () => {
          const current = store.get('alwaysOnTop') ?? true;
          store.set('alwaysOnTop', !current);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setAlwaysOnTop(!current);
          }
        },
      },
      {
        label: '跟随终端位置',
        type: 'checkbox',
        checked: store.get('followTerminal') ?? false,
        click: () => {
          const current = store.get('followTerminal') ?? false;
          store.set('followTerminal', !current);
          if (!current) {
            if (followFns && followFns.startFollowTerminal) followFns.startFollowTerminal();
          } else {
            if (followFns && followFns.stopFollowTerminal) followFns.stopFollowTerminal();
          }
        },
      },
      {
        label: '透明度',
        submenu: [
          { label: '100%', click: () => setOpacity(1.0) },
          { label: '80%', click: () => setOpacity(0.8) },
          { label: '60%', click: () => setOpacity(0.6) },
          { label: '40%', click: () => setOpacity(0.4) },
        ],
      },
      {
        label: '大小',
        submenu: [
          { label: '小 (50%)', click: () => setScale(0.5) },
          { label: '偏小 (75%)', click: () => setScale(0.75) },
          { label: '正常 (100%)', click: () => setScale(1.0) },
          { label: '大 (125%)', click: () => setScale(1.25) },
          { label: '超大 (150%)', click: () => setScale(1.5) },
          { label: '巨大 (200%)', click: () => setScale(2.0) },
        ],
      },
      { type: 'separator' },
      {
        label: hooksInstalled ? '✅ Hook 已自动配置' : '⚠️ Hook 未配置',
        enabled: false,
      },
      {
        label: '重新配置 Hook',
        click: () => {
          const port = httpPort || 9527;
          const result = installHooks(port);
          if (result.success) {
            dialog.showMessageBox({
              type: 'info',
              title: 'Hook 配置成功',
              message: `Hook 已配置到 ${result.settingsPath}\n监听端口: ${port}\n\n请重启 Claude Code 生效。`,
              buttons: ['确定'],
            });
          } else {
            dialog.showMessageBox({
              type: 'error',
              title: 'Hook 配置失败',
              message: `配置失败: ${result.error}`,
              buttons: ['确定'],
            });
          }
          tray.setContextMenu(buildContextMenu());
        },
      },
      {
        label: '卸载 Hook 配置',
        click: () => {
          const result = uninstallHooks();
          if (result.success) {
            dialog.showMessageBox({
              type: 'info',
              title: 'Hook 已卸载',
              message: 'Hook 配置已从 settings.json 中移除。\n请重启 Claude Code 生效。',
              buttons: ['确定'],
            });
          }
          tray.setContextMenu(buildContextMenu());
        },
      },
      { type: 'separator' },
      {
        label: '状态说明',
        submenu: [
          { label: '🔴 红灯 — Claude 未运行', enabled: false },
          { label: '🟡 黄灯 — 等待用户输入', enabled: false },
          { label: '🟢 绿灯 — Claude 工作中', enabled: false },
        ],
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]);
  }

  function setOpacity(value) {
    store.set('opacity', value);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setOpacity(value);
    }
  }

  function setScale(value) {
    store.set('scale', value);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scale-changed', value);
    }
  }

  tray.setContextMenu(buildContextMenu());

  tray.on('double-click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
      }
    }
  });

  function updateIcon(status) {
    const icon = createTrayIcon(status);
    tray.setImage(icon);

    const labels = {
      idle: '空闲',
      waiting: '等待用户输入',
      working: '工作',
    };
    tray.setToolTip(`Claude Traffic Light — ${labels[status] || status}`);
    tray.setContextMenu(buildContextMenu());
  }

  return { updateIcon };
}

module.exports = { createTrayManager };
