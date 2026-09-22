#!/usr/bin/env node
'use strict'

/**
 * Tests for installation discovery and launch planning.
 *
 *   node build/test-locate.js
 *
 * These cover the logic that is pure enough to test without booting anything: how a
 * location is recognised, which command line it produces, and what happens when the
 * runtime is Electron rather than Node. The parts that need a real dsh (booting a
 * server, installing over npm) are verified by `verify-contract.js` instead.
 *
 * Exit code is non-zero on any failure.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { describeInstall, describeAll, spawnPlan } = require('../src/dsh-launch')
const { explainUnusable } = require('../src/dsh-locate')

let failures = 0
let checks = 0

function check (name, actual, expected) {
  checks++
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failures++
    console.log(`  [FAIL] ${name}`)
    console.log(`         expected: ${JSON.stringify(expected)}`)
    console.log(`         actual  : ${JSON.stringify(actual)}`)
  } else {
    console.log(`  [PASS] ${name}`)
  }
}

function checkThat (name, condition, detail = '') {
  checks++
  if (condition) {
    console.log(`  [PASS] ${name}`)
  } else {
    failures++
    console.log(`  [FAIL] ${name}${detail ? `\n         ${detail}` : ''}`)
  }
}

/** Build a throwaway checkout on disk. */
function makeCheckout (root, { built, tsx, tsconfig }) {
  fs.mkdirSync(path.join(root, 'apps', 'cli', 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'packages'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'apps', 'cli', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9-test', bin: { dsh: 'lib/bin.js' } })
  )
  fs.writeFileSync(path.join(root, 'apps', 'cli', 'src', 'bin.ts'), '// entry\n')
  if (built) {
    fs.mkdirSync(path.join(root, 'apps', 'cli', 'lib'), { recursive: true })
    fs.writeFileSync(path.join(root, 'apps', 'cli', 'lib', 'bin.js'), '// built\n')
  }
  if (tsx) {
    fs.mkdirSync(path.join(root, 'node_modules', 'tsx', 'dist', 'esm'), { recursive: true })
    fs.writeFileSync(path.join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs'), '// tsx\n')
  }
  if (tsconfig) fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}\n')
}

/** Build a throwaway packaged install. */
function makeInstall (modulesDir) {
  const pkg = path.join(modulesDir, '@deepseek-ai', 'dsh')
  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3', bin: { dsh: 'lib/bin.js' } }))
  fs.writeFileSync(path.join(pkg, 'lib', 'bin.js'), '// cli\n')
  return path.join(pkg, 'lib', 'bin.js')
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-locate-test-'))

try {
  console.log('== checkouts ==')

  // --- built checkout: the built entry wins, no loader ---
  {
    const root = path.join(tmp, 'built-checkout')
    makeCheckout(root, { built: true, tsx: true, tsconfig: true })
    const all = describeAll(root)
    check('a built checkout offers two launch shapes', all.map((d) => d.kind), ['packaged', 'source'])
    check('built entry is preferred', all[0].entry, path.join(root, 'apps', 'cli', 'lib', 'bin.js'))
    checkThat('built entry needs no loader', all[0].loader === null)
    checkThat('built entry is marked as coming from a checkout', all[0].fromCheckout === true)
    // Assert the *invariant*, not this machine's argv. A built entry is runnable by a
    // bare `node <entry>`, so the entry must be last and the only flag allowed in front
    // of it is --expose-internals, which appears when the bundled Electron runtime is
    // standing in for Node. Writing the expectation out in full would encode the ambient
    // runtime: a Windows CI runner has no `node` on PATH, so it legitimately takes that
    // path, while a macOS runner does not.
    const builtArgs = spawnPlan(all[0]).args
    check('the entry point is the last argument', builtArgs[builtArgs.length - 1], all[0].entry)
    check('a built entry carries no flag but the runtime-compat one',
      builtArgs.slice(0, -1).filter((arg) => arg !== '--expose-internals'), [])
  }

  // --- unbuilt checkout with dependencies: source via tsx ---
  {
    const root = path.join(tmp, 'source-checkout')
    makeCheckout(root, { built: false, tsx: true, tsconfig: true })
    const all = describeAll(root)
    check('an unbuilt checkout offers only the source shape', all.map((d) => d.kind), ['source'])
    const plan = spawnPlan(all[0])
    // Built with path.join, not a literal: on Windows the separator is a backslash, and
    // a hardcoded 'apps/cli/src/bin.ts' would fail there for a reason that has nothing
    // to do with the code under test.
    checkThat('source entry is the .ts file',
      all[0].entry === path.join(root, 'apps', 'cli', 'src', 'bin.ts'), all[0].entry)
    check('source entry passes --import <tsx>', plan.args.slice(0, 1), ['--import'])
    checkThat('the tsx loader is an absolute file URL', /^file:\/\/.*index\.mjs$/.test(plan.args[1]), plan.args[1])
    check('TSX_TSCONFIG_PATH points at the checkout tsconfig', plan.env.TSX_TSCONFIG_PATH, path.join(root, 'tsconfig.json'))
    check('source entry sets cwd to the checkout', plan.cwd, root)
  }

  // --- unbuilt checkout without dependencies: not runnable, but explained ---
  {
    const root = path.join(tmp, 'naked-checkout')
    makeCheckout(root, { built: false, tsx: false, tsconfig: false })
    check('an unbuilt checkout with no tsx is not launchable', describeAll(root), [])
    const why = explainUnusable(root)
    checkThat('the explanation names pnpm install', /pnpm install/.test(why), why)
    checkThat('the explanation names pnpm run build', /pnpm run build/.test(why), why)
    checkThat('the explanation names the folder', why.includes(root), why)
  }

  // --- a directory that is not dsh at all ---
  {
    const plain = path.join(tmp, 'not-dsh')
    fs.mkdirSync(plain, { recursive: true })
    check('an unrelated directory is not an installation', describeInstall(plain), null)
    checkThat('and is explained as not found', /No dsh installation/.test(explainUnusable(plain)))
  }

  // --- paths that do not exist / are files ---
  check('a missing path is not an installation', describeInstall(path.join(tmp, 'nope')), null)
  checkThat('a missing path is explained', /Nothing exists/.test(explainUnusable(path.join(tmp, 'nope'))))
  {
    const file = path.join(tmp, 'random.txt')
    fs.writeFileSync(file, 'not dsh\n')
    check('an unrelated file is not an installation', describeInstall(file), null)
    checkThat('an unrelated file is explained', /not a dsh entry point/.test(explainUnusable(file)))
  }

  console.log('')
  console.log('== npm layouts ==')

  // All three prefix layouts npm produces must resolve. Getting this wrong looks
  // exactly like a failed install, so it is worth pinning down.
  {
    const posixGlobal = path.join(tmp, 'posix-global', 'lib', 'node_modules')
    const entry = makeInstall(posixGlobal)
    check('a POSIX global prefix resolves via lib/node_modules',
      describeInstall(path.join(tmp, 'posix-global'))?.entry, entry)
    check('the module directory itself also resolves', describeInstall(posixGlobal)?.entry, entry)

    const prefixed = path.join(tmp, 'prefixed', 'node_modules')
    const entry2 = makeInstall(prefixed)
    check('an `npm install --prefix` layout resolves via node_modules',
      describeInstall(path.join(tmp, 'prefixed'))?.entry, entry2)

    check('the package directory itself resolves', describeInstall(path.dirname(path.dirname(entry2)))?.entry, entry2)
  }

  console.log('')
  console.log('== runtime planning ==')

  {
    const root = path.join(tmp, 'runtime-checkout')
    makeCheckout(root, { built: true, tsx: false, tsconfig: false })
    const descriptor = describeInstall(root)
    const plan = spawnPlan(descriptor)
    check('the runtime is an absolute path', path.isAbsolute(plan.cmd), true)
    checkThat('ELECTRON_NO_ATTACH_CONSOLE is not inherited', plan.env.ELECTRON_NO_ATTACH_CONSOLE === undefined)
    check('NO_COLOR is set', plan.env.NO_COLOR, '1')
  }

  // Both runtime branches are asserted explicitly, with the runtime injected, so the
  // outcome does not depend on whether the machine running the tests has a system Node.
  // Testing only the ambient runtime is what let a Windows CI failure through: the
  // runner has no Node on PATH, so it takes the Electron path, which was untested here.
  {
    const root = path.join(tmp, 'runtime-branches')
    makeCheckout(root, { built: true, tsx: false, tsconfig: false })
    const descriptor = describeInstall(root)

    const plain = spawnPlan(descriptor, { runtime: { cmd: 'node', needsRunAsNode: false } })
    check('plain Node runs `node <entry>`', plain.args, [descriptor.entry])
    checkThat('plain Node does not need --expose-internals', !plain.args.includes('--expose-internals'))
    checkThat('plain Node is not told ELECTRON_RUN_AS_NODE', plain.env.ELECTRON_RUN_AS_NODE === undefined)

    const electron = spawnPlan(descriptor, { runtime: { cmd: '/path/to/Electron', needsRunAsNode: true } })
    check('Electron as Node still ends with the entry point', electron.args[electron.args.length - 1], descriptor.entry)
    check('Electron as Node is told to expose internals', electron.args.includes('--expose-internals'), true)
    check('ELECTRON_RUN_AS_NODE is set for Electron', electron.env.ELECTRON_RUN_AS_NODE, '1')

    // The same branch must compose with a loader: a source checkout launched by
    // Electron has to carry --import *and* --expose-internals, with the entry last.
    const sourceRoot = path.join(tmp, 'runtime-source')
    makeCheckout(sourceRoot, { built: false, tsx: true, tsconfig: true })
    const sourceDescriptor = describeAll(sourceRoot)[0]
    const loaderPlan = spawnPlan(sourceDescriptor, { runtime: { cmd: '/path/to/Electron', needsRunAsNode: true } })
    check('a source entry under Electron keeps the entry last',
      loaderPlan.args[loaderPlan.args.length - 1], sourceDescriptor.entry)
    checkThat('a source entry under Electron keeps --import',
      loaderPlan.args[0] === '--import' && /index\.mjs$/.test(loaderPlan.args[1]), loaderPlan.args.slice(0, 2).join(' '))
    check('a source entry under Electron keeps --expose-internals',
      loaderPlan.args.includes('--expose-internals'), true)
  }

  {
    // A packaged install must never inherit a stale TSX_TSCONFIG_PATH: it would send
    // tsx looking for a tsconfig that has nothing to do with this installation.
    const modulesDir = path.join(tmp, 'stale-env', 'node_modules')
    makeInstall(modulesDir)
    const previous = process.env.TSX_TSCONFIG_PATH
    process.env.TSX_TSCONFIG_PATH = '/somewhere/else/tsconfig.json'
    const plan = spawnPlan(describeInstall(path.join(tmp, 'stale-env')))
    if (previous === undefined) delete process.env.TSX_TSCONFIG_PATH
    else process.env.TSX_TSCONFIG_PATH = previous
    checkThat('a packaged install drops TSX_TSCONFIG_PATH', plan.env.TSX_TSCONFIG_PATH === undefined)
    check('a packaged install needs no cwd', plan.cwd, undefined)
  }

  checkThat('spawnPlan rejects a missing descriptor', (() => {
    try { spawnPlan(null); return false } catch { return true }
  })())
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('')
console.log('======================================================')
if (failures === 0) {
  console.log(`RESULT: all ${checks} checks passed`)
  process.exitCode = 0
} else {
  console.log(`RESULT: ${failures} of ${checks} checks FAILED`)
  process.exitCode = 1
}
