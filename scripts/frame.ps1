# Samples the desktop around one window. Emits one JSON object with the window's
# DPI awareness and DPI, how many physical pixels of frame Windows shows on each
# side (the DWM-visible frame minus the client area), the first pixels inward
# from the middle of every edge, and the four extreme corners.
param([int]$procId, [int]$depth = 8)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public struct RECT { public int L,T,R,B; }
public struct POINT { public int X,Y; }
public class W {
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
}
"@
# Per-monitor v2 for this process, so every coordinate below is a physical pixel.
[W]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null
$h = (Get-Process -Id $procId).MainWindowHandle
if ($h -eq [IntPtr]::Zero) { throw "the process has no main window" }
# A synthetic Alt press satisfies the foreground-lock rule; without it the call is ignored.
[W]::keybd_event(0x12,0,0,[UIntPtr]::Zero); [W]::SetForegroundWindow($h) | Out-Null; [W]::keybd_event(0x12,0,2,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 700
$e = New-Object RECT
if ([W]::DwmGetWindowAttribute($h, 9, [ref]$e, 16) -ne 0) { throw "DwmGetWindowAttribute failed" }
$c = New-Object RECT; [W]::GetClientRect($h, [ref]$c) | Out-Null
$o = New-Object POINT; $o.X = 0; $o.Y = 0; [W]::ClientToScreen($h, [ref]$o) | Out-Null
$w = $e.R - $e.L; $ht = $e.B - $e.T
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($e.L, $e.T, 0, 0, $bmp.Size)
function px($x, $y) { $p = $bmp.GetPixel($x, $y); "#{0:x2}{1:x2}{2:x2}" -f $p.R, $p.G, $p.B }
$mx = [int]($w / 2); $my = [int]($ht / 2)
$last = $depth - 1
@{
  foreground = ([W]::GetForegroundWindow() -eq $h)
  perMonitorV2 = [W]::AreDpiAwarenessContextsEqual([W]::GetWindowDpiAwarenessContext($h), [IntPtr]-4)
  dpi = [W]::GetDpiForWindow($h)
  frame = @{ x = $e.L; y = $e.T; width = $w; height = $ht }
  thickness = @{
    top = $o.Y - $e.T
    left = $o.X - $e.L
    right = $e.R - ($o.X + $c.R - $c.L)
    bottom = $e.B - ($o.Y + $c.B - $c.T)
  }
  pixels = @{
    top = @(0..$last | ForEach-Object { px $mx $_ })
    bottom = @(0..$last | ForEach-Object { px $mx ($ht - 1 - $_) })
    left = @(0..$last | ForEach-Object { px $_ $my })
    right = @(0..$last | ForEach-Object { px ($w - 1 - $_) $my })
  }
  corner = @{ topLeft = (px 0 0); topRight = (px ($w - 1) 0); bottomLeft = (px 0 ($ht - 1)); bottomRight = (px ($w - 1) ($ht - 1)) }
} | ConvertTo-Json -Compress -Depth 4
