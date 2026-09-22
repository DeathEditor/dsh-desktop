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
 * Where the CLI comes from, and how to execute it (a built install and a TypeScript
 * checkout are launched differently), is dsh-launch.js's business; this file takes a
 * ready descriptor and runs it.
 *
 * The regex and the launch contract below intentionally mirror the Windows shell that
 * this Electron rewrite replaces; `build/verify-contract.js` checks them against a
 * real installation so an upstream change fails loudly instead of silently hanging.
 */

const { spawn, spawnSync } = require('node:child_process')
const net = require('node:net')

const { spawnPlan } = require('./dsh-launch')
const { locate, resolveDshBin } = require('./dsh-locate')
const { resolveNode } = require('./node-runtime')

/** Matches the line `dsh web` prints once it is listening. */
const LAUNCH_URL_RE = /dsh web:\s*(http:\/\/127\.0\.0\.1:(?<port>\d+)\/\?token=\S+)/

/** How long to wait for that line before giving up. First run can be slow. */
const DEFAULT_TIMEOUT_MS = 120000

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
    /** The descriptor this server was started from. */
    this.descriptor = null
    /** The CLI entry point, for display. */
    this.binPath = null
    /** Called when the server dies on its own after a successful start. */
    this.onUnexpectedExit = null
  }

  /**
   * Start `dsh web` and resolve once its authenticated URL is known.
   *
   * @param {object} options
   * @param {object} options.descriptor   launch descriptor from dsh-locate/dsh-launch
   * @param {number} options.preferredPort port to try first
   * @param {number} options.lastPort      port used last time, tried second
   * @param {string} [options.dshBin]      legacy: an explicit CLI entry to describe
   * @param {string} [options.dshHome]     DSH_HOME to run against
   * @param {number} [options.timeoutMs]   how long to wait for the URL line
   * @returns {Promise<string>} the authenticated URL
   */
  async start (options = {}) {
    const {
      preferredPort = 3080,
      lastPort = 0,
      dshHome,
      timeoutMs = DEFAULT_TIMEOUT_MS
    } = options

    const descriptor = options.descriptor || locate(options.dshBin)
    if (!descriptor) {
      throw new Error(
        'Could not find the dsh CLI.\n\n' +
        'Install it with:\n    npm install -g @deepseek-ai/dsh\n\n' +
        'If it is installed somewhere unusual, set "dshBinPath" in settings.json.'
      )
    }

    let plan
    try {
      plan = spawnPlan(descriptor)
    } catch (error) {
      throw new Error(`Could not prepare to launch dsh: ${error.message}`)
    }

    this.descriptor = descriptor
    this.binPath = descriptor.entry

    const port = await choosePort(preferredPort, lastPort)
    const args = [...plan.args, 'web', '--no-open', '--port', String(port)]

    // A console window must never appear. On Windows `windowsHide` suppresses it; on
    // POSIX a detached child gets its own process group, which is what lets us kill
    // the whole tree (PowerShell runners, MCP servers, ...) in one signal later.
    const env = {
      ...plan.env,
      ...(dshHome ? { DSH_HOME: dshHome } : {})
    }

    const spawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      cwd: plan.cwd,
      env
    }

    const child = spawn(plan.cmd, args, spawnOptions)
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
  locate,
  resolveDshBin,
  resolveNode,
  LAUNCH_URL_RE,
  DEFAULT_TIMEOUT_MS
}
