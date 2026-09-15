# make-icons.ps1 - generate the app icons from the OFFICIAL DeepSeek Harness whale mark.
#
# Outputs (into assets\):
#   icon.png  - 1024px master, used by macOS, Linux and Electron itself
#   icon.ico  - multi-size Windows icon
#
# The whale comes from the installed dsh web frontend's favicon.svg. That mark is
# monochrome — white in the app's dark theme, near-black in light — so a hairline
# keyline keeps it legible on a dark dock/taskbar AND on a light background.
#
# Rendering note: headless Chrome clamps its layout viewport on small windows, which
# silently CROPS the result. Icons are therefore rendered once at 1024px through a
# full-bleed HTML wrapper and downscaled in-process, and every frame's opaque bounding
# box is asserted to sit inside the canvas so a regression fails loudly.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root   = Split-Path $PSScriptRoot -Parent
$assets = Join-Path $root 'assets'
$work   = Join-Path $PSScriptRoot 'icon-work'
New-Item -ItemType Directory -Path $assets -Force | Out-Null
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $work -Force | Out-Null

# --- locate the official whale path ---
$npmRoot = (& npm root -g 2>$null | Select-Object -First 1).Trim()
$favicon = Join-Path $npmRoot '@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-web-frontend\dist\favicon.svg'
if (-not (Test-Path $favicon)) { throw "favicon.svg not found at $favicon" }
$svgText = [System.IO.File]::ReadAllText($favicon)
$m = [regex]::Match($svgText, '<path\b[^>]*\sd="([^"]+)"')
if (-not $m.Success) { throw 'could not extract the whale path from favicon.svg' }
$whale = $m.Groups[1].Value
Write-Host ("whale path: {0} chars" -f $whale.Length)

# --- renderer ---
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) { throw 'no Chrome or Edge found to render the icon' }
Write-Host "renderer: $chrome"

$SIZE = 1024     # master raster; always above the Chrome viewport clamp
$PX_PER_UNIT = $SIZE / 50.0

function Invoke-SvgRender {
  param([string]$Svg, [string]$OutPng)
  $html = Join-Path $work ([System.IO.Path]::GetFileNameWithoutExtension($OutPng) + '.html')
  $doc = @"
<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;border:0;overflow:hidden;background:transparent}
  svg{display:block;width:100vw;height:100vh}
</style></head><body>
$Svg
</body></html>
"@
  [System.IO.File]::WriteAllText($html, $doc, (New-Object System.Text.UTF8Encoding($false)))
  if (Test-Path $OutPng) { Remove-Item $OutPng -Force }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $chrome '--headless' '--disable-gpu' '--no-sandbox' '--hide-scrollbars' `
      '--force-device-scale-factor=1' '--default-background-color=00000000' `
      "--user-data-dir=$(Join-Path $work 'profile')" `
      "--window-size=$SIZE,$SIZE" "--screenshot=$OutPng" `
      ('file:///' + ($html -replace '\\', '/')) 2>&1 | Out-Null
  } finally { $ErrorActionPreference = $prev }
  if (-not (Test-Path $OutPng)) { throw "render produced no file: $OutPng" }
}

function Get-OpaqueBBox {
  param([string]$Path)
  $bmp = [System.Drawing.Bitmap]::FromFile($Path)
  try {
    $w = $bmp.Width; $h = $bmp.Height
    $rect = [System.Drawing.Rectangle]::new(0, 0, $w, $h)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                          [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $stride = $data.Stride
      $buf = New-Object byte[] ($stride * $h)
      [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buf, 0, $buf.Length)
    } finally { $bmp.UnlockBits($data) }
    $minX = $w; $minY = $h; $maxX = -1; $maxY = -1
    for ($y = 0; $y -lt $h; $y++) {
      $row = $y * $stride
      for ($x = 0; $x -lt $w; $x++) {
        if ($buf[$row + $x * 4 + 3] -gt 8) {
          if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
          if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
        }
      }
    }
    return [pscustomobject]@{ MinX=$minX; MinY=$minY; MaxX=$maxX; MaxY=$maxY; Empty=($maxX -lt 0) }
  } finally { $bmp.Dispose() }
}

# --- probe: where does the whale actually sit in svg units? ---
$probe = Join-Path $work 'probe.png'
Invoke-SvgRender -Svg ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50"><path fill="#000000" d="' + $whale + '"/></svg>') -OutPng $probe
$bb = Get-OpaqueBBox -Path $probe
if ($bb.Empty) { throw 'the whale rendered empty' }
$x0 = $bb.MinX / $PX_PER_UNIT; $x1 = ($bb.MaxX + 1) / $PX_PER_UNIT
$y0 = $bb.MinY / $PX_PER_UNIT; $y1 = ($bb.MaxY + 1) / $PX_PER_UNIT
Write-Host ("whale bbox: x {0:N2}..{1:N2}  y {2:N2}..{3:N2}" -f $x0, $x1, $y0, $y1)

# --- square, centred viewBox with breathing room ---
# 12% padding suits an app icon: enough to clear macOS's rounded-rect mask and the
# Windows taskbar's own padding.
$PAD = 0.12
$side = [Math]::Max($x1 - $x0, $y1 - $y0) * (1 + 2 * $PAD)
$cx = ($x0 + $x1) / 2; $cy = ($y0 + $y1) / 2
$viewBox = '{0:N4} {1:N4} {2:N4} {3:N4}' -f ($cx - $side/2), ($cy - $side/2), $side, $side
Write-Host "viewBox: $viewBox"

# --- render the master: white whale with a fine dark keyline ---
# The keyline width is chosen in FINAL pixels and converted to user units, so it stays
# a constant hairline instead of scaling with the icon.
$casingPx = 6.0                                   # ~6px of a 1024px icon
$strokeUnits = $casingPx * $side / $SIZE
$masterSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + $viewBox + '">' +
  '<path fill="none" stroke="#101014" stroke-width="' + ('{0:N4}' -f $strokeUnits) +
  '" stroke-linejoin="round" stroke-linecap="round" d="' + $whale + '"/>' +
  '<path fill="#FFFFFF" d="' + $whale + '"/></svg>'

$masterPng = Join-Path $work 'master.png'
Invoke-SvgRender -Svg $masterSvg -OutPng $masterPng
$mb = Get-OpaqueBBox -Path $masterPng
if ($mb.Empty) { throw 'master icon rendered empty' }
if ($mb.MinX -eq 0 -or $mb.MinY -eq 0 -or $mb.MaxX -eq $SIZE - 1 -or $mb.MaxY -eq $SIZE - 1) {
  throw 'master icon is clipped at the canvas edge - increase $PAD'
}
Write-Host ("master bbox {0},{1}-{2},{3} (inside canvas: OK)" -f $mb.MinX, $mb.MinY, $mb.MaxX, $mb.MaxY)

$master = [System.Drawing.Image]::FromFile($masterPng)

# --- 1024px PNG for macOS / Linux / Electron ---
$pngOut = Join-Path $assets 'icon.png'
$master.Save($pngOut, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host ("icon.png  -> {0} ({1:N0} bytes)" -f $pngOut, (Get-Item $pngOut).Length)

# --- multi-size ICO for Windows ---
$sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
$bitmaps = @{}
try {
  foreach ($s in $sizes) {
    $bmp = [System.Drawing.Bitmap]::new($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $g.Clear([System.Drawing.Color]::Transparent)
      $g.DrawImage($master, [System.Drawing.Rectangle]::new(0, 0, $s, $s))
    } finally { $g.Dispose() }
    $bitmaps[$s] = $bmp
  }

  # 32bpp DIB frames: universally readable, including by legacy icon consumers
  # (PNG-compressed frames are not).
  function ConvertTo-IcoDib([System.Drawing.Bitmap]$bmp) {
    $w = $bmp.Width; $h = $bmp.Height
    $rect = [System.Drawing.Rectangle]::new(0, 0, $w, $h)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $stride = $data.Stride
      $pixels = New-Object byte[] ($stride * $h)
      [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pixels, 0, $pixels.Length)
    } finally { $bmp.UnlockBits($data) }
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    $bw.Write([UInt32]40); $bw.Write([Int32]$w); $bw.Write([Int32]($h * 2))
    $bw.Write([UInt16]1); $bw.Write([UInt16]32); $bw.Write([UInt32]0)
    $bw.Write([UInt32]($w * $h * 4)); $bw.Write([Int32]0); $bw.Write([Int32]0)
    $bw.Write([UInt32]0); $bw.Write([UInt32]0)
    for ($y = $h - 1; $y -ge 0; $y--) { $bw.Write($pixels, $y * $stride, $w * 4) }
    $maskStride = [Math]::Floor(($w + 31) / 32) * 4
    $bw.Write((New-Object byte[] ($maskStride * $h)), 0, ($maskStride * $h))
    $bw.Flush(); $bytes = $ms.ToArray(); $bw.Dispose(); $ms.Dispose()
    return , $bytes
  }

  $frames = @{}
  foreach ($s in $sizes) { $frames[$s] = [byte[]](ConvertTo-IcoDib $bitmaps[$s]) }

  $icoOut = Join-Path $assets 'icon.ico'
  $fs = [System.IO.File]::Create($icoOut)
  $bw = New-Object System.IO.BinaryWriter($fs)
  try {
    $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
    $offset = 6 + (16 * $sizes.Count)
    foreach ($s in $sizes) {
      [byte[]]$d = $frames[$s]
      $dim = if ($s -ge 256) { 0 } else { $s }
      $bw.Write([Byte]$dim); $bw.Write([Byte]$dim)
      $bw.Write([Byte]0); $bw.Write([Byte]0)
      $bw.Write([UInt16]1); $bw.Write([UInt16]32)
      $bw.Write([UInt32]$d.Length); $bw.Write([UInt32]$offset)
      $offset += $d.Length
    }
    foreach ($s in $sizes) { $bw.Write([byte[]]$frames[$s]) }
  } finally { $bw.Dispose(); $fs.Dispose() }
} finally {
  foreach ($b in $bitmaps.Values) { $b.Dispose() }
  $master.Dispose()
}

Write-Host ("icon.ico  -> {0} ({1:N0} bytes, {2} sizes)" -f $icoOut, (Get-Item $icoOut).Length, $sizes.Count)

# --- verify the ICO loads back ---
$icon = [System.Drawing.Icon]::new($icoOut, 256, 256)
$check = $icon.ToBitmap()
Write-Host ("verified: ICO reads back as {0}x{1}" -f $check.Width, $check.Height)
$check.Dispose(); $icon.Dispose()

# --- review sheet: the icon in the contexts it will actually be seen ---
$cell = 132; $pad = 12
[int]$wpx = ($cell + $pad) * 4 + $pad
[int]$hpx = $cell + $pad * 2 + 18
$sheet = [System.Drawing.Bitmap]::new($wpx, $hpx)
$g = [System.Drawing.Graphics]::FromImage($sheet)
$g.Clear([System.Drawing.Color]::FromArgb(255, 90, 90, 96))
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$bg = @(
  [System.Drawing.Color]::FromArgb(255, 32, 32, 36),
  [System.Drawing.Color]::FromArgb(255, 10, 10, 12),
  [System.Drawing.Color]::FromArgb(255, 242, 242, 245),
  [System.Drawing.Color]::FromArgb(255, 77, 107, 254)
)
$names = @('dark taskbar', 'black desktop', 'light bg', 'brand blue')
$src = [System.Drawing.Image]::FromFile($pngOut)
try {
  $f = [System.Drawing.Font]::new('Segoe UI', 8)
  $b = [System.Drawing.Brushes]::White
  for ($i = 0; $i -lt 4; $i++) {
    $x = $pad + $i * ($cell + $pad); $y = $pad
    $g.FillRectangle([System.Drawing.SolidBrush]::new($bg[$i]), $x, $y, $cell, $cell)
    $g.DrawImage($src, [System.Drawing.Rectangle]::new($x + 18, $y + 18, 96, 96))
    $g.DrawString($names[$i], $f, $b, [float]$x, [float]($y + $cell + 2))
  }
  $f.Dispose()
} finally { $src.Dispose() }
$g.Dispose()
$review = Join-Path $PSScriptRoot 'icon-review.png'
$sheet.Save($review, [System.Drawing.Imaging.ImageFormat]::Png)
$sheet.Dispose()
Write-Host "review sheet -> $review"
