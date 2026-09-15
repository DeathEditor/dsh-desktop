'use strict'

/**
 * Persisted shell preferences, stored as JSON under Electron's userData directory.
 *
 * Every read is defensive: a corrupt or unreadable file falls back to defaults rather
 * than preventing the app from starting.
 */

const fs = require('node:fs')
const path = require('node:path')

const DEFAULTS = {
  /** Port to try first. */
  port: 3080,
  /** Port actually bound last time, retried second so the UI origin stays stable. */
  lastPort: 0,
  /** Window bounds in Electron's display-independent coordinates, or null. */
  bounds: null,
  maximized: false,
  /** Explicit paths; empty means "discover automatically". */
  dshBinPath: '',
  /** Alternate DSH_HOME to run against; empty means the user's default. */
  dshHome: '',
  /**
   * Window chrome: 'system' keeps the stock OS title bar (default), 'dark' hides it
   * and paints a dark one.
   *
   * Why not default to 'dark': on Windows every caption bar takes the user's accent
   * colour when "show accent colour on title bars" is on, and nothing but a custom
   * frame overrides that. But a custom frame turns the top strip into a drag handle,
   * so clicks there stop reaching the DSH header. 'system' therefore keeps normal
   * behaviour and matches the rest of the machine.
   */
  theme: 'system'
}

class Settings {
  constructor (filePath) {
    this.filePath = filePath
    this.values = { ...DEFAULTS }
    this.load()
  }

  load () {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        this.values = { ...DEFAULTS, ...parsed }
      }
    } catch {
      // Missing or corrupt: defaults already applied.
    }
    return this.values
  }

  save () {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      // Write-then-rename so a crash mid-write cannot truncate the file.
      const tmp = `${this.filePath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2), 'utf8')
      fs.renameSync(tmp, this.filePath)
      return true
    } catch {
      // Preferences are a convenience, never fatal.
      return false
    }
  }

  get (key) {
    return this.values[key]
  }

  set (key, value) {
    this.values[key] = value
  }

  merge (patch) {
    Object.assign(this.values, patch)
  }
}

module.exports = { Settings, DEFAULTS }
