const { exec } = require('child_process');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, 'find-claude-window.ps1');

function findClaudeWindow() {
  return new Promise((resolve, reject) => {
    const cmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${SCRIPT_PATH}" -ExcludePid ${process.pid}`;
    exec(cmd, { timeout: 5000 }, (err, stdout) => {
      if (err) return reject(err);
      const output = stdout.trim();
      if (output === 'not found' || output === 'error') {
        return reject(new Error('Claude window not found'));
      }
      const parts = output.split(',').map(Number);
      if (parts.length !== 4 || parts.some(isNaN)) {
        return reject(new Error('Invalid window bounds'));
      }
      resolve({ left: parts[0], top: parts[1], right: parts[2], bottom: parts[3] });
    });
  });
}

module.exports = { findClaudeWindow };
