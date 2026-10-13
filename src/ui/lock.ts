/**
 * Passphrase gate.
 *
 * Be clear-eyed about what this is: the check runs on the visitor's machine,
 * against a constant shipped in the bundle, on a static host with no server to
 * enforce anything. Anyone can read the bundle or skip the check in DevTools.
 * It keeps casual visitors out of the workspace UI; it is not access control.
 *
 * Storing the SHA-256 rather than the passphrase at least keeps the literal
 * string out of a public repo — a hash is not reversible, though a short or
 * guessable passphrase falls to a dictionary attack regardless.
 *
 * Real protection would require a server to hold the secret and the data, which
 * is exactly what GitHub Pages does not provide. The flip side: every file lives
 * in the visitor's own browser (OPFS is per-origin, per-profile), so there is no
 * shared store for this gate to be failing to protect.
 */
const PASSPHRASE_SHA256 = 'f28fa2b8e7ec160908049c04e5f23f7df815c5d98d927f51788155f2f36d29a7'

const SESSION_KEY = 'copa:unlocked'

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Resolves once the correct passphrase has been entered. */
export function requireUnlock(): Promise<void> {
  if (sessionStorage.getItem(SESSION_KEY) === PASSPHRASE_SHA256) return Promise.resolve()

  // crypto.subtle only exists in a secure context. https:// and localhost
  // qualify; a bare file:// or http:// LAN address does not.
  if (!crypto?.subtle) {
    return Promise.reject(
      new Error('A secure context (https or localhost) is required to unlock this workspace.'),
    )
  }

  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'lock'
    overlay.innerHTML = `
      <form class="lock-card" autocomplete="off">
        <div class="lock-logo">⌘</div>
        <h1>copa</h1>
        <p class="lock-sub">Enter the passphrase to open your workspace</p>
        <input type="password" class="lock-input" aria-label="Passphrase" autocomplete="current-password" />
        <p class="lock-error" role="alert" hidden></p>
        <button type="submit" class="lock-button">Unlock</button>
      </form>`

    const form = overlay.querySelector('form')!
    const input = overlay.querySelector<HTMLInputElement>('.lock-input')!
    const error = overlay.querySelector<HTMLElement>('.lock-error')!
    let attempts = 0

    form.addEventListener('submit', (e) => {
      e.preventDefault()
      void (async () => {
        const hash = await sha256Hex(input.value)
        if (hash === PASSPHRASE_SHA256) {
          sessionStorage.setItem(SESSION_KEY, hash)
          overlay.classList.add('unlocked')
          // Let the fade finish before tearing the node out.
          setTimeout(() => overlay.remove(), 220)
          resolve()
          return
        }
        attempts++
        error.textContent =
          attempts >= 3 ? 'Still incorrect — check your capitalisation.' : 'Incorrect passphrase.'
        error.hidden = false
        input.select()
        overlay.querySelector('.lock-card')!.classList.remove('shake')
        // Reading offsetWidth forces a reflow, which restarts the animation;
        // without it the class removal and re-add collapse into one frame.
        void (overlay.querySelector('.lock-card') as HTMLElement).offsetWidth
        overlay.querySelector('.lock-card')!.classList.add('shake')
      })()
    })

    document.body.append(overlay)
    input.focus()
  })
}

export function lock(): void {
  sessionStorage.removeItem(SESSION_KEY)
  location.reload()
}
