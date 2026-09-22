'use strict'

/**
 * Setup screen behaviour.
 *
 * The page owns no state that matters: every button asks the main process, which is
 * where the real detection, validation and installation live. What this file does is
 * render the answers, including the rule that Continue stays disabled until an
 * installation has been *proved* to start — picking a folder that merely exists is not
 * enough, because the whole point of the screen is to stop the app booting against
 * something that cannot run.
 *
 * Kept out of setup.html because the page runs under `default-src 'none'`, which
 * correctly blocks inline scripts.
 */

const api = window.dshSetup

const el = {
  whale: document.getElementById('whale'),
  subtitle: document.getElementById('subtitle'),
  lede: document.getElementById('lede'),
  cardInstall: document.getElementById('card-install'),
  installNote: document.getElementById('install-note'),
  btnInstall: document.getElementById('btn-install'),
  btnCancel: document.getElementById('btn-cancel'),
  logWrap: document.getElementById('log-wrap'),
  log: document.getElementById('log'),
  logNote: document.getElementById('log-note'),
  spinner: document.getElementById('spinner'),
  installVerdict: document.getElementById('install-verdict'),
  cardFolder: document.getElementById('card-folder'),
  btnFolder: document.getElementById('btn-folder'),
  drop: document.getElementById('drop'),
  folderVerdict: document.getElementById('folder-verdict'),
  btnRescan: document.getElementById('btn-rescan'),
  btnQuit: document.getElementById('btn-quit'),
  btnContinue: document.getElementById('btn-continue'),
  footNote: document.getElementById('foot-note'),
  reason: document.getElementById('reason'),
  reasonDetail: document.getElementById('reason-detail')
}

/** Locally mirrored view of the main process's state. */
let state = { installing: false, selection: null, candidates: [], npmAvailable: true }

function setVerdict (node, kind, title, detail) {
  node.className = `verdict show ${kind}`
  node.textContent = ''
  const strong = document.createElement('strong')
  strong.textContent = title
  node.appendChild(strong)
  if (detail) {
    const pre = document.createElement('pre')
    pre.textContent = detail
    node.appendChild(pre)
  }
}

function clearVerdict (node) {
  node.className = 'verdict'
  node.textContent = ''
}

/** Apply a state snapshot from the main process to the whole screen. */
function render (next) {
  state = { ...state, ...next }

  const installing = !!state.installing
  el.btnInstall.disabled = installing || state.npmAvailable === false
  el.btnInstall.textContent = installing ? 'Installing…' : 'Install'
  el.btnFolder.disabled = installing
  el.btnRescan.disabled = installing
  el.cardFolder.dataset.disabled = installing ? 'true' : 'false'
  el.logWrap.classList.toggle('show', installing || !!state.installFinished)
  el.spinner.classList.toggle('hidden', !installing)
  el.btnCancel.classList.toggle('hidden', !installing)
  el.btnContinue.disabled = !state.selection

  if (installing) {
    el.logNote.textContent = 'Installing… this can take a few minutes.'
  }

  if (state.npmAvailable === false) {
    el.installNote.textContent = 'Node.js and npm were not found, so this option is unavailable.'
  }

  // The selected installation, once one has been validated.
  if (state.selection) {
    const fromInstall = state.selection.source === 'install'
    const target = fromInstall ? el.installVerdict : el.folderVerdict
    clearVerdict(fromInstall ? el.folderVerdict : el.installVerdict)
    setVerdict(
      target,
      'ok',
      `Ready — dsh ${state.selection.version || 'unknown'}` +
        (state.selection.fromCheckout ? ' (source checkout)' : ''),
      state.selection.entry
    )
  }

  // A folder the user chose that could not be used: explain, and let them retry.
  if (state.folderError && !state.selection) {
    const node = el.folderVerdict
    node.className = 'verdict show bad'
    node.textContent = ''
    const strong = document.createElement('strong')
    strong.textContent = 'That folder cannot be used yet.'
    node.appendChild(strong)
    const pre = document.createElement('pre')
    pre.textContent = state.folderError
    node.appendChild(pre)
  }

  el.footNote.textContent = state.installing
    ? 'Working…'
    : 'Already installed it in a terminal?'
}

async function refresh () {
  render(await api.getState())
}

function appendLog (line) {
  const atBottom = el.log.scrollTop + el.log.clientHeight >= el.log.scrollHeight - 24
  el.log.textContent += (el.log.textContent ? '\n' : '') + line
  if (atBottom) el.log.scrollTop = el.log.scrollHeight
}

// --- actions -----------------------------------------------------------------

el.btnInstall.addEventListener('click', async () => {
  el.log.textContent = ''
  el.logWrap.classList.add('show')
  clearVerdict(el.installVerdict)
  render({ installing: true, installFinished: false, folderError: '' })

  const result = await api.install()
  render({ installing: false, installFinished: true })

  if (result?.ok) {
    el.logNote.textContent = result.target === 'global'
      ? 'Installed globally — the dsh command now works in your terminal too.'
      : 'Installed inside the app\'s own folder, so no administrator rights were needed.'
    el.btnContinue.disabled = false
    if (result.note) appendLog(result.note)
    await refresh()
  } else {
    el.logNote.textContent = 'Installation failed.'
    setVerdict(el.installVerdict, 'bad', 'Could not install automatically.', result?.error || 'Unknown error.')
    if (result?.log) el.log.textContent = result.log
  }
})

el.btnCancel.addEventListener('click', async () => {
  el.logNote.textContent = 'Cancelling…'
  await api.cancelInstall()
})

el.btnFolder.addEventListener('click', async () => {
  clearVerdict(el.folderVerdict)
  const result = await api.chooseFolder()
  // Cancelling the picker returns null; leave the screen as it was.
  if (result === null) return
  await refresh()
})

el.btnRescan.addEventListener('click', async () => {
  clearVerdict(el.folderVerdict)
  clearVerdict(el.installVerdict)
  render({ folderError: '', installFinished: false })
  await api.rescan()
  await refresh()
})

el.btnContinue.addEventListener('click', () => api.confirm())
el.btnQuit.addEventListener('click', () => api.quit())

// --- drag and drop of a folder ------------------------------------------------

for (const type of ['dragenter', 'dragover']) {
  el.drop.addEventListener(type, (event) => {
    event.preventDefault()
    el.drop.classList.add('over')
  })
}
for (const type of ['dragleave', 'dragend']) {
  el.drop.addEventListener(type, () => el.drop.classList.remove('over'))
}

el.drop.addEventListener('drop', async (event) => {
  event.preventDefault()
  el.drop.classList.remove('over')
  if (state.installing) return

  const file = event.dataTransfer?.files?.[0]
  if (!file) return
  const target = api.pathForFile(file)
  if (!target) {
    setVerdict(el.folderVerdict, 'bad', 'That item has no folder path.', 'Use “Choose folder…” instead.')
    return
  }

  clearVerdict(el.folderVerdict)
  await api.usePath(target)
  await refresh()
})

// Dropping anywhere else must not navigate the window away from the page.
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (event) => {
    if (event.target !== el.drop) event.preventDefault()
  })
}

// --- wiring ------------------------------------------------------------------

api.onProgress(appendLog)
api.onState(render)
refresh().then(() => {
  if (state.whale) el.whale.setAttribute('d', state.whale)

  // The failure that brought the user here, when there was one. Kept collapsed: it is
  // useful for diagnosing a broken install, and noise for someone who simply has none.
  if (state.reason) {
    el.reasonDetail.textContent = state.reason
    el.reason.classList.remove('hidden')
  }

  if (state.selection) {
    el.subtitle.textContent = 'A working dsh installation was found.'
    el.lede.textContent = 'Continue with the installation below, or choose a different one.'
  } else if (state.forced) {
    el.subtitle.textContent = 'Choose which dsh installation this app should use.'
    el.lede.textContent =
      'Install one below, or point the app at a folder that already has one — for ' +
      'example a deepseek-harness checkout.'
  } else if (state.reason) {
    el.subtitle.textContent = 'The dsh installation found on this machine would not start.'
    el.lede.textContent =
      'Reinstall it below, or point the app at a different folder — for example a ' +
      'deepseek-harness checkout.'
  }
})
