'use strict'

/**
 * Locating the Node runtime that will run the dsh CLI.
 *
 * This lives apart from server-host.js because two callers need it — the server
 * itself and the launcher/probe used while locating or validating an installation —
 * and server-host.js already depends on the launcher. Keeping it here avoids a
 * require cycle.
 */

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/**
 * Find the Node runtime to run the CLI with.
 *
 * @returns {{cmd: string, needsRunAsNode: boolean}} `needsRunAsNode` is true when the
 *   only runtime available is Electron itself, which must then be started with
 *   ELECTRON_RUN_AS_NODE=1 to behave as plain Node.
 */
function resolveNode () {
  const exe = process.platform === 'win32' ? 'node.exe' : 'node'
  const home = os.homedir()
  const candidates = []

  if (process.platform === 'win32') {
    if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'nodejs', exe))
  } else {
    // Homebrew (Apple Silicon and Intel), MacPorts, and the system default.
    candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/opt/local/bin/node', '/usr/bin/node')
    // Version managers are common on macOS and put node outside every path above.
    // nvm keeps one directory per installed version.
    candidates.push(...versionManagerNodes(home))
  }

  const found = candidates.find(isFile)
  if (found) return { cmd: found, needsRunAsNode: false }

  // PATH lookup. A GUI-launched macOS app inherits a minimal PATH, so this often
  // misses even when node is installed; that is what the fallback below is for.
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [exe], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (which.status === 0) {
    const first = String(which.stdout || '').trim().split(/\r?\n/)[0]
    if (first && isFile(first)) return { cmd: first, needsRunAsNode: false }
  }

  // Last resort: Electron ships its own Node. ELECTRON_RUN_AS_NODE turns this very
  // binary into a plain Node runtime, so the app works with no system Node at all.
  return { cmd: process.execPath, needsRunAsNode: true }
}

/** Node binaries installed by common version managers, newest first. */
function versionManagerNodes (home) {
  const found = []
  try {
    // nvm: ~/.nvm/versions/node/v20.11.0/bin/node
    const nvmDir = path.join(home, '.nvm', 'versions', 'node')
    if (fs.existsSync(nvmDir)) {
      const versions = fs.readdirSync(nvmDir).sort(compareVersionsDesc)
      for (const v of versions) found.push(path.join(nvmDir, v, 'bin', 'node'))
    }
    // fnm, volta, and asdf keep a `current` symlink alongside installed versions.
    for (const p of [
      path.join(home, '.volta', 'bin', 'node'),
      path.join(home, '.asdf', 'shims', 'node'),
      path.join(home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin', 'node'),
      path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'node')
    ]) {
      if (isFile(p)) found.push(p)
    }
  } catch { /* unreadable home: fall through to the Electron runtime */ }
  return found
}

/** Sort version directory names newest-first (best effort; unknown names go last). */
function compareVersionsDesc (a, b) {
  const num = (s) => (String(s).match(/\d+/g) || []).map(Number)
  const av = num(a); const bv = num(b)
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const d = (bv[i] || 0) - (av[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

function isFile (p) {
  try {
    return !!p && fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function isDir (p) {
  try {
    return !!p && fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** realpath, or null when the path does not exist. */
function realpathOrNull (p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

module.exports = {
  resolveNode,
  versionManagerNodes,
  compareVersionsDesc,
  isFile,
  isDir,
  realpathOrNull
}
