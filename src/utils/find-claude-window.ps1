param([int]$ExcludePid = 0)

$code = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Diagnostics;

public class WF
{
    private delegate bool EWP(IntPtr h, IntPtr l);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EWP proc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr h, StringBuilder t, int c);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr h);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr h);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr h, out RECT r);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int sz);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    // DWMWA_EXTENDED_FRAME_BOUNDS — the rectangle the user actually
    // perceives as the window's edge. It includes the OS border and the
    // title bar, but NOT the DWM drop shadow. GetWindowRect returns the
    // same plus the shadow; GetClientRect returns the inner content only
    // (and so is 7-8px inside the perceived edge on Win11).
    private const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;

    public static RECT? Find(int excludePid)
    {
        RECT? result = null;
        EnumWindows((h, _) =>
        {
            if (!IsWindowVisible(h)) return true;
            if (IsIconic(h)) return true;

            var r = new RECT();
            GetWindowRect(h, out r);
            int w = r.Right - r.Left;
            int ht = r.Bottom - r.Top;

            // Skip tiny or zero-size windows
            if (w < 200 || ht < 200) return true;

            uint p;
            GetWindowThreadProcessId(h, out p);

            // Skip the caller (passed via -ExcludePid). Belt-and-suspenders
            // along with the 200px gate above.
            if (excludePid > 0 && (int)p == excludePid) return true;

            try
            {
                var proc = Process.GetProcessById((int)p);
                var name = proc.ProcessName.ToLowerInvariant();

                // Match terminal processes (priority: WindowsTerminal > cmd > powershell)
                bool isTerminal = name == "windowsterminal" || name == "cmd" || name == "powershell" || name == "pwsh";

                if (isTerminal)
                {
                    // Use DWM's extended-frame bounds — the rectangle that
                    // matches what the user sees as the window edge.
                    // DwmGetWindowAttribute can fail on very old Windows or
                    // if DWM is disabled; in that case fall back to the
                    // outer window rect, which is at most a few px wider.
                    var ext = new RECT();
                    int hr = DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out ext, System.Runtime.InteropServices.Marshal.SizeOf<RECT>());
                    var edgeRect = (hr == 0) ? ext : r;

                    // Prefer WindowsTerminal over others — keep searching if not WindowsTerminal
                    if (name != "windowsterminal" && result == null)
                    {
                        result = edgeRect;
                        return true; // keep looking for WindowsTerminal
                    }
                    result = edgeRect;
                    return false;
                }
            }
            catch { }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
"@

try {
    Add-Type -TypeDefinition $code -Language CSharp
    $rect = [WF]::Find($ExcludePid)
    if ($rect) {
        Write-Output "$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom)"
    } else {
        Write-Output "not found"
    }
} catch {
    Write-Output "error"
}
