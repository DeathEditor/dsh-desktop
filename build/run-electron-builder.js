'use strict'

/**
 * `npm run dist` / `npm run pack` — electron-builder plus the one argument that
 * package.json cannot express on its own.
 *
 * Why this wrapper exists. With no Developer ID certificate in the keychain and no
 * CSC_LINK, electron-builder does NOT fall back to ad-hoc signing: it logs a warning
 * and skips signing entirely. `MacTargetHelper.findSigningIdentity()` only enters the
 * ad-hoc branch on `if (qualifier === "-")`; with `identity` unset it takes the
 * `noIdentity` branch instead, where `reportError()` merely logs and returns null. The
 * build reports success and ships an UNSEALED bundle — which macOS shows the user as
 * "the app is damaged and can't be opened", and which `codesign --verify --deep
 * --strict` rejects with "code has no resources but signature indicates they must be
 * present". The CI workflow already compensates; this keeps the local scripts honest
 * about it too.
 *
 * The override is added on macOS only, and only when nothing else can sign. It is NOT
 * safe to pass unconditionally: `identity: "-"` BEATS a configured certificate, because
 * findSigningIdentity() matches the qualifier against the keychain (nothing there is
 * named "-"), gets null, and then forces the ad-hoc identity regardless. So a real
 * certificate has to keep the flag off — the CI workflow makes the same call, for the
 * same reason.
 */

const { spawnSync } = require('node:child_process')

const args = process.argv.slice(2)

// Either of these means "an identity is configured", and the flag would override it.
const hasCertificate = ['CSC_LINK', 'CSC_NAME'].some((name) => (process.env[name] || '').trim() !== '')

if (process.platform === 'darwin' && !hasCertificate) {
  args.push('--config.mac.identity=-')
}

// Resolve the CLI instead of relying on node_modules/.bin: on Windows the launcher
// there is a .cmd shim, and spawning it would need a shell.
const cli = require.resolve('electron-builder/cli.js')
const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' })

if (result.error) throw result.error
process.exit(result.status ?? 1)
