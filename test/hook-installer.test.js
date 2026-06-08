// Hook Installer — install / uninstall / isInstalled
//
// All tests redirect writes to a temp directory via
// CLAUDE_TRAFFIC_LIGHT_HOME, so the user's real ~/.claude is never touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function makeTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-test-'));
  process.env.CLAUDE_TRAFFIC_LIGHT_HOME = dir;
  return dir;
}

function rmTempHome(dir) {
  delete process.env.CLAUDE_TRAFFIC_LIGHT_HOME;
  if (dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const { install, uninstall, isInstalled } = require('../src/config/hook-installer');

test('install writes helper script, port file, and settings.json', () => {
  const tmp = makeTempHome();
  try {
    const result = install(9527);
    assert.equal(result.success, true);
    assert.equal(result.port, 9527);

    const claudeDir = path.join(tmp, '.claude');
    assert.ok(fs.existsSync(path.join(claudeDir, 'traffic-light-hook.js')));
    assert.equal(
      fs.readFileSync(path.join(claudeDir, 'traffic-light-port'), 'utf-8'),
      '9527',
    );

    const settings = JSON.parse(
      fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8'),
    );
    assert.ok(settings.hooks);
    assert.ok(settings.hooks.PreToolUse);
    assert.ok(settings.hooks.PostToolUse);
    assert.ok(settings.hooks.Stop);
  } finally {
    rmTempHome(tmp);
  }
});

test('helper script contains the right port and references traffic-light-hook.js', () => {
  const tmp = makeTempHome();
  try {
    install(9566);
    const script = fs.readFileSync(path.join(tmp, '.claude', 'traffic-light-hook.js'), 'utf-8');
    assert.ok(script.includes('const port = 9566'), 'must embed the configured port');
    assert.ok(script.includes('http.request'), 'must POST to the local traffic light');
  } finally {
    rmTempHome(tmp);
  }
});

test('hook command path uses forward slashes / escaped correctly in JSON', () => {
  const tmp = makeTempHome();
  try {
    install(9527);
    const settings = JSON.parse(
      fs.readFileSync(path.join(tmp, '.claude', 'settings.json'), 'utf-8'),
    );
    const hook = settings.hooks.PreToolUse[0].hooks[0];
    assert.equal(hook.type, 'command');
    assert.ok(hook.command.includes('traffic-light-hook.js'));
    assert.ok(hook.command.includes('PreToolUse'));
    assert.equal(hook._marker, 'claude-traffic-light');
  } finally {
    rmTempHome(tmp);
  }
});

test('isInstalled returns true after install', () => {
  const tmp = makeTempHome();
  try {
    assert.equal(isInstalled(), false);
    install(9527);
    assert.equal(isInstalled(), true);
  } finally {
    rmTempHome(tmp);
  }
});

test('uninstall removes helper script, port file, and hook entries from settings', () => {
  const tmp = makeTempHome();
  try {
    install(9527);
    const claudeDir = path.join(tmp, '.claude');
    assert.ok(fs.existsSync(path.join(claudeDir, 'traffic-light-hook.js')));

    const result = uninstall();
    assert.equal(result.success, true);

    assert.ok(!fs.existsSync(path.join(claudeDir, 'traffic-light-hook.js')));
    assert.ok(!fs.existsSync(path.join(claudeDir, 'traffic-light-port')));

    const settings = JSON.parse(
      fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8'),
    );
    // No hooks should remain
    assert.ok(!settings.hooks || Object.keys(settings.hooks).length === 0);
  } finally {
    rmTempHome(tmp);
  }
});

test('uninstall preserves user-added hooks that we did not install', () => {
  const tmp = makeTempHome();
  try {
    // Pre-populate settings with a user hook
    const claudeDir = path.join(tmp, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: '',
              hooks: [{ type: 'command', command: 'echo user-hook' }],
            },
          ],
        },
      }),
    );

    install(9527);
    uninstall();

    const settings = JSON.parse(
      fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8'),
    );
    assert.ok(settings.hooks, 'user hook should still be there');
    const userHook = settings.hooks.PreToolUse[0].hooks[0];
    assert.equal(userHook.command, 'echo user-hook');
  } finally {
    rmTempHome(tmp);
  }
});

test('install twice does not duplicate hook entries (idempotent)', () => {
  const tmp = makeTempHome();
  try {
    install(9527);
    install(9528);

    const settings = JSON.parse(
      fs.readFileSync(path.join(tmp, '.claude', 'settings.json'), 'utf-8'),
    );
    // After two installs, PreToolUse should still have only one matcher group
    // (and that group should contain exactly one hook).
    assert.equal(settings.hooks.PreToolUse.length, 1);
    assert.equal(settings.hooks.PreToolUse[0].hooks.length, 1);

    // The hook command itself does not carry the port (the port is embedded
    // inside the helper script), but the helper script should reflect the
    // latest port after the second install.
    const script = fs.readFileSync(
      path.join(tmp, '.claude', 'traffic-light-hook.js'),
      'utf-8',
    );
    assert.ok(script.includes('const port = 9528'));
  } finally {
    rmTempHome(tmp);
  }
});

test('install handles a non-existent target home (creates .claude dir)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-fresh-'));
  process.env.CLAUDE_TRAFFIC_LIGHT_HOME = tmp;
  try {
    const r = install(9527);
    assert.equal(r.success, true);
    assert.ok(fs.existsSync(path.join(tmp, '.claude')));
  } finally {
    delete process.env.CLAUDE_TRAFFIC_LIGHT_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isInstalled returns false when only settings have hooks but helper script is gone', () => {
  const tmp = makeTempHome();
  try {
    install(9527);
    fs.unlinkSync(path.join(tmp, '.claude', 'traffic-light-hook.js'));
    assert.equal(isInstalled(), false);
  } finally {
    rmTempHome(tmp);
  }
});
