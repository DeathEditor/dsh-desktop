# capture-real.ps1 - capture a window from the REAL screen (not PrintWindow).
#
# PrintWindow on a GPU-composited Chromium window can return garbage colours for the
# non-client area, so the frame colour must be read from an actual screen grab before
# any conclusion is drawn about it.
param([int]$ProcessId, [string]$OutFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RC2 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RC r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RC { public int L,T,Rt,B; }
}
"@

$proc = Get-Process -Id $ProcessId -ErrorAction Stop
$hwnd = $proc.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { throw "pid $ProcessId has no main window" }

if ([RC2]::IsIconic($hwnd)) { [RC2]::ShowWindow($hwnd, 9) | Out-Null }
[RC2]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 1500

$r = New-Object RC2+RC
[RC2]::GetWindowRect($hwnd, [ref]$r) | Out-Null
$w = $r.Rt - $r.L; $h = $r.B - $r.T
if ($w -le 0 -or $h -le 0) { throw "bad rect ${w}x${h}" }

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
try { $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size($w, $h))) }
finally { $g.Dispose() }
$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "captured ${w}x${h} from screen -> $OutFile"
