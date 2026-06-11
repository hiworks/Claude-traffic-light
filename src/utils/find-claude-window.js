const { exec } = require('child_process');
const path = require('path');
const { screen } = require('electron');

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
      // PowerShell's DwmGetWindowAttribute returns bounds in physical
      // pixels. Electron's BrowserWindow setBounds / getBounds use
      // device-independent pixels (DIPs): 1 DIP = scaleFactor physical
      // pixels. On a 100% display these are equal and the conversion
      // is a no-op. On 125% / 150% displays (very common on Windows
      // laptops and 4K monitors) the two diverge — if we passed the
      // raw physical values to setBounds the widget would land 1.25x
      // / 1.5x further from the terminal than the terminal actually
      // is, which is what manifested as "widget dragged to the screen
      // edge and won't follow" at non-100% scaling.
      //
      // We use the primary display's scaleFactor as the conversion
      // factor. A multi-monitor setup with mixed DPI would need to
      // pick the scale factor of the display the terminal sits on
      // (a future refinement); for the common single-display case
      // this restores correct snap at any Windows display scale.
      const scaleFactor = screen.getPrimaryDisplay().scaleFactor;
      resolve({
        left: parts[0] / scaleFactor,
        top: parts[1] / scaleFactor,
        right: parts[2] / scaleFactor,
        bottom: parts[3] / scaleFactor,
      });
    });
  });
}

module.exports = { findClaudeWindow };
