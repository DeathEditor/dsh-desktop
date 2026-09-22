'use strict'

/**
 * What to actually execute in order to run the dsh CLI, and how to execute it.
 *
 * There are two shapes of installation in the wild, and they are launched very
 * differently:
 *
 *   1. **Packaged** — an npm install of `@deepseek-ai/dsh`, whose entry point is
 *      `<prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js`. Plain JavaScript, so
 *      `node <entry>` is the whole command.
 *
 *   2. **Source checkout** — a clone of deepseek-harness. Its CLI is TypeScript
 *      (`apps/cli/src/bin.ts`) and it resolves its ~90 workspace packages through
 *      tsconfig `paths`, so plain node cannot run it: it needs the tsx loader plus
 *      an explicit tsconfig. A checkout that has been built also carries a packaged
 *      entry at `apps/cli/lib/bin.js`, which is preferred because it starts faster
 *      and needs no tsx at all.
 *
 * A descriptor is a plain object describing one of those, already validated to exist
 * on disk. `spawnPlan()` turns it into the (cmd, args, env, cwd) a spawn needs, so the
 * server and the setup screen agree on exactly one launch recipe.
 */

const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { resolveNode, isFile, isDir } = require('./node-runtime')

/** The package name a real installation always carries. */
const DSH_PACKAGE = '@deepseek-ai/dsh'

/** npm prefixes to probe when the caller has no better idea (used by discovery). */
function isPackagedEntry (p) {
  return !!p && /[\\/]lib[\\/]bin\.js$/.test(p)
}

function isSourceEntry (p) {
  return !!p && /[\\/]bin\.ts$/.test(p)
}

/**
 * Describe a candidate installation.
 *
 * Accepts anything a user might point at — a `.js` entry, a package directory, an npm
 * prefix, a checkout root, or a checkout's `apps/cli` — and returns a descriptor, or
 * null when the location does not look like dsh at all.
 *
 * @param {string} location file or directory
 * @returns {object|null}
 */
function describeInstall (location) {
  return describeAll(location)[0] || null
}

/**
 * Every way this location could be launched, best first.
 *
 * A checkout legitimately offers two: its build output, and the TypeScript sources via
 * tsx. The built entry is preferred — it needs no loader and starts faster — but a
 * half-finished build can leave one that runs and fails, so the caller may try the next
 * candidate rather than giving up on the folder.
 *
 * @param {string} location
 * @returns {object[]} descriptors, possibly empty
 */
function describeAll (location) {
  if (!location) return []
  const resolved = path.resolve(location)

  if (isFile(resolved)) {
    // A file: trust it only when its name/shape says it is a dsh entry point.
    if (isSourceEntry(resolved)) {
      const root = checkoutRootFor(path.dirname(path.dirname(path.dirname(resolved))))
      return root ? [sourceDescriptor(root)].filter(Boolean) : []
    }
    if (isPackagedEntry(resolved)) return [packagedDescriptor(resolved)]
    return []
  }

  if (!isDir(resolved)) return []

  // 1. A checkout root or a directory inside one.
  const checkout = checkoutRootFor(resolved)
  if (checkout) return checkoutDescriptors(checkout)

  // 2. The dsh package directory itself: <prefix>/node_modules/@deepseek-ai/dsh
  const own = readJson(path.join(resolved, 'package.json'))
  if (own?.name === DSH_PACKAGE) {
    const entry = binEntryFrom(own, resolved)
    if (entry) return [packagedDescriptor(entry)]
  }

  // 3. An npm prefix or a module directory. Both layouts occur: `npm install --prefix X`
  //    produces X/node_modules, while a POSIX global prefix keeps its modules under
  //    X/lib/node_modules. Checking both means a user can point at either the prefix
  //    `npm root -g` reports or the parent of a node_modules directory.
  for (const modulesDir of [
    resolved,
    path.join(resolved, 'node_modules'),
    path.join(resolved, 'lib', 'node_modules')
  ]) {
    const nested = path.join(modulesDir, ...DSH_PACKAGE.split('/'))
    const nestedPkg = readJson(path.join(nested, 'package.json'))
    if (nestedPkg?.name !== DSH_PACKAGE) continue
    const entry = binEntryFrom(nestedPkg, nested)
    if (entry) return [packagedDescriptor(entry)]
  }

  return []
}

/**
 * A checkout is recognised by its CLI package, not by a root marker: the root is a
 * private solution package whose name has changed before, while apps/cli/package.json
 * carries the published `bin` mapping that actually matters.
 */
function checkoutRootFor (dir) {
  const candidates = [
    dir,
    path.join(dir, 'apps', 'cli'),
    path.resolve(dir, '..'),
    path.resolve(dir, '..', '..')
  ]
  for (const candidate of candidates) {
    const cliPkg = path.join(candidate, 'apps', 'cli', 'package.json')
    if (readJson(cliPkg)?.name === DSH_PACKAGE && isDir(path.join(candidate, 'packages'))) {
      return candidate
    }
  }
  return null
}

/** Prefer the built entry, then the TypeScript source, for a checkout. */
function checkoutDescriptors (root) {
  const built = path.join(root, 'apps', 'cli', 'lib', 'bin.js')
  const source = sourceDescriptor(root)
  const descriptors = []
  if (isFile(built)) descriptors.push({ ...packagedDescriptor(built), checkoutRoot: root, fromCheckout: true })
  if (source) descriptors.push(source)
  return descriptors
}

/** The single best descriptor for a checkout, or null. */
function checkoutDescriptor (root) {
  return checkoutDescriptors(root)[0] || null
}

/**
 * The TypeScript path. Only usable when the checkout has installed tsx and has a
 * tsconfig carrying the workspace aliases; otherwise the caller must fall back to
 * telling the user to build, because there is no way to run this source.
 */
function sourceDescriptor (root) {
  const entry = path.join(root, 'apps', 'cli', 'src', 'bin.ts')
  if (!isFile(entry)) return null

  const loader = path.join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
  const tsconfig = ['tsconfig.json', 'tsconfig.base.json']
    .map((name) => path.join(root, name))
    .find(isFile)

  if (!isFile(loader) || !tsconfig) return null

  return {
    kind: 'source',
    entry,
    loader,
    tsconfigPath: tsconfig,
    cwd: root,
    root,
    checkoutRoot: root,
    fromCheckout: true,
    /** Shown to the user, and recorded in settings.json. */
    display: entry
  }
}

function packagedDescriptor (entry) {
  const root = path.dirname(path.dirname(entry))
  return {
    kind: 'packaged',
    entry,
    loader: null,
    tsconfigPath: null,
    cwd: null,
    root,
    fromCheckout: false,
    display: entry
  }
}

/** Resolve a package.json `bin` mapping to a real file, tolerating the string form. */
function binEntryFrom (pkg, dir) {
  const bin = pkg.bin
  const rel = typeof bin === 'string' ? bin : bin?.dsh
  if (!rel) return null
  const entry = path.resolve(dir, rel)
  return isFile(entry) ? entry : null
}

function readJson (file) {
  try {
    return JSON.parse(require('node:fs').readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Build the command line for a descriptor.
 *
 * @param {object} descriptor from describeInstall()
 * @returns {{cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string|undefined,
 *            needsRunAsNode: boolean}}
 */
function spawnPlan (descriptor) {
  if (!descriptor || !descriptor.entry) throw new Error('no dsh installation to launch')

  const node = resolveNode()
  const env = { ...process.env, NO_COLOR: '1' }

  // Inherited from Electron and meaningless (or harmful) for a plain Node child --
  // except when that child IS Electron, used as a Node runtime fallback.
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  if (node.needsRunAsNode) env.ELECTRON_RUN_AS_NODE = '1'
  else delete env.ELECTRON_RUN_AS_NODE

  const args = []
  if (descriptor.loader) {
    args.push('--import', pathToFileURL(descriptor.loader).href)
    // tsx otherwise looks for a tsconfig next to the *working directory*, which for a
    // GUI-launched app is nothing like the checkout. Without this the workspace
    // aliases do not resolve and the CLI dies on its first bare import.
    if (descriptor.tsconfigPath) env.TSX_TSCONFIG_PATH = descriptor.tsconfigPath
  } else {
    delete env.TSX_TSCONFIG_PATH
  }

  // Electron's Node needs this flag or dsh's HMR plugin cannot load ("--expose-internals
  // is required for HMR service"), which fails the whole profile. Plain Node always
  // exposes internals, so the flag is unnecessary there and is only added for Electron.
  // It must be a real argv entry: NODE_OPTIONS rejects this particular flag.
  if (node.needsRunAsNode) args.push('--expose-internals')

  args.push(descriptor.entry)

  return {
    cmd: node.cmd,
    args,
    env,
    cwd: descriptor.cwd || undefined,
    needsRunAsNode: node.needsRunAsNode
  }
}

/** A one-line human description of how this installation will be launched. */
function describeLaunch (descriptor) {
  if (!descriptor) return 'not found'
  const plan = spawnPlan(descriptor)
  return [plan.cmd, ...plan.args].join(' ')
}

module.exports = {
  describeInstall,
  describeAll,
  checkoutRootFor,
  checkoutDescriptor,
  checkoutDescriptors,
  spawnPlan,
  describeLaunch,
  isPackagedEntry,
  isSourceEntry,
  DSH_PACKAGE
}
