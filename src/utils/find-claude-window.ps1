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

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static RECT? Find()
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
            try
            {
                var proc = Process.GetProcessById((int)p);
                var name = proc.ProcessName.ToLowerInvariant();

                // Match terminal processes (priority: WindowsTerminal > cmd > powershell)
                bool isTerminal = name == "windowsterminal" || name == "cmd" || name == "powershell" || name == "pwsh";

                if (isTerminal)
                {
                    // Prefer WindowsTerminal over others — keep searching if not WindowsTerminal
                    if (name != "windowsterminal" && result == null)
                    {
                        result = r;
                        return true; // keep looking for WindowsTerminal
                    }
                    result = r;
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
    $rect = [WF]::Find()
    if ($rect) {
        Write-Output "$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom)"
    } else {
        Write-Output "not found"
    }
} catch {
    Write-Output "error"
}
