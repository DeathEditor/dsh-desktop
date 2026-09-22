'use strict'

/**
 * Finding a usable dsh installation, and proving that it works before the app tries
 * to boot a server with it.
 *
 * Discovery order mirrors what the user's own shell would do, because that is the CLI
 * they actually run:
 *
 *   1. an explicit override (settings.json, or a folder chosen in the setup screen),
 *   2. a `dsh` launcher found on PATH — including the directories a GUI-launched app
 *      cannot see (see dshSearchDirs),
 *   3. a source checkout in one of the usual places, which is what someone following
 *      the repository's "run from source" instructions ends up with,
 *   4. npm's global root and the platform's conventional global prefixes.
 *
 * Finding a file is not the same as finding a *working* installation, so every
 * candidate is validated by running it: see `validate`.
 */

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { describeInstall, describeAll, isPackagedEntry, DSH_PACKAGE } = require('./dsh-launch')
const { isFile, isDir, realpathOrNull, versionManagerNodes } = require('./node-runtime')

/** Directories a checkout is commonly cloned into. */
function checkoutSearchDirs (home) {
  const dirs = [
    path.join(home, 'GitRepo'),
    path.join(home, 'git'),
    path.join(home, 'Projects'),
    path.join(home, 'projects'),
    path.join(home, 'code'),
    path.join(home, 'Code'),
    path.join(home, 'dev'),
    path.join(home, 'Developer'),
    path.join(home, 'src'),
    path.join(home, 'workspace'),
    path.join(home, 'repos')
  ]
  if (process.platform === 'darwin') dirs.push(path.join(home, 'Documents'))
  return dirs
}

/**
 * Candidate checkout roots, best guess first.
 *
 * Only `deepseek-harness` is matched: a checkout that has been renamed cannot be told
 * apart from an unrelated project when it has not been built, so the setup screen's
 * folder picker is the answer for those.
 */
function checkoutCandidates (home) {
  const found = []
  for (const dir of checkoutSearchDirs(home)) {
    if (!isDir(dir)) continue
    for (const name of ['deepseek-harness', 'dsh', 'deepseek-harness-main']) {
      const candidate = path.join(dir, name)
      if (isDir(candidate)) found.push(candidate)
    }
  }
  return found
}

/**
 * Candidate CLI entry points, in the order they should be trusted.
 *
 * Entries that do not exist are kept: the caller may want to report that an override
 * was wrong rather than silently falling through to another installation.
 */
function candidateLocations (override) {
  const candidates = []
  if (override) candidates.push(override)

  const home = os.homedir()

  // The `dsh` on PATH outranks the npm prefixes below, because that is the CLI the user
  // actually runs — and it is the only way to find one that is not in an npm prefix at
  // all, such as a source build symlinked into ~/.local/bin.
  candidates.push(...pathDshCandidates(home))

  // A source checkout: the shape produced by following the repository instructions.
  candidates.push(...checkoutCandidates(home))

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
  if (!candidates.some((c) => looksInstalled(c))) {
    const guess = npmGlobalRoot()
    if (guess) candidates.push(path.join(guess, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }

  return candidates
}

function looksInstalled (location) {
  if (!location) return false
  if (isFile(location)) return true
  return isDir(location) && !!describeInstall(location)
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
 * Locate a usable dsh installation and describe how to launch it.
 *
 * @param {string} [override] explicit path from settings.json or the setup screen
 * @returns {object|null} a launch descriptor (see dsh-launch.js), or null
 */
function locate (override) {
  return locateAll(override)[0] || null
}

/**
 * Every launchable candidate, best first.
 *
 * Duplicates are collapsed by entry point, so a checkout found both on PATH and by
 * directory scan is offered once. Candidates that exist but cannot be run are included
 * as-is — the caller decides whether to try them.
 *
 * @param {string} [override]
 * @returns {object[]}
 */
function locateAll (override) {
  const seen = new Set()
  const descriptors = []
  for (const candidate of candidateLocations(override)) {
    for (const descriptor of describeAll(candidate)) {
      if (seen.has(descriptor.entry)) continue
      seen.add(descriptor.entry)
      descriptors.push(descriptor)
    }
  }
  return descriptors
}

/**
 * Whether a location can be described as a dsh installation, without proving it runs.
 * Used by the setup screen to give immediate feedback on a folder the user picked.
 */
function looksLikeInstall (location) {
  return !!describeInstall(location)
}

/**
 * Whether anything that could plausibly run dsh exists, without proving that it does.
 *
 * Deliberately cheap and synchronous: it decides only whether to open the setup screen,
 * and `validate()` is what confirms the answer.
 */
function hasCandidate (override) {
  if (override && describeInstall(override)) return true
  return locateAll(override).length > 0
}

/** Convenience wrapper: the entry point path, or null. Kept for existing callers. */
function resolveDshBin (override) {
  return locate(override)?.entry || null
}

/**
 * Why a location could not be used, phrased for someone who chose it on purpose.
 *
 * The interesting case is a checkout that exists but cannot run: without tsx and a
 * tsconfig there is no way to execute TypeScript sources, and without a build there is
 * no packaged entry either — so the fix is a command, not a different folder.
 */
function explainUnusable (location) {
  if (!location) return 'No path was given.'
  const resolved = path.resolve(location)

  if (!fs.existsSync(resolved)) return `Nothing exists at ${resolved}.`

  if (isFile(resolved)) {
    return `${resolved} is a file, but not a dsh entry point.\n\n` +
      `Expected either a packaged CLI (…/${DSH_PACKAGE}/lib/bin.js) or a checkout's apps/cli/src/bin.ts.`
  }

  // A directory. Check the "right place, not ready yet" cases before giving up.
  const roots = [resolved, path.resolve(resolved, '..'), path.resolve(resolved, '..', '..')]
  for (const root of roots) {
    const cliPkg = path.join(root, 'apps', 'cli', 'package.json')
    if (!isFile(cliPkg)) continue
    const hasTsx = isFile(path.join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs'))
    const hasTsconfig = isFile(path.join(root, 'tsconfig.json')) || isFile(path.join(root, 'tsconfig.base.json'))
    if (hasTsx && hasTsconfig) continue

    const missing = []
    if (!hasTsx) missing.push('node_modules (run: pnpm install)')
    if (!hasTsconfig) missing.push('tsconfig.json')
    return `This is a DeepSeek Harness checkout at ${root}, but it cannot be run yet: ` +
      `${missing.join(' and ')} missing.\n\n` +
      'Run these in the checkout, then choose the folder again:\n' +
      `    cd ${root}\n    pnpm install\n    pnpm run build`
  }

  // A package that is present but has no usable entry point: usually a half-finished
  // install, which is worth saying plainly rather than reporting as "not found".
  for (const modulesDir of [resolved, path.join(resolved, 'node_modules'), path.join(resolved, 'lib', 'node_modules')]) {
    const nested = path.join(modulesDir, ...DSH_PACKAGE.split('/'))
    if (!isDir(nested)) continue
    return `${resolved} contains a dsh package but no usable entry point.\n` +
      'It may be only half-installed; reinstalling it should fix that.'
  }

  return `No dsh installation was found at ${resolved}.\n\n` +
    'Choose the checkout folder (the one containing apps/ and packages/), the ' +
    `installed package folder (…/${DSH_PACKAGE}), or an npm prefix.`
}

/**
 * Prove that a descriptor actually works, by booting a real server with it.
 *
 * The obvious cheap probe — `dsh web --help` — is not enough, and the difference is not
 * academic: it exits 0 for an installation whose plugins cannot load at all (for example
 * a native module built for a different Node ABI than the runtime in use), because
 * `--help` never composes the plugin tree. A probe that says "fine" and is then followed
 * by a failed boot is worse than no probe, so this boots `dsh web` for real on an
 * ephemeral port and waits for the authenticated URL line the shell depends on.
 *
 * That is affordable: a boot takes well under a second, and the server is stopped again
 * immediately. Two things fall out of doing it this way:
 *
 *   - the launch contract the shell relies on (the `dsh web: <url>` line) is verified
 *     against this exact installation, not assumed from a version number;
 *   - nothing is written to the user's profile. The probe always runs against a
 *     throwaway DSH_HOME, because merely checking an installation must not create or
 *     migrate the profile the user actually works in.
 *
 * @param {object} descriptor
 * @param {object} [options]
 * @param {string} [options.dshHome] DSH_HOME for the probe (defaults to a scratch dir)
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ok: boolean, version: string, detail: string, output: string, url: string}>}
 */
function validate (descriptor, options = {}) {
  const { spawnPlan } = require('./dsh-launch')
  const { timeoutMs = 60000 } = options

  return new Promise((resolve) => {
    let plan
    try {
      plan = spawnPlan(descriptor)
    } catch (error) {
      return resolve({ ok: false, version: '', detail: error.message, output: '', url: '' })
    }

    const scratch = options.dshHome ? null : makeScratchHome()
    const dshHome = options.dshHome || scratch

    const env = { ...plan.env }
    if (dshHome) env.DSH_HOME = dshHome

    // Port 0: the OS assigns a free one, so a probe can never collide with the user's
    // own running server or with another probe.
    const child = spawn(plan.cmd, [...plan.args, 'web', '--no-open', '--port', '0'], {
      cwd: plan.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    /** Set once the URL line appears; the server is then given a moment to prove itself. */
    let urlSeen = false
    let settleTimer = null

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (settleTimer) clearTimeout(settleTimer)
      stopTree(child)
      if (scratch) {
        // Give the process a moment to release the scratch profile before removing it.
        setTimeout(() => {
          try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ }
        }, 500).unref?.()
      }
      resolve(result)
    }

    const timer = setTimeout(() => {
      finish({
        ok: false,
        version: '',
        detail: `It did not start within ${Math.round(timeoutMs / 1000)}s.` + firstLines(stderr, 12),
        output: stdout + stderr,
        url: ''
      })
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (c) => {
      stdout += c
      if (urlSeen || !LAUNCH_URL_RE.test(stdout)) return

      // The URL line alone is not proof of health. `dsh web` prints it as soon as it is
      // listening, and a profile whose plugins cannot load can still get that far before
      // failing — so the server is given a moment to stay up. A process that is still
      // alive after this window (and has not written to stderr) is the real thing.
      urlSeen = true
      settleTimer = setTimeout(() => {
        finish({
          ok: !stderr.trim(),
          version: readVersion(descriptor),
          detail: stderr.trim()
            ? `It started, then reported a problem.\n${firstLines(meaningfulLines(stderr), 12)}`
            : '',
          output: stdout + stderr,
          url: ''
        })
      }, SETTLE_MS)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (c) => { stderr += c })

    child.on('error', (error) => {
      finish({
        ok: false,
        version: '',
        detail: `Could not start it: ${error.message}`,
        output: stdout + stderr,
        url: ''
      })
    })

    child.on('close', (code) => {
      // Reaching here means the URL line never appeared. The interesting part is why,
      // and for a broken plugin tree it is on stderr after a wall of "failed to import".
      const detail = code === 0
        ? 'It ran but never started a server.'
        : `It exited with code ${code} before the server was ready.`
      finish({
        ok: false,
        version: '',
        detail: `${detail}\n${firstLines(meaningfulLines(stderr || stdout), 12)}`,
        output: stdout + stderr,
        url: ''
      })
    })
  })
}

/** The launch line `dsh web` prints, matched here exactly as the server host matches it. */
const LAUNCH_URL_RE = /dsh web:\s*http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/

/**
 * How long a server must survive after printing its URL to count as working.
 *
 * Needed because the URL is printed as soon as the port is listening, which a profile
 * that is about to fail can still reach. This is a grace period, not a health check:
 * it costs a second once per candidate and removes the case where the shell declares an
 * installation fine and then dies on the splash screen.
 */
const SETTLE_MS = 1200

/**
 * Strip the lines that never explain a failure.
 *
 * A plugin tree that fails to load produces one "failed to import" line per plugin —
 * often a hundred of them — before the actual cause. Surfacing the tail after removing
 * those gives the user the reason rather than the symptom count.
 */
function meaningfulLines (text) {
  const lines = String(text || '').trim().split(/\r?\n/)
  const interesting = lines.filter((line) =>
    !/failed to import|did not activate/i.test(line) &&
    !/^\[[\d/]+\s/.test(line)   // Electron/Chromium's own timestamped stderr chatter
  )
  return (interesting.length ? interesting : lines).join('\n')
}

/** A throwaway DSH_HOME, or null when one cannot be made. */
function makeScratchHome () {
  try {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-probe-'))
  } catch {
    return null
  }
}

/** Kill a probe and anything it spawned. Mirrors ServerHost's platform handling. */
function stopTree (child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    try { child?.kill() } catch { /* already gone */ }
    return
  }
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 })
    } else {
      try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
      setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
      }, 2000).unref?.()
    }
  } catch { /* nothing left to kill */ }
  try { child.kill() } catch { /* already gone */ }
}

/** The installed version, read from whichever package.json sits above the entry. */
function readVersion (descriptor) {
  for (const file of [
    path.join(descriptor.root, 'package.json'),
    path.join(descriptor.root, 'apps', 'cli', 'package.json')
  ]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (pkg?.name === DSH_PACKAGE && pkg.version) return pkg.version
    } catch { /* try the next one */ }
  }
  return 'unknown'
}

function firstLines (text, n) {
  return String(text || '').trim().split(/\r?\n/).slice(0, n).map((l) => '  ' + l).join('\n') || '  (no output)'
}

/** True when this location is a dsh package entry, for reporting. */
function looksLikeDshEntry (p) {
  return isPackagedEntry(p)
}

module.exports = {
  locate,
  locateAll,
  hasCandidate,
  looksLikeInstall,
  resolveDshBin,
  validate,
  readVersion,
  explainUnusable,
  candidateLocations,
  checkoutCandidates,
  checkoutSearchDirs,
  pathDshCandidates,
  dshSearchDirs,
  npmGlobalRoot,
  looksLikeDshEntry
}
