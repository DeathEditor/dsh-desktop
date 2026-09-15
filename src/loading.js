'use strict'

/**
 * Splash-screen behaviour.
 *
 * Kept in its own file rather than inline: the page runs under a strict
 * `default-src 'none'` CSP, which correctly blocks inline scripts. An external
 * script with `script-src 'self'` keeps the policy tight without needing a hash or
 * a nonce.
 */

/** Replace the status line. Called from the main process while the server boots. */
window.__setStatus = function setStatus (text) {
  const el = document.getElementById('status')
  if (el) el.textContent = String(text)
}

/** Fill in the whale mark. The path data is injected by the main process. */
window.__setWhale = function setWhale (d) {
  const el = document.getElementById('whale')
  if (el && d) el.setAttribute('d', String(d))
}
