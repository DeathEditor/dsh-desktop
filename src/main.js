'use strict'

/**
 * Electron main process — the desktop shell for the DeepSeek Harness web GUI.
 *
 * Responsibilities, in order of importance:
 *   1. start `dsh web` and obtain its token-authenticated URL (see server-host.js),
 *   2. show that URL in a real application window,
 *   3. make sure the server dies with the window — including on force-quit.
 *
 * Everything here is platform-neutral: the same file runs on Windows, macOS and
 * Linux. Platform differences are confined to server-host.js (process-tree kill) and
 * the packaging config in package.json.
 */

const { app, BrowserWindow, Menu, shell, dialog, nativeTheme, session } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ServerHost } = require('./server-host')
const { Settings } = require('./settings')

/** Height of the custom title bar strip, in logical pixels. */
const TITLEBAR_HEIGHT = 34

/** Colours for the custom title bar, matched to the DSH dark UI. */
const CHROME_BG = '#202024'
const CHROME_FG = '#f0f0f4'

/** The dark canvas the DSH UI paints on; also prevents a white flash on open. */
const APP_BG = '#18181b'

const IS_DEV = process.argv.includes('--dev')

/** @type {Settings} */ let settings
/** @type {ServerHost|null} */ let server = null
/** @type {BrowserWindow|null} */ let win = null
/** Set once we intend to shut down, so a child exit is not reported as a crash. */
let quitting = false

// One shell per user. A second launch focuses the existing window instead of starting
// a competing server on another port.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

/**
 * Read the official whale mark out of the installed dsh frontend, so the splash
 * screen uses the same logo as the app. Returns '' when unavailable — the splash
 * renders fine without it.
 */
function readWhalePath () {
  try {
    const bin = server?.binPath || require('./server-host').resolveDshBin(settings.get('dshBinPath'))
    if (!bin) return ''
    // <npm-root>/@deepseek-ai/dsh/lib/bin.js -> <npm-root>/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon.svg
    const pkgRoot = path.resolve(path.dirname(bin), '..')
    const candidates = [
      path.join(pkgRoot, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'favicon.svg'),
      path.resolve(pkgRoot, '..', 'dsh-web-frontend', 'dist', 'favicon.svg')
    ]
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue
      const svg = fs.readFileSync(file, 'utf8')
      const match = /<path\b[^>]*\sd="([^"]+)"/.exec(svg)
      if (match) return match[1]
    }
  } catch { /* cosmetic only */ }
  return ''
}

/** Resolve which icon file exists for the current platform. */
function iconPath () {
  const assets = path.join(__dirname, '..', 'assets')
  const preferred = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  for (const name of [preferred, 'icon.png', 'icon.ico']) {
    const p = path.join(assets, name)
    if (fs.existsSync(p)) return p
  }
  return undefined
}

/**
 * Apply the window-chrome theme.
 *
 * Note the limit of what this can do: Windows paints the caption bar in the user's
 * ACCENT colour when "show accent colour on title bars" is enabled, and
 * `themeSource = 'dark'` does NOT override that (verified against a native Notepad
 * window, which shows the same colour). Use `theme: "dark"` in settings.json for a
 * custom dark frame; that is opt-in because it makes the top strip a drag handle.
 */
function applyTheme () {
  const choice = settings.get('theme')
  nativeTheme.themeSource = choice === 'light' ? 'light' : 'dark'
}

/** Bounds that are still on a connected display, else null. */
function safeBounds () {
  const saved = settings.get('bounds')
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return null
  const { screen } = require('electron')
  const area = { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
  const visible = screen.getAllDisplays().some((d) => {
    const w = d.workArea
    // Require a meaningful overlap, not a single shared pixel.
    const overlapX = Math.max(0, Math.min(area.x + area.width, w.x + w.width) - Math.max(area.x, w.x))
    const overlapY = Math.max(0, Math.min(area.y + area.height, w.y + w.height) - Math.max(area.y, w.y))
    return overlapX > 80 && overlapY > 80
  })
  return visible ? saved : null
}

function saveWindowState () {
  if (!win || win.isDestroyed()) return
  try {
    const maximized = win.isMaximized()
    // getNormalBounds() reports the restored geometry while maximized, which is what
    // should be restored on the next launch.
    const bounds = win.getNormalBounds()
    settings.merge({ bounds, maximized })
    settings.save()
  } catch { /* not fatal */ }
}

function createWindow () {
  const bounds = safeBounds()
  const isMac = process.platform === 'darwin'
  const darkChrome = settings.get('theme') === 'dark'

  // Windows paints every caption bar in the user's ACCENT colour when "show accent
  // colour on title bars" is enabled. This is system-wide — a plain Notepad window
  // looks the same — and nativeTheme.themeSource does NOT override it. The only way to
  // force dark chrome is to hide the native title bar and paint our own, which is what
  // `titleBarStyle: 'hidden'` + `titleBarOverlay` does.
  //
  // That mode makes the top strip a window-drag handle, so a click near the top of the
  // DSH header drags the window instead of reaching the page. It is therefore opt-in
  // (`theme: "dark"`); the default "system" keeps the stock frame, which matches every
  // other app on the machine and leaves all UI clicks working normally.
  const chromeOptions = darkChrome
    ? {
        titleBarStyle: 'hidden',
        ...(isMac
          ? { trafficLightPosition: { x: 12, y: 10 } }
          : {
              titleBarOverlay: {
                color: CHROME_BG,
                symbolColor: CHROME_FG,
                height: TITLEBAR_HEIGHT
              }
            })
      }
    : {}

  win = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 860,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: APP_BG,
    title: 'DeepSeek Harness',
    icon: iconPath(),
    autoHideMenuBar: process.platform !== 'darwin',
    ...chromeOptions,
    webPreferences: {
      // The DSH UI is ordinary web content from the local server. It gets no Node
      // access and no preload bridge: the shell needs nothing from the page, and the
      // page needs nothing from the shell.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  // In custom-chrome mode the overlay is drawn ON TOP of the page rather than above
  // it: probing showed the web content still starts at y=0, so the overlay covers the
  // top 34px of the DSH header (which clipped its search button). Push the page down by
  // the same height, and make the reserved strip draggable so the frameless window can
  // still be moved.
  if (darkChrome && !isMac) {
    win.webContents.on('did-finish-load', () => {
      win.webContents.insertCSS(`
        html { padding-top: ${TITLEBAR_HEIGHT}px !important; box-sizing: border-box !important; }
        body { height: 100% !important; }
        html::before {
          content: ''; position: fixed; top: 0; left: 0; right: 0;
          height: ${TITLEBAR_HEIGHT}px; background: ${CHROME_BG};
          z-index: 2147483647; -webkit-app-region: drag;
        }
      `).catch(() => {})
    })
  }

  if (settings.get('maximized')) win.maximize()

  win.once('ready-to-show', () => {
    win.show()
    if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' })
  })

  // Anything that wants a second window belongs in the user's real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // Keep navigation inside the local server; send anything else to the browser. This
  // matters because the page is trusted enough to run with the auth cookie.
  win.webContents.on('will-navigate', (event, url) => {
    const isLocal = server?.port && new URL(url).port === String(server.port)
    if (!isLocal) {
      event.preventDefault()
      if (/^https?:/i.test(url)) shell.openExternal(url)
    }
  })

  win.on('close', () => { saveWindowState() })

  const persist = () => saveWindowState()
  win.on('resize', persist)
  win.on('move', persist)

  return win
}

/**
 * Point the window at the splash screen, then start the server and navigate to it.
 */
async function boot () {
  win = createWindow()

  // A tiny inline splash screen so the window is never blank while Node boots.
  await win.loadFile(path.join(__dirname, 'loading.html'))
  const whale = readWhalePath()
  if (whale) {
    win.webContents.executeJavaScript(
      `document.getElementById('whale').setAttribute('d', ${JSON.stringify(whale)})`
    ).catch(() => {})
  }

  const setStatus = (text) => {
    if (!win || win.isDestroyed()) return
    win.webContents.executeJavaScript(`window.__setStatus(${JSON.stringify(text)})`).catch(() => {})
  }

  server = new ServerHost()
  server.onUnexpectedExit = (detail) => {
    if (quitting) return
    dialog.showMessageBox(win, {
      type: 'warning',
      title: 'DeepSeek Harness',
      message: 'The DeepSeek Harness server stopped unexpectedly; the window will close.',
      detail: detail || undefined,
      buttons: ['OK']
    }).finally(() => {
      quitting = true
      app.quit()
    })
  }

  setStatus('Starting the local server…')

  let url
  try {
    url = await server.start({
      preferredPort: Number(settings.get('port')) || 3080,
      lastPort: Number(settings.get('lastPort')) || 0,
      dshBin: settings.get('dshBinPath') || undefined,
      dshHome: settings.get('dshHome') || undefined
    })
  } catch (error) {
    if (quitting) return
    dialog.showMessageBox(win, {
      type: 'error',
      title: 'DeepSeek Harness',
      message: 'Could not start DeepSeek Harness.',
      detail: `${error.message}\n\nYou can still start it manually with:  dsh web`,
      buttons: ['Close']
    }).finally(() => {
      quitting = true
      app.quit()
    })
    return
  }

  // Remember the port actually bound so the next launch reuses the same origin.
  if (server.port > 0) {
    settings.set('lastPort', server.port)
    settings.save()
  }

  setStatus('Loading the interface…')
  await win.loadURL(url)
}

/**
 * Grant clipboard read to our own origin only, so paste works without a permission
 * prompt. Everything else keeps Electron's default.
 */
function configureSession () {
  try {
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      try {
        const origin = new URL(details?.requestingUrl || contents.getURL())
        const isLocal = origin.hostname === '127.0.0.1' || origin.hostname === 'localhost'
        if (isLocal && permission === 'clipboard-read') return callback(true)
      } catch { /* fall through */ }
      callback(false)
    })
  } catch { /* non-fatal */ }
}

/** Menus the DSH UI expects, plus the shell's own essentials. */
function buildMenu () {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Session',
          accelerator: 'CmdOrCtrl+N',
          click: () => win?.webContents.executeJavaScript(
            `(() => { const b = [...document.querySelectorAll('button')].find(x => /新会话|New (chat|session)/i.test(x.textContent||'')); if (b) b.click(); })()`
          ).catch(() => {})
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Open Settings Folder',
          click: () => shell.showItemInFolder(settings.filePath)
        },
        {
          label: 'Open in Browser',
          click: () => { if (server?.url) shell.openExternal(server.url) }
        },
        { type: 'separator' },
        {
          label: 'About',
          click: () => dialog.showMessageBox(win, {
            type: 'info',
            title: 'About',
            message: 'DeepSeek Harness',
            detail:
              `Desktop shell ${app.getVersion()}\n` +
              `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}\n` +
              `Node ${process.versions.node}\n\n` +
              `CLI: ${server?.binPath || 'unknown'}\n` +
              `Server: ${server?.url ? `port ${server.port}` : 'not running'}\n\n` +
              `Settings: ${settings.filePath}`
          })
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Stop the server. Safe to call more than once. */
function stopServer () {
  if (!server) return
  const s = server
  server = null
  try { s.stop() } catch { /* best effort */ }
}

// --- lifecycle ---------------------------------------------------------------

app.on('before-quit', () => {
  quitting = true
  saveWindowState()
  stopServer()
})

// Covers SIGINT/SIGTERM (and logout, on macOS) so no orphaned server survives.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  try {
    process.on(signal, () => {
      quitting = true
      stopServer()
      app.quit()
    })
  } catch { /* not supported on this platform */ }
}

app.on('window-all-closed', () => {
  // Closing the window must stop the server everywhere, including macOS where the
  // convention would otherwise keep the app alive in the Dock.
  quitting = true
  stopServer()
  app.quit()
})

app.on('will-quit', () => { stopServer() })

app.whenReady().then(() => {
  settings = new Settings(path.join(app.getPath('userData'), 'settings.json'))
  applyTheme()
  configureSession()
  buildMenu()
  boot().catch((error) => {
    dialog.showErrorBox('DeepSeek Harness', String(error?.stack || error))
    quitting = true
    app.quit()
  })
})
