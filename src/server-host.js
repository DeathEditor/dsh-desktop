'use strict'

/**
 * Owns the `dsh web` child process.
 *
 * `dsh web` does not serve a plain URL: the root returns 401 until a per-process
 * launch token is presented, and that token is only printed at startup as
 *
 *     dsh web: http://127.0.0.1:3080/?token=...
 *
 * Visiting that URL once mints a session cookie and redirects to a clean `/`. So a
 * shell cannot simply point a window at http://127.0.0.1:3080 — it has to start the
 * server itself and scrape that line. That is also what makes "close the window and
 * everything stops" possible: whoever starts the server owns its lifetime.
 *
 * The regex and the launch contract below intentionally mirror the Windows shell that
 * this Electron rewrite replaces; `build/verify-contract.js` checks them against a
 * real installation so an upstream change fails loudly instead of silently hanging.
 */

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

/** Matches the line `dsh web` prints once it is listening. */
const LAUNCH_URL_RE = /dsh web:\s*(http:\/\/127\.0\.0\.1:(?<port>\d+)\/\?token=\S+)/

/** How long to wait for that line before giving up. First run can be slow. */
const DEFAULT_TIMEOUT_MS = 120000

/**
 * Locate the installed dsh CLI entry point.
 *
 * Resolution order: an explicit override, then the `dsh` the user's own shell would
 * run, then the npm global root, then the platform's conventional global locations.
 * Returns null when nothing is found so the caller can show an actionable message.
 */
function resolveDshBin (override) {
  const candidates = []

  if (override) candidates.push(override)

  const home = os.homedir()

  // The `dsh` on PATH outranks the npm prefixes below, because that is the CLI the user
  // actually runs — and it is the only way to find one that is not in an npm prefix at
  // all, such as a source build symlinked into ~/.local/bin.
  candidates.push(...pathDshCandidates(home))

  // npm's global root, the same way `npm root -g` reports it.
  const appData = process.env.APPDATA

  if (process.platform === 'win32') {
    if (appData) candidates.push(path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    if (process.env.ProgramFiles) {
      candidates.push(path.join(process.env.ProgramFiles, 'nodejs', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    }
  } else {
    // Homebrew / nvm / system prefixes, plus the common per-user prefix.
    candidates.push(path.join(home, '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    candidates.push('/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js')
    candidates.push('/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js')
    candidates.push('/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js')
  }

  // Last resort: ask npm where its global root is. This spawns a process, so it runs
  // only when the guesses above all missed.
  if (candidates.every((c) => !isFile(c))) {
    const guess = npmGlobalRoot()
    if (guess) candidates.push(path.join(guess, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }

  return candidates.find(isFile) || null
}

/**
 * Candidate CLI entries found by looking for a `dsh` executable on the user's PATH.
 *
 * What turns up this way is normally a symlink — npm's global install, `npm link`, or a
 * manual link into a source checkout — so it is resolved before use: the server is
 * started as `node <entry>.js`, and a symlink's own path is not that file. Anything
 * that does not resolve to a `.js` file is skipped rather than guessed at, which is
 * what keeps a Windows `dsh.cmd` shim (a batch script) from being handed to node; those
 * fall through to the npm-prefix guesses above.
 */
function pathDshCandidates (home) {
  const found = []
  for (const dir of dshSearchDirs(home)) {
    const link = path.join(dir, 'dsh')
    if (!isFile(link)) continue
    const real = realpathOrNull(link)
    if (real && real.endsWith('.js')) found.push(real)
  }
  return found
}

/**
 * Directories worth looking in for the `dsh` launcher, best guess first.
 *
 * PATH alone is not enough. A GUI-launched macOS app is started by launchd, so it
 * inherits launchd's minimal default (/usr/bin:/bin:/usr/sbin:/sbin) rather than the
 * login shell's PATH — a per-user install, which is exactly what a source build or
 * `npm link` produces, is invisible to it. The extra prefixes below cover that case.
 */
function dshSearchDirs (home) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)

  if (process.platform === 'win32') {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'))
    if (process.env.ProgramFiles) dirs.push(path.join(process.env.ProgramFiles, 'nodejs'))
    return dirs
  }

  dirs.push(
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.npm-global', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  )

  // Version managers put each toolchain's globally installed bins next to node itself,
  // and keep node outside every directory listed above.
  for (const node of versionManagerNodes(home)) dirs.push(path.dirname(node))

  return dirs
}

function realpathOrNull (p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

/** Ask npm for its global root. Returns null when npm is unavailable. */
function npmGlobalRoot () {
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const out = spawnSync(npm, ['root', '-g'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
      shell: process.platform === 'win32'
    })
    if (out.status !== 0) return null
    const root = String(out.stdout || '').trim().split(/\r?\n/).pop()
    return root && fs.existsSync(root) ? root : null
  } catch {
    return null
  }
}

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

/**
 * Pick a port: the preferred one when free, else the one used last time, else let the
 * OS assign. Keeping the fallback sticky matters because the browser origin is
 * host+port, and a different origin starts the UI with empty local state.
 */
async function choosePort (preferred, lastPort) {
  for (const candidate of [preferred, lastPort]) {
    if (!Number.isInteger(candidate) || candidate <= 0 || candidate > 65535) continue
    if (await isPortFree(candidate)) return candidate
  }
  return 0
}

function isPortFree (port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

class ServerHost {
  constructor () {
    this.child = null
    this.url = null
    this.port = 0
    this.stopping = false
    /** Called when the server dies on its own after a successful start. */
    this.onUnexpectedExit = null
  }

  /**
   * Start `dsh web` and resolve once its authenticated URL is known.
   *
   * @param {object} options
   * @param {number} options.preferredPort port to try first
   * @param {number} options.lastPort      port used last time, tried second
   * @param {string} [options.dshBin]      explicit CLI entry point
   * @param {string} [options.dshHome]     DSH_HOME to run against
   * @param {number} [options.timeoutMs]   how long to wait for the URL line
   * @returns {Promise<string>} the authenticated URL
   */
  async start (options = {}) {
    const {
      preferredPort = 3080,
      lastPort = 0,
      dshBin,
      dshHome,
      timeoutMs = DEFAULT_TIMEOUT_MS
    } = options

    const bin = resolveDshBin(dshBin)
    if (!bin) {
      throw new Error(
        'Could not find the dsh CLI.\n\n' +
        'Install it with:\n    npm install -g @deepseek-ai/dsh\n\n' +
        'If it is installed somewhere unusual, set "dshBinPath" in settings.json.'
      )
    }
    this.binPath = bin

    const node = resolveNode()
    const port = await choosePort(preferredPort, lastPort)

    const args = [bin, 'web', '--no-open', '--port', String(port)]

    // A console window must never appear. On Windows `windowsHide` suppresses it; on
    // POSIX a detached child gets its own process group, which is what lets us kill
    // the whole tree (PowerShell runners, MCP servers, ...) in one signal later.
    const env = {
      ...process.env,
      ...(dshHome ? { DSH_HOME: dshHome } : {}),
      NO_COLOR: '1'
    }

    // These are inherited by every Electron process and would confuse a plain Node
    // child -- EXCEPT when that child IS Electron, used as a Node runtime fallback.
    delete env.ELECTRON_NO_ATTACH_CONSOLE
    if (node.needsRunAsNode) env.ELECTRON_RUN_AS_NODE = '1'
    else delete env.ELECTRON_RUN_AS_NODE

    const spawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env
    }

    const child = spawn(node.cmd, args, spawnOptions)
    this.child = child

    let stderr = ''
    let settled = false

    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(
          `The dsh web server did not report a URL within ${Math.round(timeoutMs / 1000)}s.` +
          tail(stderr)
        ))
      }, timeoutMs)

      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(value)
      }

      let buffered = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        buffered += chunk
        const match = LAUNCH_URL_RE.exec(buffered)
        if (match) finish(resolve, match[1])
      })

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => { stderr += chunk })

      child.on('error', (error) => {
        finish(reject, new Error(`Could not launch the dsh server: ${error.message}`))
      })

      child.on('exit', (code) => {
        // An expected shutdown must not surface as a startup failure.
        if (this.stopping) return finish(reject, new Error('cancelled'))
        finish(reject, new Error(
          `The dsh web server exited during startup (code ${code}).` + tail(stderr)
        ))
      })
    })

    this.url = url
    const portMatch = /:(\d+)\//.exec(url)
    this.port = portMatch ? Number(portMatch[1]) : port

    // Only after a successful start does an exit mean something went wrong.
    child.on('exit', () => {
      if (this.stopping) return
      if (typeof this.onUnexpectedExit === 'function') this.onUnexpectedExit(tail(stderr))
    })

    return url
  }

  /** Stop the server and every process it spawned. Idempotent. */
  stop () {
    this.stopping = true
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null || child.signalCode !== null) return

    try {
      if (process.platform === 'win32') {
        // /T takes the tree, /F forces it. The child is already windowless.
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          timeout: 10000
        })
      } else {
        // Negative pid signals the whole process group created by `detached: true`.
        try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
        // Escalate if it ignores SIGTERM.
        setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
        }, 3000).unref?.()
      }
    } catch { /* nothing left to kill */ }

    try { child.kill() } catch { /* already gone */ }
  }
}

/** Last few stderr lines, for an actionable error message. */
function tail (text, lines = 12) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return ''
  return '\n\n' + trimmed.split(/\r?\n/).slice(-lines).join('\n')
}

module.exports = {
  ServerHost,
  resolveDshBin,
  resolveNode,
  LAUNCH_URL_RE,
  DEFAULT_TIMEOUT_MS
}
