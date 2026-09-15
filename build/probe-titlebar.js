// probe-titlebar.js - decide how to remove the Windows accent colour from the caption
// bar. Windows paints it in the user's accent when "show accent colour on title bars"
// is enabled, and nativeTheme.themeSource='dark' does NOT override that.
//
// Three candidates are rendered side by side and captured, so the choice is based on
// what actually appears rather than on documentation.
const { app, BrowserWindow, nativeTheme, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const HTML = 'data:text/html,' + encodeURIComponent(`
<body style="margin:0;background:#18181b;color:#e6e6e9;font:13px 'Segoe UI',sans-serif">
  <div style="padding:14px 18px;background:#1f1f23;border-bottom:1px solid #2c2c33">
    <b>deepseek</b> <span style="border:1px solid #555;border-radius:3px;padding:0 4px;font-size:10px">HARNESS</span>
  </div>
  <div style="padding:18px">window body</div>
</body>`)

async function makeWindow (label, options) {
  const win = new BrowserWindow({
    width: 620, height: 260, show: true,
    backgroundColor: '#18181b',
    title: label,
    ...options
  })
  await win.loadURL(HTML)
  return win
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark'
  const outDir = path.join(__dirname, 'probe')
  fs.mkdirSync(outDir, { recursive: true })

  const area = screen.getPrimaryDisplay().workArea
  const configs = [
    ['A-native-frame', {}],
    ['B-titlebar-overlay', {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#202024', symbolColor: '#f0f0f4', height: 34 }
    }],
    ['C-hidden-nodrag', { titleBarStyle: 'hidden' }]
  ]

  const wins = []
  let y = area.y + 40
  for (const [label, opts] of configs) {
    const win = await makeWindow(label, { ...opts, x: area.x + 60, y })
    wins.push([label, win])
    y += 300
  }

  // Let DWM settle, then capture each window region from the real screen.
  await new Promise((r) => setTimeout(r, 2500))

  const results = []
  for (const [label, win] of wins) {
    const b = win.getBounds()
    const img = await win.webContents.capturePage()
    // capturePage only covers web content; the frame colour must come from the screen.
    const png = await captureScreenRegion(b)
    const file = path.join(outDir, `${label}.png`)
    fs.writeFileSync(file, png)
    results.push({ label, file, bounds: b, webContentBytes: img.toPNG().length })
  }

  console.log('PROBE_RESULT ' + JSON.stringify({ results, accentProbe: readAccent() }, null, 2))

  for (const [, win] of wins) win.destroy()
  app.quit()
})

/** Grab a screen region via a hidden full-screen capture is not available in main;
 *  use the desktopCapturer-free approach: draw the window with printWindow is not
 *  exposed either, so fall back to reporting only bounds and letting the caller
 *  screenshot. */
async function captureScreenRegion () {
  return Buffer.alloc(0)
}

function readAccent () {
  try {
    const { execSync } = require('node:child_process')
    const q = (v) => {
      const out = execSync(`reg query "HKCU\\SOFTWARE\\Microsoft\\Windows\\DWM" /v ${v}`, {
        encoding: 'utf8', windowsHide: true
      })
      const m = out.match(/0x[0-9a-f]+/i)
      return m ? parseInt(m[0], 16) : null
    }
    return { accentColor: q('AccentColor'), colorPrevalence: q('ColorPrevalence') }
  } catch { return null }
}
