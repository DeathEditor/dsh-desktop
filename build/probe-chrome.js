// probe-chrome.js - measure what the custom title bar (titleBarOverlay) actually
// covers, so the "drag strip hides the DSH header" concern is answered with evidence.
//
// Method: capturePage() returns the WEB CONTENT only (no OS overlay), while a screen
// grab includes the overlay. Comparing a known element's position in both tells us
// whether the overlay is drawn over the page or the page is offset below it.
const { app, BrowserWindow, nativeTheme } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const MODE = process.argv.includes('--dark') ? 'dark' : 'system'
const TB = 34

// A stand-in page that mimics the DSH header: a marked row at the very top, so we can
// see whether it survives.
const PAGE = 'data:text/html,' + encodeURIComponent(`
<body style="margin:0;background:#18181b;color:#eee;font:13px sans-serif;height:100vh">
  <div id="top" style="height:48px;background:#4d6bfe;display:flex;align-items:center;
       padding-left:12px;font-weight:700">TOP ROW (48px) - must stay visible</div>
  <div style="padding:12px">body content</div>
</body>`)

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark'

  const opts = MODE === 'dark'
    ? {
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#202024', symbolColor: '#f0f0f4', height: TB }
      }
    : {}

  const win = new BrowserWindow({
    width: 900, height: 420, x: 120, y: 120, show: true,
    backgroundColor: '#18181b', title: `probe-${MODE}`, ...opts
  })

  await win.loadURL(PAGE)

  // Apply the same inset the real app uses, so the probe measures the shipped fix.
  if (MODE === 'dark') {
    await win.webContents.insertCSS(`
      html { padding-top: ${TB}px !important; box-sizing: border-box !important; }
      body { height: 100% !important; }
    `)
  }

  await new Promise((r) => setTimeout(r, 2000))

  // Where does the browser think the top row is? (web coordinates, overlay excluded)
  const rect = await win.webContents.executeJavaScript(
    'JSON.stringify(document.getElementById("top").getBoundingClientRect())'
  )

  const shot = await win.webContents.capturePage()
  const outDir = path.join(__dirname, 'probe')
  fs.mkdirSync(outDir, { recursive: true })
  const file = path.join(outDir, `chrome-${MODE}.png`)
  fs.writeFileSync(file, shot.toPNG())

  const bounds = win.getBounds()
  console.log('PROBE ' + JSON.stringify({
    mode: MODE,
    titleBarHeight: MODE === 'dark' ? TB : 0,
    topRowRectInWebContent: JSON.parse(rect),
    windowBounds: bounds,
    webCapture: file,
    note: 'webCapture comes from capturePage() and excludes the OS overlay'
  }, null, 2))

  win.destroy()
  app.quit()
})
