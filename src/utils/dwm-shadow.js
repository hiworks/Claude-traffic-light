// Disable Windows DWM (Desktop Window Manager) non-client rendering for
// a given Electron BrowserWindow.
//
// Why this exists:
//   Electron's `BrowserWindow({ hasShadow: false })` only stops Chromium
//   from drawing its own shadow. On Windows the OS-level DWM also paints
//   a halo (typically 5-10px) around every top-level window. When the
//   widget sits next to the terminal, that halo is rendered on top of
//   the terminal's content and looks like a "gap" between the two.
//
//   Setting DWMWA_NCRENDERING_POLICY = DWMNCRP_DISABLED tells DWM to
//   skip the non-client paint pass, which removes the halo entirely.
//   The widget then lies truly flush with whatever it's snapped to.
//
// Implementation:
//   We call dwmapi!DwmSetWindowAttribute via PowerShell, because adding
//   a native FFI dependency for one dwmapi call is overkill. The HWND
//   is read out of BrowserWindow.getNativeWindowHandle() (a Buffer).

const { execFileSync } = require('node:child_process');

/**
 * @param {import('electron').BrowserWindow} win
 * @returns {void}
 */
function disableDwmShadow(win) {
  if (process.platform !== 'win32') return;
  if (!win || win.isDestroyed()) return;

  let hwndBuf;
  try {
    hwndBuf = win.getNativeWindowHandle();
  } catch {
    return;
  }
  if (!hwndBuf || hwndBuf.length < 4) return;

  // Electron returns the HWND as a little-endian unsigned integer in a
  // Buffer (4 bytes on 32-bit Windows, 8 bytes on 64-bit). The actual
  // HWND value always fits in 32 bits (user-mode handles live in the
  // lower address range), so reading 4 LE bytes is enough on both.
  const hwndNum = hwndBuf.readUInt32LE(0);

  // DWMWA_NCRENDERING_POLICY = 38, DWMNCRP_DISABLED = 1.
  //
  // We run this SYNCHRONOUSLY on purpose. The call is dispatched from
  // the BrowserWindow's `ready-to-show` event, and the window is shown
  // immediately after. If we used a detached spawn, the PowerShell
  // process would still be loading .NET types while DWM is already
  // painting the drop shadow — the halo would be visible for the
  // first few hundred ms and the user would see it. A 200-500ms block
  // of the show path is acceptable: the user is already waiting for
  // the widget to appear, and the visual result is what matters here.
  const psScript =
    '$ErrorActionPreference = "SilentlyContinue"; ' +
    'Add-Type @"\n' +
    'using System;\n' +
    'using System.Runtime.InteropServices;\n' +
    'public class DWM {\n' +
    '  [DllImport("dwmapi.dll")]\n' +
    '  public static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int val, int sz);\n' +
    '}\n' +
    '"@ ; ' +
    `$h = [IntPtr]::new(${hwndNum}); ` +
    '$v = 1; ' +
    '[DWM]::DwmSetWindowAttribute($h, 38, [ref]$v, 4) | Out-Null';

  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        psScript,
      ],
      {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 2000,
      },
    );
  } catch {
    // Synchronous failure is non-fatal — the widget just keeps its DWM
    // shadow. We deliberately do not log here: PowerShell startup is
    // a known-occasionally-flaky path on Windows and logging would
    // surface in the user's terminal on every launch.
  }
}

module.exports = { disableDwmShadow };
