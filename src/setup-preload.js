'use strict'

/**
 * Bridge for the setup screen.
 *
 * The page gets no Node access: only these five calls, each of which the main process
 * answers (and ignores outside an active setup session). Drag-and-drop needs
 * `webUtils.getPathForFile`, because a dropped `File` carries no readable path in a
 * sandboxed renderer.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron')

const INVOKE_CHANNELS = [
  'setup:state',
  'setup:choose-folder',
  'setup:use-path',
  'setup:install',
  'setup:cancel-install',
  'setup:confirm',
  'setup:rescan',
  'setup:quit',
  'setup:open-log'
]

const api = {
  /** Current state: what was detected, whether an install is running, ... */
  getState: () => ipcRenderer.invoke('setup:state'),

  /** Open a native folder picker. Returns the chosen folder's verdict, or null. */
  chooseFolder: () => ipcRenderer.invoke('setup:choose-folder'),

  /** Inspect a specific path (drag-and-drop, or a paste). */
  usePath: (target) => ipcRenderer.invoke('setup:use-path', String(target || '')),

  /** Start the one-click install. Resolves when it finishes. */
  install: () => ipcRenderer.invoke('setup:install'),

  /** Ask a running install to stop. */
  cancelInstall: () => ipcRenderer.invoke('setup:cancel-install'),

  /** Accept the current selection and continue booting. */
  confirm: () => ipcRenderer.invoke('setup:confirm'),

  /** Re-run detection, e.g. after the user installed dsh in a terminal. */
  rescan: () => ipcRenderer.invoke('setup:rescan'),

  /** Give up and close the app. */
  quit: () => ipcRenderer.invoke('setup:quit'),

  /** Reveal a log file in the OS file manager. */
  openLog: (file) => ipcRenderer.invoke('setup:open-log', String(file || '')),

  /** Progress lines from a running install. Returns an unsubscribe function. */
  onProgress: (handler) => {
    const listener = (_event, line) => handler(String(line))
    ipcRenderer.on('setup:progress', listener)
    return () => ipcRenderer.removeListener('setup:progress', listener)
  },

  /** State snapshots pushed while a scan or install runs. Returns an unsubscribe function. */
  onState: (handler) => {
    const listener = (_event, next) => handler(next)
    ipcRenderer.on('setup:state-changed', listener)
    return () => ipcRenderer.removeListener('setup:state-changed', listener)
  },

  /** The filesystem path of a dropped File, or '' when it has none. */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  }
}

contextBridge.exposeInMainWorld('dshSetup', api)
