'use strict'

/**
 * One-click installation of the dsh CLI.
 *
 * The app cannot ship the CLI inside itself — dsh is a package tree of ~90 workspace
 * packages that the user is expected to be able to upgrade, plugin-manage and run from
 * a terminal — so "install" means running npm on the user's behalf.
 *
 * Two targets, tried in this order:
 *
 *   1. **The user's global npm prefix.** This is what `npm install -g @deepseek-ai/dsh`
 *      does by hand, and it has the side benefit that `dsh` afterwards works in the
 *      user's own terminal. It is the default because it is the documented install.
 *
 *   2. **A private prefix inside the app's data directory.** Global installs need write
 *      access to the npm prefix, which a system Node (/usr/local, Program Files) does
 *      not grant without sudo. Rather than fail there — or ask for a password — fall
 *      back to a prefix the user already owns. Nothing outside the app's own directory
 *      is touched, and deleting that directory uninstalls it.
 *
 * Everything is streamed: an install pulls hundreds of packages and can take minutes,
 * so the caller gets progress lines instead of a frozen window.
 */

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const { describeInstall, DSH_PACKAGE } = require('./dsh-launch')
const { resolveNode, isFile } = require('./node-runtime')

/** npm's own noise, dropped so the progress log stays readable. */
const NOISE_RE = new RegExp(
  '^\\s*(' +
  'npm notice|' +
  'npm warn deprecated|' +
  'added \\d+ packages|' +
  'audited \\d+ packages|' +
  // The pointer to npm's own debug log: meaningless to the user, and it is printed for
  // failures whose actual reason we surface ourselves.
  'npm error A complete log of this run|' +
  'npm error$' +
  ')', 'i')

/** Failures that mean "this prefix is not writable", not "the install is broken". */
const PERMISSION_RE = /(EACCES|EPERM|EROFS|permission denied|not permitted|access is denied|operation not permitted)/i

/**
 * Find npm to drive the install with.
 *
 * Preferred form is `node <npm-cli.js>` rather than the `npm` shim: it needs no shell,
 * which keeps arguments safe on Windows where npm is a `.cmd` batch file.
 *
 * @returns {{cmd: string, prefixArgs: string[], display: string, via: string}|null}
 */
function resolveNpm () {
  const node = resolveNode()
  const nodeDir = path.dirname(node.cmd)
  const isWin = process.platform === 'win32'

  // 1. npm shipped alongside the Node we are going to use. This is the same toolchain,
  //    so its prefix is the one dsh should be installed into.
  const cliCandidates = []
  if (isWin) {
    cliCandidates.push(path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  } else {
    // npm may be a symlink (<prefix>/bin/npm -> ../lib/node_modules/npm/bin/npm-cli.js),
    // so resolve through the real binary before walking up to lib/.
    const realNode = fs.existsSync(node.cmd) ? fs.realpathSync(node.cmd) : node.cmd
    const realNodeDir = path.dirname(realNode)
    cliCandidates.push(path.join(realNodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    cliCandidates.push(path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  }
  for (const cli of cliCandidates) {
    if (isFile(cli)) {
      return { cmd: node.cmd, prefixArgs: [cli], display: `${node.cmd} ${cli}`, via: 'bundled-with-node' }
    }
  }

  // 2. Whatever npm the user's shell would run.
  const which = spawnSync(isWin ? 'where' : 'which', [isWin ? 'npm.cmd' : 'npm'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: isWin
  })
  if (which.status === 0) {
    const first = String(which.stdout || '').trim().split(/\r?\n/)[0]
    if (first && isFile(first)) {
      // A Windows .cmd shim needs a shell; a POSIX shim is a script with a shebang.
      return isWin
        ? { cmd: first, prefixArgs: [], display: first, via: 'PATH', shell: true }
        : { cmd: first, prefixArgs: [], display: first, via: 'PATH' }
    }
  }

  return null
}

/**
 * Install dsh.
 *
 * @param {object} options
 * @param {string} options.fallbackPrefix directory to use when the global prefix is
 *   not writable (normally <userData>/cli)
 * @param {(line: string) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok: boolean, descriptor?: object, target?: string, prefix?: string,
 *                    log?: string, error?: string, code?: string}>}
 */
async function install (options = {}) {
  const { fallbackPrefix, onProgress = () => {}, signal } = options

  const npm = resolveNpm()
  if (!npm) {
    return {
      ok: false,
      code: 'no-npm',
      error:
        'npm was not found, so the CLI cannot be installed automatically.\n\n' +
        'Install Node.js (which includes npm) from https://nodejs.org, then try again — ' +
        'or choose an existing DeepSeek Harness folder instead.'
    }
  }

  const log = []
  const say = (line) => {
    const text = String(line).replace(/\r$/, '')
    log.push(text)
    onProgress(text)
  }

  say(`Using npm: ${npm.display}`)
  say(`Installing ${DSH_PACKAGE} (this downloads a few hundred packages; it can take a few minutes)`)

  const globalRun = await runNpm(npm, ['install', '-g', '--no-audit', '--no-fund', '--progress=false', DSH_PACKAGE], { signal, say })

  if (globalRun.ok) {
    const root = npmGlobalRoot(npm)
    const descriptor = root ? findInstalled(root, say) : null
    if (descriptor) return { ok: true, descriptor, target: 'global', prefix: root, log: log.join('\n') }
    say('npm reported success, but no usable dsh entry point appeared — falling back to a private install.')
  } else if (globalRun.aborted) {
    return { ok: false, code: 'cancelled', error: 'Installation cancelled.', log: log.join('\n') }
  } else if (!PERMISSION_RE.test(globalRun.output)) {
    // Not a permissions problem: a private install would fail the same way, so report
    // npm's own output rather than burning another few minutes.
    return {
      ok: false,
      code: 'npm-failed',
      error: `npm could not install ${DSH_PACKAGE}.\n\n${tail(globalRun.output, 15)}`,
      log: log.join('\n')
    }
  } else {
    say('')
    say('The global npm prefix is not writable by this user (this is normal for a ' +
      'system-wide Node and would need sudo).')
    say('Installing into the app\'s own folder instead — no administrator password needed.')
  }

  // --- private prefix (also the path taken by any non-permission global failure) ---
  if (!fallbackPrefix) {
    return {
      ok: false,
      code: 'no-fallback',
      error: 'The global install failed and no private install location is configured.\n\n' +
        tail(globalRun.output, 12),
      log: log.join('\n')
    }
  }

  try {
    fs.mkdirSync(fallbackPrefix, { recursive: true })
  } catch (error) {
    return { ok: false, code: 'no-fallback', error: `Could not create ${fallbackPrefix}: ${error.message}`, log: log.join('\n') }
  }

  say(`Installing into ${fallbackPrefix}`)
  const privateRun = await runNpm(npm, ['install', '--prefix', fallbackPrefix, '--no-audit', '--no-fund', '--progress=false', DSH_PACKAGE], { signal, say })

  if (privateRun.aborted) {
    return { ok: false, code: 'cancelled', error: 'Installation cancelled.', log: log.join('\n') }
  }

  const descriptor = findInstalled(path.join(fallbackPrefix, 'node_modules'), say)
  if (privateRun.ok && descriptor) {
    return { ok: true, descriptor, target: 'private', prefix: fallbackPrefix, log: log.join('\n') }
  }

  return {
    ok: false,
    code: 'npm-failed',
    error:
      `npm could not install ${DSH_PACKAGE}.\n\n` +
      tail(privateRun.output || globalRun.output, 15),
    log: log.join('\n')
  }
}

/**
 * Look for the installed package under a `node_modules` directory.
 *
 * The caller must pass the module directory itself, not an npm prefix: npm has several
 * prefix-to-modules mappings (`<prefix>/node_modules` for `--prefix`, but
 * `<prefix>/lib/node_modules` for a POSIX global prefix and `<prefix>/node_modules` on
 * Windows), and getting that wrong looks exactly like a failed install.
 */
function findInstalled (modulesDir, say) {
  if (!modulesDir) return null
  const descriptor = describeInstall(path.join(modulesDir, ...DSH_PACKAGE.split('/')))
  if (descriptor) {
    say(`Installed: ${descriptor.entry}`)
    return descriptor
  }
  return null
}

/**
 * The global prefix for the *same* npm that just ran, so the entry point is looked for
 * where that npm would have put it rather than where a different npm would.
 */
function npmGlobalRoot (npm) {
  const isWin = process.platform === 'win32'
  const out = spawnSync(npm.cmd, [...npm.prefixArgs, 'root', '-g'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    shell: npm.shell || isWin
  })
  if (out.status !== 0) return null
  const root = String(out.stdout || '').trim().split(/\r?\n/).pop()
  return root && fs.existsSync(root) ? root : null
}

/**
 * Run one npm command, streaming its output.
 *
 * @returns {Promise<{ok: boolean, output: string, aborted: boolean}>}
 */
function runNpm (npm, args, { signal, say }) {
  return new Promise((resolve) => {
    const child = spawn(npm.cmd, [...npm.prefixArgs, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: npm.shell || false,
      env: { ...process.env, NO_COLOR: '1', npm_config_color: 'false' }
    })

    let output = ''
    let aborted = false

    const onAbort = () => {
      aborted = true
      try { child.kill() } catch { /* already gone */ }
      if (process.platform !== 'win32' && child.pid) {
        try { spawnSync('pkill', ['-TERM', '-P', String(child.pid)], { windowsHide: true }) } catch { /* best effort */ }
      }
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    const consume = (chunk) => {
      output += chunk
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim() || NOISE_RE.test(line)) continue
        say(line)
      }
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)

    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      resolve({ ok: false, output: `${output}\n${error.message}`, aborted })
    })

    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      resolve({ ok: code === 0 && !aborted, output, aborted })
    })
  })
}

/** Last few lines of noisy command output, indented. */
function tail (text, lines) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return '  (no output)'
  return trimmed.split(/\r?\n/).slice(-lines).map((l) => '  ' + l).join('\n')
}

/** The private prefix this app should install into. */
function defaultFallbackPrefix (userDataPath) {
  return path.join(userDataPath, 'cli')
}

/** True when Node/npm are present at all, for the setup screen's messaging. */
function npmAvailable () {
  return !!resolveNpm()
}

module.exports = {
  install,
  resolveNpm,
  npmAvailable,
  defaultFallbackPrefix
}
