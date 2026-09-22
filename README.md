# DeepSeek Harness — Desktop Shell

A cross-platform desktop shell for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
web GUI: one click to launch, no console window, and everything stops when you close
the window.

Runs on **Windows and macOS** from one codebase (Electron). The code is written
portably and the Linux paths are implemented, but no Linux package is built or
tested — see [Platform support](#platform-support).

| | |
| --- | --- |
| One-click launch | packaged `.exe` / `.dmg` |
| No console window | GUI subsystem — nothing to hide |
| Close the window | server stops, port is freed, no orphan processes |
| UI engine | Chromium — identical rendering to the browser target |

---

## Download

Builds are produced by GitHub Actions. Either:

* **[Releases](../../releases)** — tagged builds (`v*`) are attached automatically, or
* **Actions → Build desktop app → (latest run) → Artifacts** — per-platform bundles.

| Platform | File |
| --- | --- |
| Windows | `DeepSeek Harness Setup x.y.z.exe` (installer) or the portable `.exe` |
| macOS (Apple Silicon) | `…-arm64.dmg` |
| macOS (Intel) | `…-x64.dmg` |

### First launch on macOS

The builds are **ad-hoc signed** (no Apple Developer certificate), so Gatekeeper
blocks the first open. Two ways in:

* right-click the app → **Open** → **Open** again, or
* remove the quarantine flag:

```bash
xattr -dr com.apple.quarantine "/Applications/DeepSeek Harness.app"
```

If macOS instead says **"the app is damaged and can't be opened"**, that is a
*different* failure, and right-click → Open will not help: it means the bundle is not
sealed correctly rather than merely untrusted. See
[macOS signing](#macos-signing-why-the-app-must-be-sealed) for the cause. Builds from
this repo carry a valid ad-hoc signature, and CI verifies it before publishing.

### Prerequisite on every platform

The shell drives the `dsh` CLI, so it must be installed and available:

```bash
npm install -g @deepseek-ai/dsh
```

Node.js is **not** separately required — if no system `node` is found, the app runs
the CLI with its own bundled runtime (see [Finding the engine](#finding-the-engine)).

**You do not have to install it by hand.** If the app starts and cannot find a usable
`dsh`, it shows a setup screen offering two ways forward:

1. **Install it for me** — runs the npm install, falling back to a private prefix if the
   global one needs administrator rights, so no password is ever required.
2. **Use a folder I already have** — point it at a `deepseek-harness` checkout (built
   output if present, otherwise the TypeScript sources via `tsx`) or at an installed
   `@deepseek-ai/dsh` folder.

Nothing is accepted on trust: whichever option is used, the installation is booted once
before the app continues, so a folder that "looks right" but cannot run is reported
there and then rather than as a splash screen that never finishes.

---

## Build from source

**Requires Node.js 22.12 or newer** (`engines.node`). `electron@44` declares that
floor, and several transitive dependencies accept only `20 || >=22`; Node 24 is what
CI uses and is the recommended choice.

```bash
npm install
node node_modules/electron/install.js   # downloads the Electron binary (~370 MB)
npm start                              # run it
npm run dist                           # package for the current platform
```

> `npm install` may skip Electron's postinstall script (npm's `allow-scripts`
> policy), leaving `node_modules/electron/dist` empty. The second command forces
> the download.

`npm run dist` builds for the **host** platform only. Cross-building macOS targets
from Windows is not supported by electron-builder — use the CI workflow, which builds
each platform on its own runner. That is also the only way to sign and notarize a
macOS build.

### Platform support

| Platform | Packaged | Tested |
| --- | --- | --- |
| Windows | yes (NSIS + portable) | yes |
| macOS (arm64 / Intel) | yes (dmg + zip) | no — see below |
| Linux | no target configured | no |

The Linux code paths exist and are the documented cross-platform ones (process
groups for cleanup, `~/.config` for settings), but no Linux package is built, so the
target was removed from `package.json` and from CI rather than shipping something
untested.

---

## Why the shell has to start the server itself

`dsh web` does **not** serve a plain URL. The root returns **401** until a
per-process launch token is presented, and that token is only printed at startup:

```
dsh web: http://127.0.0.1:3080/?token=...
```

Visiting that URL once mints a session cookie and redirects to a clean `/`. So the
shell cannot simply point a window at `http://127.0.0.1:3080` — it must:

1. pick a free port (preferring 3080, then the port used last time, so the browser
   origin — and therefore the UI's local state — stays stable),
2. spawn `node <dsh>/lib/bin.js web --no-open --port <port>` with no console,
3. scrape the authenticated URL from that `dsh web:` line,
4. load it in the window, and
5. kill the server tree on close.

That last point is why launching the server yourself is worth it: whoever starts
the server owns its lifetime.

---

## Finding the engine

The app has to locate a working `dsh` before it can start anything, and "found a file"
is not the same as "found an installation that runs". Discovery and validation are
therefore separate steps.

**Discovery order** (`src/dsh-locate.js`), best guess first:

1. an explicit path — `dshBinPath` in `settings.json`, or a folder chosen in the setup
   screen;
2. a `dsh` executable on `PATH`, resolving symlinks — this is the CLI the user actually
   runs, and the only way to find one outside an npm prefix, such as a source build
   linked into `~/.local/bin`;
3. a source checkout in the usual places (`~/GitRepo/deepseek-harness`, `~/Projects/…`,
   and friends);
4. npm's global root, then the platform's conventional global prefixes.

A GUI-launched macOS app is started by launchd, so it inherits
`/usr/bin:/bin:/usr/sbin:/sbin` rather than the login shell's `PATH`. `~/.local/bin`,
`~/bin`, version-manager bin directories and the checkout locations above are searched
explicitly for that reason.

**Validation** then boots each candidate for real (`dsh web` on an ephemeral port, under
a throwaway `DSH_HOME`) and waits for the `dsh web: <url>` line *and* for the process to
still be healthy a moment later. Two things this catches that a cheaper check does not:

* the launch contract this shell depends on, verified against the exact installation
  rather than assumed from a version number;
* an installation whose plugin tree cannot load. `dsh web --help` exits 0 in that case
  because it never composes the plugins, so it would report a broken install as fine.

If nothing validates, the setup screen opens with the reason attached.

### Source checkouts

A `deepseek-harness` clone is supported directly, which matters because that is what
following the repository's own instructions produces:

| Checkout state | How it is launched |
| --- | --- |
| Built (`apps/cli/lib/bin.js` present) | `node apps/cli/lib/bin.js` — no loader needed |
| Not built, dependencies installed | `node --import <tsx> apps/cli/src/bin.ts` with `TSX_TSCONFIG_PATH` pointed at the checkout's tsconfig, so the `paths` aliases resolve |
| Neither | Not runnable; the setup screen says which command to run (`pnpm install`, `pnpm run build`) |

`TSX_TSCONFIG_PATH` is not optional: tsx otherwise looks for a tsconfig next to the
*working directory*, which for a GUI-launched app is nothing like the checkout, and the
CLI then dies on its first bare workspace import.

### When there is no system Node

The bundled Electron runtime is the last-resort fallback, started with
`ELECTRON_RUN_AS_NODE=1`. It also needs `--expose-internals` on the command line —
without it `dsh`'s HMR plugin fails to load (`--expose-internals is required for HMR
service`) and the whole profile fails. Plain Node always exposes internals, so the flag
is added only for Electron, and as a real argv entry because `NODE_OPTIONS` rejects it.

---

## Process cleanup

Closing the window stops the server on every path: `window-all-closed`,
`before-quit`, `will-quit`, and `SIGINT`/`SIGTERM`/`SIGHUP`.

`stop()` is idempotent and platform-aware:

| Platform | Mechanism |
| --- | --- |
| Windows | `taskkill /PID <pid> /T /F` — the whole tree |
| macOS / Linux | the child is spawned `detached` (its own process group) and killed with `process.kill(-pid, 'SIGTERM')`, escalating to `SIGKILL` after 3 s |

Measured on Windows: close → window gone in **0.4 s**, server stopped, port
released, **0 orphaned** processes.

---

## Configuration

`settings.json` lives in Electron's `userData` directory:

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%\DeepSeek Harness\settings.json` |
| macOS | `~/Library/Application Support/DeepSeek Harness/settings.json` |
| Linux | `~/.config/DeepSeek Harness/settings.json` |

Open it from the app: **Help → Open Settings Folder**.

| Key | Meaning |
| --- | --- |
| `port` | Preferred port; falls back to `lastPort`, then an OS-assigned one |
| `lastPort` | Written automatically; keeps the UI origin stable |
| `bounds`, `maximized` | Window geometry, saved on move/resize/close |
| `dshBinPath` | The installation in use; written when one is discovered or chosen in the setup screen |
| `dshVersion` | Its version, shown in the About box |
| `dshHome` | Alternate `DSH_HOME` to run against (else your default) |
| `theme` | `system` (default) or `dark` — see below |

To point the app at a different installation without editing the file, use
**Help → Change Engine…**; it opens the same setup screen and restarts the app when you
confirm. `--setup` on the command line opens it directly at startup, and
**Help → Open Settings Folder** reveals `settings.json`. The private install location
used when a global npm install is not permitted is `<userData>/cli` — delete that folder
to uninstall it.

### About the title bar on Windows

If **"show accent colour on title bars"** is enabled, Windows paints *every* caption
bar in your accent colour — a plain Notepad window looks the same — and
`nativeTheme` cannot override it. Setting `theme: "dark"` hides the native title bar
and draws a dark one, which does override it.

That mode has a cost: the top 34 px becomes a window-drag strip, so clicks there
stop reaching the page. The shell compensates by insetting the page (verified: web
content starts at `y: 34` instead of `y: 0`, so the DSH header is not covered —
without the inset it clipped the search button). It stays opt-in because `system`
keeps normal click behaviour and matches every other app on the machine.

---

## Signing and notarization

CI builds are **ad-hoc signed**: no Apple Developer certificate is configured, so CI
passes `--config.mac.identity=-` and electron-builder signs with the ad-hoc identity.
That makes the bundle internally consistent, but *not* trusted by Gatekeeper — hence
the first-launch step above.

### macOS signing: why the app must be sealed

An unsealed `.app` does not fail with "unidentified developer". It fails with **"the
app is damaged and can't be opened"**, because macOS cannot verify the bundle seal at
all — and right-click → Open cannot override that. Three things caused exactly that
here, in order of discovery:

1. **Hardened Runtime combined with ad-hoc signing.** electron-builder's own
   documentation is explicit: *"When using ad-hoc signing (`identity: "-"`), hardened
   runtime enforces library validation which will reject pre-signed Electron
   frameworks that carry a different Team ID."* Electron's frameworks are signed by
   Electron's team, so an ad-hoc shell aborts on launch. Fixed by
   `hardenedRuntime: false` plus the
   `com.apple.security.cs.disable-library-validation` entitlement.

2. **`CSC_IDENTITY_AUTO_DISCOVERY: false`.** This suppresses the certificate lookup
   entirely, which is not the same as "sign ad-hoc". Removed.

3. **`identity` was never set, so signing was skipped altogether.** This is the subtle
   one, and the real reason the bundle ended up unsealed:
   `app-builder-lib/out/mac/MacTargetHelper.js` only enters the ad-hoc branch on
   `if (qualifier === "-")`. With no certificate in the keychain and `identity` unset,
   it takes the `noIdentity` branch instead, where `reportError()` merely **logs a
   warning and returns null** — the build reports success and ships an unsigned
   bundle.

Both CI and the local scripts now pass `--config.mac.identity=-`, but only when no
certificate is configured. The condition is not optional: `identity: "-"` takes
precedence *over* `CSC_LINK`, because `findSigningIdentity()` matches the qualifier
against the keychain (nothing there is named `-`), gets null, and then forces the
ad-hoc identity anyway. So CI adds the flag only when `CSC_LINK` is empty, and
`npm run dist` / `npm run pack` do the same through `build/run-electron-builder.js`.

`build/entitlements.mac.plist` and `build/entitlements.mac.inherit.plist` are
auto-detected by electron-builder and carry the JIT entitlements Electron needs plus
the library-validation exemption.

CI runs `codesign --verify --deep --strict` on the produced `.app` and fails the build
if it is not properly sealed. That check is what surfaced cause 3, via
`code has no resources but signature indicates they must be present` — the signature
recorded resources that the unsigned bundle never sealed.

### Enabling real signing

Add these repository secrets and electron-builder will pick them up automatically:

| Secret | Purpose |
| --- | --- |
| `CSC_LINK` | base64 `.p12` Developer ID Application certificate |
| `CSC_KEY_PASSWORD` | its password |
| `APPLE_ID` | Apple ID for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password |
| `APPLE_TEAM_ID` | team identifier |

Then set `hardenedRuntime` back to `true` (it is required for notarization) — the
library-validation exemption stays, and is harmless for a real certificate.

---

## Upgrading dsh

The shell depends on three things that are internal to dsh rather than public API:

1. the CLI entry point at `<npm-root>/@deepseek-ai/dsh/lib/bin.js`,
2. `dsh web` accepting `--no-open` and `--port`,
3. the `dsh web: <url>` stdout line.

Item 3 is the fragile one: if upstream changes that line, the shell would hang on
the splash screen with no explanation. Verify after any upgrade:

```bash
node build/verify-contract.js
```

It boots a real server under a **throwaway `DSH_HOME`** (your profile and running
sessions are untouched), applies the exact regex from `server-host.js`, then performs
the same two-step handshake a browser does — token URL → 302 + `Set-Cookie` → cookie
replayed against `/` → HTTP 200. Non-zero exit on failure, with the captured output
printed so the regex can be fixed.

It resolves the installation through the same discovery the app uses, and launches it
with the same command line, so it verifies a source checkout through its loader as
readily as a packaged install:

```bash
node build/verify-contract.js --bin /path/to/deepseek-harness
```

Verified compatible with dsh **0.1.5-rc.1**, **0.1.5-rc.2**, **0.1.6-alpha.1**.

> Run it from a separate terminal, not from inside the app: the single-instance lock
> means a second launch just focuses the existing window.

---

## Project layout

```
src/
  main.js           Electron main process: window, menu, lifecycle, cleanup
  server-host.js    spawns `dsh web`, scrapes the token URL, kills the tree
  dsh-launch.js     describes an installation and turns it into a command line
  dsh-locate.js     finds installations, validates them by booting one
  dsh-install.js    one-click npm install, with a private-prefix fallback
  node-runtime.js   locating the Node (or Electron) runtime to run the CLI with
  setup-flow.js     main-process side of the first-run setup screen
  setup.html/.js    the setup screen itself (preload: setup-preload.js)
  settings.js       settings.json persistence (atomic write)
  loading.html/.js  splash screen shown while the server boots
build/
  verify-contract.js  verifies the dsh launch contract (run after upgrading dsh)
  make-icons.ps1      generates assets/icon.ico + icon.png (needs PowerShell)
  probe-chrome.js     measures what a custom title bar covers
  capture-real.ps1    window capture helper for visual verification
assets/
  icon.ico, icon.png
.github/workflows/build.yml   CI: builds all platforms, attaches release artifacts
```

---

## The icon

`assets/icon.ico` (Windows) and `assets/icon.png` (macOS/Linux) are generated from the
**official** whale mark in the installed dsh web frontend's `favicon.svg`:

```bash
npm run icons    # Windows / any host with PowerShell + Chrome or Edge
```

That mark is monochrome — white in the app's dark theme, near-black in light — so the
generator draws it white with a hairline dark keyline. That keeps it legible on a dark
taskbar *and* a light background, which a plain white or plain black mark cannot do.
The keyline width is recomputed per size (a constant number of final pixels), so it
stays a hairline at 256 px rather than becoming a fat border.

The generator is PowerShell-based and renders through headless Chrome, so CI treats it
as best-effort and falls back to the committed icons.

---

## A bug worth recording: hidden-window launches

The first Windows launcher was a `.cmd` that started Electron through a VBScript shim
using `WScript.Shell.Run(cmd, 0, False)`. The `0` means *hidden window*, and Windows
propagates that `STARTUPINFO` show-state to the child — so Electron duly created its
window hidden:

```
MainWindowHandle: 0         <- no window
MainWindowTitle : ''
server pid=1292 port=60470  <- but the app really was running
```

The server started and the UI was alive; there was simply nothing on screen. This is
why the packaged app is the supported way to launch: an app that owns its own window
has no shim that can suppress it. If you ever do need a console-free shim, pass `1`
(normal) rather than `0`.

---

## Verified behaviour

Measured on Windows 11 with a dsh session already running on port 3080:

| Check | Result |
| --- | --- |
| Window appears | ~4 s (incl. server boot) |
| Console window | none |
| Fallback port when 3080 is busy | yes, and reused on the next launch |
| Close → window gone | 0.4 s |
| Close → server stopped | yes, port released |
| Orphaned processes | 0 |
| Existing terminal session on 3080 | untouched |
| Second launch | focuses the existing window, starts no second server |

**Not yet verified on macOS or Linux.** The code paths used there are the documented
cross-platform ones (`titleBarOverlay` / `trafficLightPosition`, process groups), and
the CI workflow builds both, but no one has run them on real hardware yet.

---

## License

MIT
