# Claude 红绿灯 (Claude Traffic Light)

一个轻量级的 Windows 桌面小工具，用红黄绿三色实时显示 Claude Code 的工作状态。支持多 session 监控。

## 快速开始

```bash
# 克隆并安装
git clone <repo-url>
cd claude-红绿灯
npm install

# 启动
npm start
```

**详细步骤见下文「安装与运行」章节。**

## 特性

- 🚦 **实时状态** — 红 = 工作中，黄 = 等待输入，绿 = 空闲
- 📍 **多 session** — 同时监控多个 Claude Code 终端窗口，每个 session 一个独立小圆点
- 🏷️ **项目识别** — 悬浮显示项目目录名称（从 hook 提供的 `cwd` 提取）
- 🔒 **会话锁定** — 锁定关注某个 session，状态不被自动切换覆盖
- 📌 **跟随终端** — 实时跟随终端窗口位置，widget 紧贴终端左边、顶部对齐
- 🎨 **可定制** — 透明度、缩放（Ctrl+滚轮 / 直接拖拽窗口边缘）、托盘菜单
- 🪟 **DPI 缩放兼容** — 在 100% / 125% / 150% 等任意 Windows 显示缩放下都能正确吸附
- ⚡ **零轮询** — 完全基于 Claude Code 的 hook 事件驱动，空闲时 CPU ≈ 0

## 架构

```
                      Claude Code (terminal)
                              |
                              v
                    traffic-light-hook.js
                              |
                              v POST /hook { event, tool, cwd, session_id, claudePid }
                    http-server.js
                              |
                              v
                    session-manager.js  ← 唯一数据源
                              |
              +---------------+---------------+
              v                               v
       renderer (UI 灯+圆点)                 tray (系统托盘)
```

### 核心设计原则

**单数据源**：所有 session 状态都来自 Claude Code 的 hook 事件（`PreToolUse` / `PostToolUse` / `Stop`），不轮询进程列表。

### Session 状态机

```
idle ──PreToolUse──▶ working
working ──PostToolUse + 3s 无新动作──▶ waiting
waiting ──PreToolUse──▶ working
* ──Stop / 60s 无事件──▶ idle
idle ──5 分钟──▶ removed
```

### Session 标识

按优先级：
1. Claude Code hook payload 中的 `session_id`
2. 兜底为 `claude-${pid}`（helper 脚本的父进程 PID）

## 安装与运行

### 方式一：开发模式（推荐开发者）

需要 Node.js 20+。

```bash
# 1. 克隆代码
git clone <repo-url>
cd claude-红绿灯

# 2. 安装依赖（首次约 100MB，下载 Electron 二进制）
npm install

# 3. 启动
npm start
```

> 国内用户如果 `npm install` 下载 Electron 卡住，先看下方「国内用户」章节配置 `.npmrc` 镜像。

### 方式二：打包成 .exe（推荐终端用户）

打包成单文件便携版，分发给不想装 Node 的用户：

```bash
# 生成便携版 .exe（无需安装，双击即用）
npm run build:portable

# 产物位置：dist/Claude-Traffic-Light-Portable.exe
```

### 启动后会自动完成

1. 在 `~/.claude/settings.json` 中注册 hook（`PreToolUse` / `PostToolUse` / `Stop`）
2. 写入 `~/.claude/traffic-light-hook.js` 辅助脚本
3. 启动 HTTP server 监听 `127.0.0.1:9527`（端口冲突时自动尝试 9528-9531）
4. 在系统托盘显示图标
5. 在屏幕右下角显示红绿灯小窗口

### 首次启动要做的事

1. **重启 Claude Code** —— 让它读取新安装的 hook
2. 检查托盘菜单中"Hook 已自动配置"是否带勾
3. 在 Claude Code 中执行任意工具调用（`Bash` / `Read` / `Edit`），红绿灯应该亮起

### 国内用户

下载 Electron 二进制（~100MB）走官方源可能很慢。仓库提供了 `.npmrc.example` 模板：

```bash
# 复制模板
cp .npmrc.example .npmrc

# 编辑 .npmrc，把文件末尾的镜像相关行取消注释
# 然后正常 npm install 即可
```

> **注意**：`.npmrc` 本身已加入 `.gitignore`，不会被提交到仓库。每个人的镜像配置只影响自己本地。

### 红绿灯颜色

| 灯 | 状态 | 含义 |
|----|------|------|
| 🔴 红 | working | Claude 正在执行工具 |
| 🟡 黄 | waiting | 工具执行完，等待用户输入或下一步操作 |
| 🟢 绿 | idle | Claude 未运行或空闲 |

### 小圆点

每个 Claude Code session 对应一个彩色小圆点：
- **红/黄/绿** = 该 session 的当前状态
- **带白圈** = 当前活跃 session
- **点击** = 切换活跃 session
- **悬浮** = 显示项目名 + 状态（始终在最上层）

### 锁按钮

红绿灯左下角的小锁图标：
- 🔓 未锁定 — 灯跟随最新活动的 session 自动切换
- 🔒 锁定 — 灯固定在当前 session，忽略新活动事件
- 悬浮 — 显示当前锁定状态

### 托盘菜单

- 显示 / 隐藏
- 始终置顶
- **跟随终端位置** — 实时跟随最近的活动终端
- 透明度 / 大小
- 重新配置 Hook / 卸载 Hook 配置

### 交互

- **Ctrl + 滚轮** — 缩放红绿灯（0.5x ~ 2.0x）
- **拖拽窗口边缘** — 自由调整红绿灯大小，比例不会被强制改回
- **双击** — 吸附到最近的终端窗口
- **启动时自动吸附** — 每次冷启动约 400ms 后自动贴到主终端左侧、顶部对齐
- **悬浮小圆点 / 锁按钮** — 显示详情 tooltip（始终在最上层）

## 配置

配置文件位置：`%APPDATA%/claude-traffic-light/config.json`

| 键 | 类型 | 默认值 | 说明 |
|----|------|--------|------|
| `windowBounds` | `{x, y}` | 屏幕右下角 | 窗口位置 |
| `scale` | number | 0.4 | 缩放比例（合法范围 0.5 ~ 2.0；超出范围启动时回退默认） |
| `sizeMode` | `'normal'` \| `'mini'` | `'normal'` | 大小模式 |
| `opacity` | 0-1 | 1.0 | 透明度 |
| `alwaysOnTop` | boolean | true | 始终置顶 |
| `followTerminal` | boolean | false | 跟随终端 |

## 目录结构

```
.
├── main.js                       # Electron 主进程
├── preload.js                    # 安全 IPC 桥
├── package.json
├── .npmrc.example                # npm 镜像配置模板（个人 .npmrc 已被 .gitignore 排除）
├── src/
│   ├── config/
│   │   ├── store.js              # JSON 配置存储
│   │   └── hook-installer.js     # Claude Code hook 注册
│   ├── status/
│   │   ├── http-server.js        # 接收 hook 通知
│   │   └── session-manager.js    # Session 状态机（单数据源）
│   ├── tray/
│   │   └── tray.js               # 系统托盘
│   ├── ui/
│   │   ├── index.html
│   │   ├── styles.css
│   │   └── renderer.js           # 渲染层（灯+圆点+tooltip）
│   └── utils/
│       ├── find-claude-window.js   # 终端窗口查找（含 DPI 缩放换算）
│       ├── find-claude-window.ps1   # PowerShell 探针（EnumWindows + DWM 边界）
│       ├── snap.js                 # snap 数学（flush-left, top-aligned）
│       ├── bounds.js               # savedBounds 跨显示器可见性校验
│       └── dwm-shadow.js           # 关闭 DWM non-client 渲染避免光晕
```

## 故障排除

**红绿灯不亮 / 不切换**
- 检查托盘"Hook 已自动配置"是否带勾
- 如果没有，点"重新配置 Hook"，然后重启 Claude Code
- 检查端口 9527-9531 是否被其他程序占用

**小圆点不会切换**
- 确保每个终端的 Claude Code 是独立进程
- 关闭所有 Claude 后 5 分钟小圆点应自动消失

**CPU 占用高**
- 本版本已移除所有轮询，CPU 应该在空闲时几乎为 0
- 如果还高，检查是否多个实例在运行

**窗口错位**
- 双击红绿灯自动吸附到终端
- 或右键托盘 → "跟随终端位置" 开启持续跟随

**`'electron' 不是内部或外部命令`**
- 这意味着 `node_modules\electron\dist\electron.exe` 不完整。重新运行 `npm install`：
  ```bash
  rm -rf node_modules
  npm install
  ```
- 如果在国内网络下持续失败，按上方「国内用户」章节配置 `.npmrc` 镜像

## 系统要求

- Windows 10 / 11
- Node.js 20+ (开发模式；electron 41 的某些传递依赖会警告需要 Node ≥ 22，但当前可运行)
- Claude Code (任意当前版本)

## License

MIT

---

## 写在最后

Token滞销，帮帮老乡。
