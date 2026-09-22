'use strict'

/**
 * The guided setup screen, shown when no dsh installation could be started.
 *
 * This is deliberately *not* the first thing the app does. Discovery plus a real boot
 * attempt happen first, and only a genuine failure — nothing found, or something found
 * that would not run — lands the user here. That ordering matters: it means a machine
 * with a working dsh never sees this screen, and a machine without one gets an
 * explanation of what actually went wrong rather than a wall of instructions.
 *
 * The screen offers exactly two ways forward, as the situation calls for:
 *
 *   1. install it (npm global, falling back to a prefix inside the app's own folder),
 *   2. point the app at a folder that already has it — a source checkout or an
 *      installed package.
 *
 * Nothing is accepted on trust: every choice is validated by launching it before the
 * window is allowed to continue, so the next thing the user sees is the app, not
 * another error.
 */

const { BrowserWindow, dialog, ipcMain, shell } = require('electron')
const path = require('node:path')

const { validate, locateAll, explainUnusable, readVersion } = require('./dsh-locate')
const { describeAll } = require('./dsh-launch')
const { install, npmAvailable, defaultFallbackPrefix } = require('./dsh-install')

/** How many discovered installations to try during a scan, newest-first order. */
const MAX_SCAN = 6

/** How long a single validation probe may take. */
const VALIDATE_TIMEOUT_MS = 60000

class SetupFlow {
  /**
   * @param {object} options
   * @param {object} options.settings   the app's Settings instance
   * @param {string} options.userData   where a private install may be placed
   * @param {string} [options.whale]    SVG path for the logo, '' when unavailable
   * @param {() => boolean} [options.isQuitting]
   */
  constructor (options) {
    this.settings = options.settings
    this.userData = options.userData
    this.whale = options.whale || ''
    this.isQuitting = options.isQuitting || (() => false)

    this.win = null
    this.resolve = null
    this.selection = null
    this.selectedDescriptor = null
    this.candidates = []
    this.folderError = ''
    this.installing = false
    this.installFinished = false
    this.controller = null
    this.handlers = []
    /**
     * Whether npm can be driven at all. Resolved once: it walks the filesystem looking
     * for npm next to node, and every state push asks for it.
     */
    this.npmAvailable = npmAvailable()
  }

  /**
   * Show the screen and resolve once the user has produced a working installation.
   *
   * The window is deliberately left open when this resolves. The caller closes it only
   * after putting something else on screen, because this app quits as soon as its last
   * window closes — closing first would tear the process down mid-handover.
   *
   * @param {object} context
   * @param {object[]} [context.candidates] installations already found and tried
   * @param {string} [context.reason]       what went wrong, shown to the user
   * @param {BrowserWindow} [context.replace] window this screen supersedes (the splash)
   * @returns {Promise<object|null>} a validated launch descriptor, or null if the user declined
   */
  async open (context = {}) {
    this.candidates = context.candidates || locateAll(this.settings.get('dshBinPath') || undefined)
    this.reason = context.reason || ''
    this.forced = !!context.forced

    this.createWindow()
    this.registerIpc()

    // Only now that this window exists: closing the splash any earlier would leave the
    // app with no windows at all, which quits it.
    const replaced = context.replace
    if (replaced && !replaced.isDestroyed()) replaced.destroy()

    const shown = new Promise((resolve) => { this.resolve = resolve })
    await this.win.loadFile(path.join(__dirname, 'setup.html'))
    this.win.show()

    const chosen = await shown
    this.release()
    return chosen
  }

  createWindow () {
    this.win = new BrowserWindow({
      width: 780,
      height: 760,
      minWidth: 620,
      minHeight: 560,
      show: false,
      backgroundColor: '#18181b',
      title: 'DeepSeek Harness — Setup',
      autoHideMenuBar: true,
      webPreferences: {
        // The only page in the app with a preload, and the only one that talks back to
        // the main process. It stays sandboxed with context isolation: the bridge is a
        // fixed set of calls, not Node access.
        preload: path.join(__dirname, 'setup-preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        spellcheck: false
      }
    })

    // Closing the window with the title bar is a legitimate way to decline.
    this.win.on('closed', () => {
      this.win = null
      this.finish(null)
    })
  }

  /** Snapshot for the renderer. */
  state () {
    return {
      whale: this.whale,
      installing: this.installing,
      installFinished: this.installFinished,
      selection: this.selection,
      candidates: this.candidates.map((c) => ({ entry: c.entry, fromCheckout: !!c.fromCheckout, kind: c.kind })),
      folderError: this.folderError,
      npmAvailable: this.npmAvailable,
      reason: this.reason,
      forced: this.forced
    }
  }

  send (channel, payload) {
    if (!this.win || this.win.isDestroyed()) return
    this.win.webContents.send(channel, payload)
  }

  /** Push a full state snapshot to the renderer. */
  push () {
    this.send('setup:state-changed', this.state())
  }

  finish (descriptor) {
    if (!this.resolve) return
    const resolve = this.resolve
    this.resolve = null
    resolve(descriptor)
  }

  /** Record a validated descriptor, leaving the user to press Continue. */
  accept (descriptor, source) {
    this.selection = {
      source,
      entry: descriptor.entry,
      version: descriptor.version || readVersion(descriptor),
      fromCheckout: !!descriptor.fromCheckout
    }
    this.selectedDescriptor = descriptor
    this.folderError = ''
    this.push()
  }

  /**
   * Turn a user-chosen path into a descriptor and prove it runs.
   *
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  async usePath (target) {
    const trimmed = String(target || '').trim()
    if (!trimmed) return { ok: false, error: 'No path was given.' }

    // Reject a path that is not a dsh installation at all before spawning anything.
    const descriptors = describeAll(trimmed)
    if (!descriptors.length) {
      this.folderError = explainUnusable(trimmed)
      this.push()
      return { ok: false, error: this.folderError }
    }

    this.folderError = ''
    this.installing = true
    this.push()

    let lastError = ''
    for (const descriptor of descriptors) {
      const result = await validate(descriptor, { timeoutMs: VALIDATE_TIMEOUT_MS })
      if (result.ok) {
        this.installing = false
        this.accept({ ...descriptor, version: result.version }, 'folder')
        return { ok: true }
      }
      lastError = result.detail
    }

    this.installing = false
    this.folderError =
      `${descriptors[0].entry} was found but could not be started.\n\n${lastError}`
    this.push()
    return { ok: false, error: this.folderError }
  }

  /** Detect again and validate whatever turns up, so a terminal install is picked up. */
  async rescan () {
    this.folderError = ''
    this.installing = true
    this.push()

    const found = locateAll(this.settings.get('dshBinPath') || undefined)
    this.candidates = found
    for (const descriptor of found.slice(0, MAX_SCAN)) {
      const result = await validate(descriptor, { timeoutMs: VALIDATE_TIMEOUT_MS })
      if (result.ok) {
        this.installing = false
        this.accept({ ...descriptor, version: result.version }, 'scan')
        return { ok: true }
      }
      this.folderError = `${descriptor.entry} could not be started.\n\n${result.detail}`
    }

    this.installing = false
    this.candidates = found
    this.push()
    return { ok: false }
  }

  /** One-click install, then validate what it produced. */
  async runInstall () {
    if (this.installing) return { ok: false, error: 'An install is already running.' }

    this.installing = true
    this.installFinished = false
    this.folderError = ''
    this.push()

    this.controller = new AbortController()
    const result = await install({
      fallbackPrefix: defaultFallbackPrefix(this.userData),
      signal: this.controller.signal,
      onProgress: (line) => this.send('setup:progress', line)
    })

    this.installing = false
    this.installFinished = true
    this.controller = null

    if (!result.ok) {
      this.push()
      return { ok: false, error: result.error, log: result.log }
    }

    // An install that produced a file is not yet an install that works.
    const probe = await validate(result.descriptor, { timeoutMs: VALIDATE_TIMEOUT_MS })
    if (!probe.ok) {
      this.push()
      return {
        ok: false,
        error: `The installation finished but did not start correctly.\n\n${probe.detail}`,
        log: result.log
      }
    }

    const note = result.target === 'global'
      ? ''
      : `Installed to ${result.prefix}. To remove it later, delete that folder.`

    this.accept({ ...result.descriptor, version: probe.version }, 'install')
    return {
      ok: true,
      entry: result.descriptor.entry,
      version: probe.version,
      target: result.target,
      note
    }
  }

  registerIpc () {
    const on = (channel, handler) => {
      ipcMain.handle(channel, handler)
      this.handlers.push(channel)
    }

    on('setup:state', () => this.state())

    on('setup:choose-folder', async () => {
      const picked = await dialog.showOpenDialog(this.win, {
        title: 'Select your DeepSeek Harness folder',
        message: 'Select the deepseek-harness repository folder, or an installed @deepseek-ai/dsh folder.',
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Use this folder'
      })
      if (picked.canceled || !picked.filePaths?.length) return null
      return this.usePath(picked.filePaths[0])
    })

    on('setup:use-path', (_event, target) => this.usePath(target))
    on('setup:install', () => this.runInstall())
    on('setup:cancel-install', () => {
      this.controller?.abort()
      return true
    })
    on('setup:rescan', () => this.rescan())
    on('setup:confirm', () => {
      if (!this.selectedDescriptor) return { ok: false }
      // Already validated on the way in: nothing further to prove.
      this.finish(this.selectedDescriptor)
      return { ok: true }
    })
    on('setup:quit', () => {
      this.finish(null)
      return true
    })
    on('setup:open-log', (_event, file) => {
      if (typeof file === 'string' && file) shell.showItemInFolder(file)
      return true
    })
  }

  /**
   * Drop the IPC handlers and stop any install, without touching the window.
   *
   * Called when the screen is done with, and again by `close()`.
   */
  release () {
    for (const channel of this.handlers) {
      try { ipcMain.removeHandler(channel) } catch { /* not registered */ }
    }
    this.handlers = []
    this.controller?.abort()
    this.controller = null
  }

  /** Close the setup window. Safe to call after `open()` has already resolved. */
  close () {
    this.release()
    this.resolve = null
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }
}

module.exports = { SetupFlow }
