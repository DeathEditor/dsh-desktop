#!/usr/bin/env node
'use strict'

/**
 * Contract verifier — run this after upgrading dsh.
 *
 *   node build/verify-contract.js                 # verify the installed dsh
 *   node build/verify-contract.js --bin <path>    # verify any other installation
 *
 * The shell depends on three things that are internal to dsh rather than public API:
 *
 *   1. the CLI entry point is at <npm-root>/@deepseek-ai/dsh/lib/bin.js
 *   2. `dsh web` accepts --no-open and --port
 *   3. it prints  "dsh web: http://127.0.0.1:PORT/?token=..."  on stdout
 *
 * (3) is the fragile one: if upstream ever changes that line, the shell would
 * otherwise hang on the splash screen with no explanation. This script boots a real
 * server under a throwaway DSH_HOME, applies the EXACT regex the shell uses, and
 * confirms the URL actually authenticates. Exit code is non-zero on any failure.
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { LAUNCH_URL_RE, resolveDshBin, resolveNode } = require('../src/server-host')

const argv = process.argv.slice(2)
const binFlag = argv.indexOf('--bin')
const explicitBin = binFlag !== -1 ? argv[binFlag + 1] : undefined
const TIMEOUT_MS = 240000

const results = []
function record (name, ok, detail = '') {
  results.push({ name, ok, detail })
}

async function main () {
  const bin = resolveDshBin(explicitBin)
  const node = resolveNode()
  let version = 'unknown'
  if (bin) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(bin), '..', 'package.json'), 'utf8'))
      version = pkg.version || 'unknown'
    } catch { /* reported below */ }
  }

  console.log(`dsh entry  : ${bin || '(not found)'}`)
  console.log(`dsh version: ${version}`)
  console.log(`node       : ${node.cmd}${node.needsRunAsNode ? ' (Electron as Node)' : ''}`)
  console.log('')

  record('CLI entry point found at the expected path', !!bin, bin || 'run: npm install -g @deepseek-ai/dsh')
  if (!bin) return report()

  // --- flags the shell passes must still be accepted ---
  const help = await run(node, [bin, 'web', '--help'])
  record('`dsh web` accepts --no-open', /--no-open/.test(help.stdout + help.stderr))
  record('`dsh web` accepts --port', /--port/.test(help.stdout + help.stderr))

  // --- boot a real server under a throwaway DSH_HOME ---
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-contract-'))
  console.log(`booting under throwaway DSH_HOME: ${tempHome}`)
  console.log('(first run may take a moment while the profile is created)')

  let url = null
  let stderr = ''
  // Mirror the shell's own spawn: same runtime, same env handling.
  const childEnv = { ...process.env, DSH_HOME: tempHome, NO_COLOR: '1' }
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE
  if (node.needsRunAsNode) childEnv.ELECTRON_RUN_AS_NODE = '1'
  else delete childEnv.ELECTRON_RUN_AS_NODE

  const child = spawn(node.cmd, [bin, 'web', '--no-open', '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: childEnv
  })

  try {
    url = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), TIMEOUT_MS)
      let buffer = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        buffer += chunk
        const m = LAUNCH_URL_RE.exec(buffer)
        if (m) { clearTimeout(timer); resolve(m[1]) }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (c) => { stderr += c })
      child.on('exit', () => { clearTimeout(timer); resolve(null) })
      child.on('error', () => { clearTimeout(timer); resolve(null) })
    })

    record('prints a URL matching the shell\'s regex', !!url, url || `not seen within ${TIMEOUT_MS / 1000}s`)
    record('token query parameter is named "token"', !!url && /\?token=[^&\s]+/.test(url))

    if (url) {
      // Mirror what a browser does, step by step. Node's fetch has NO cookie jar, so
      // it cannot simply follow the redirect: the token URL responds 302 with a
      // Set-Cookie, and only a request that carries that cookie back gets the UI.
      // Doing both steps explicitly is also a stronger check than a single 200.
      try {
        const first = await fetch(url, { redirect: 'manual' })
        const setCookie = first.headers.get('set-cookie') || ''
        const isRedirect = first.status >= 300 && first.status < 400
        const hasCookie = /dsh-auth-[^=]*=[^;]+/.test(setCookie)

        record('token URL mints a session cookie (302 + Set-Cookie)', isRedirect && hasCookie,
          `HTTP ${first.status}${hasCookie ? ', cookie issued' : ', NO cookie'}`)

        if (hasCookie) {
          // Replay the cookie against the clean root, exactly as the browser lands there.
          const cookie = setCookie.split(';')[0]
          const second = await fetch(new URL('/', url).href, {
            redirect: 'manual',
            headers: { cookie }
          })
          const body = await second.text()
          record('cookie authenticates the UI (HTTP 200)', second.status === 200,
            `HTTP ${second.status}, ${body.length} bytes`)
        } else {
          record('cookie authenticates the UI (HTTP 200)', false, 'skipped: no cookie issued')
        }
      } catch (error) {
        record('token URL mints a session cookie (302 + Set-Cookie)', false, error.message)
        record('cookie authenticates the UI (HTTP 200)', false, 'skipped: request failed')
      }
    } else {
      record('token URL mints a session cookie (302 + Set-Cookie)', false, 'skipped: no URL captured')
      record('cookie authenticates the UI (HTTP 200)', false, 'skipped: no URL captured')
    }
  } finally {
    try { child.kill() } catch { /* already gone */ }
    if (process.platform === 'win32' && child.pid) {
      try {
        require('node:child_process').spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      } catch { /* ignore */ }
    }
    // Give the OS a moment to release the port before cleaning the directory.
    await new Promise((r) => setTimeout(r, 500))
    try { fs.rmSync(tempHome, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  if (!results.every((r) => r.ok)) {
    console.log('')
    console.log('Captured stderr (last 25 lines):')
    console.log(stderr.trim().split(/\r?\n/).slice(-25).map((l) => '  ' + l).join('\n') || '  (empty)')
  }

  return report(version)
}

function report (version = '') {
  console.log('')
  console.log('================ compatibility report ================')
  for (const r of results) {
    console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.name}`)
    if (r.detail) console.log(`         ${r.detail}`)
  }
  console.log('======================================================')
  const ok = results.every((r) => r.ok)
  if (ok) {
    console.log(`RESULT: the desktop shell is compatible with dsh ${version}`)
    process.exitCode = 0
  } else {
    console.log(`RESULT: INCOMPATIBLE with dsh ${version} - the shell needs updating.`)
    console.log('The fragile contract is the "dsh web: <url>" line; check')
    console.log('LAUNCH_URL_RE in src/server-host.js against the output above.')
    process.exitCode = 1
  }
}

/** Run a command to completion, capturing stdout/stderr. */
function run (cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (c) => { stdout += c })
    child.stderr?.on('data', (c) => { stderr += c })
    child.on('close', () => resolve({ stdout, stderr }))
    child.on('error', (e) => resolve({ stdout, stderr: String(e.message) }))
  })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
