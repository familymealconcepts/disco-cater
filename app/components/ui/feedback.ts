// Brand-styled imperative replacements for native alert() / confirm().
//
// These render plain DOM (no React mount needed) so they're drop-in 1:1 swaps
// at any call site:
//   alert('Saved')              → toast('Saved')
//   if (confirm('Sure?')) {…}   → if (await confirmDialog('Sure?')) {…}
//
// Client-only: every function no-ops gracefully during SSR.

const F = "'DM Sans', sans-serif"
const COLORS = {
  info: '#1A1028',
  success: '#1D9E75',
  error: '#E53935',
  primary: '#586CE1',
  danger: '#E53935',
}

type ToastKind = 'info' | 'success' | 'error'

let toastContainer: HTMLDivElement | null = null

function ensureToastContainer(): HTMLDivElement | null {
  if (typeof document === 'undefined') return null
  if (toastContainer && document.body.contains(toastContainer)) return toastContainer
  const el = document.createElement('div')
  el.style.cssText =
    'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:99999;' +
    'display:flex;flex-direction:column;gap:10px;align-items:center;pointer-events:none;'
  document.body.appendChild(el)
  toastContainer = el
  return el
}

/** Show a brief auto-dismissing toast. Replaces alert() for non-blocking notices. */
export function toast(message: string, opts?: { kind?: ToastKind; duration?: number }) {
  const container = ensureToastContainer()
  if (!container) return
  const kind = opts?.kind || 'info'
  const duration = opts?.duration ?? 3200

  const t = document.createElement('div')
  t.textContent = message
  t.style.cssText =
    `font-family:${F};font-size:14px;font-weight:600;color:#fff;` +
    `background:${COLORS[kind]};padding:12px 20px;border-radius:12px;` +
    'box-shadow:0 6px 24px rgba(0,0,0,0.18);max-width:min(90vw,420px);' +
    'text-align:center;line-height:1.45;pointer-events:auto;' +
    'opacity:0;transform:translateY(8px);transition:opacity .18s ease,transform .18s ease;'
  container.appendChild(t)

  // next frame → animate in
  requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'translateY(0)' })

  const remove = () => {
    t.style.opacity = '0'
    t.style.transform = 'translateY(8px)'
    setTimeout(() => { t.remove(); if (toastContainer && !toastContainer.childElementCount) { toastContainer.remove(); toastContainer = null } }, 200)
  }
  setTimeout(remove, duration)
}

/**
 * Styled confirmation modal. Returns a Promise<boolean> — resolves true on
 * confirm, false on cancel / backdrop / Escape. Replaces native confirm().
 */
export function confirmDialog(
  message: string,
  opts?: { title?: string; confirmText?: string; cancelText?: string; danger?: boolean }
): Promise<boolean> {
  if (typeof document === 'undefined') return Promise.resolve(false)

  return new Promise<boolean>(resolve => {
    const confirmText = opts?.confirmText || 'Confirm'
    const cancelText = opts?.cancelText || 'Cancel'
    const confirmBg = opts?.danger ? COLORS.danger : COLORS.primary

    const backdrop = document.createElement('div')
    backdrop.style.cssText =
      'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.4);' +
      'display:flex;align-items:center;justify-content:center;padding:24px;' +
      `font-family:${F};opacity:0;transition:opacity .15s ease;`

    const card = document.createElement('div')
    card.style.cssText =
      'background:#fff;border-radius:16px;padding:26px 28px;max-width:400px;width:100%;' +
      'box-shadow:0 20px 60px rgba(0,0,0,0.25);transform:scale(0.97);transition:transform .15s ease;'

    if (opts?.title) {
      const h = document.createElement('h3')
      h.textContent = opts.title
      h.style.cssText = `margin:0 0 10px;font-size:17px;font-weight:800;color:${COLORS.info};`
      card.appendChild(h)
    }

    const p = document.createElement('p')
    p.textContent = message
    p.style.cssText = 'margin:0 0 22px;font-size:14px;color:#555;line-height:1.55;'
    card.appendChild(p)

    const row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;'

    const cancelBtn = document.createElement('button')
    cancelBtn.textContent = cancelText
    cancelBtn.style.cssText =
      `font-family:${F};padding:9px 18px;border:1px solid #ddd;border-radius:9px;` +
      'background:#fff;color:#444;font-size:13px;font-weight:600;cursor:pointer;'

    const confirmBtn = document.createElement('button')
    confirmBtn.textContent = confirmText
    confirmBtn.style.cssText =
      `font-family:${F};padding:9px 18px;border:none;border-radius:9px;` +
      `background:${confirmBg};color:#fff;font-size:13px;font-weight:700;cursor:pointer;`

    row.appendChild(cancelBtn)
    row.appendChild(confirmBtn)
    card.appendChild(row)
    backdrop.appendChild(card)
    document.body.appendChild(backdrop)

    requestAnimationFrame(() => { backdrop.style.opacity = '1'; card.style.transform = 'scale(1)' })

    const cleanup = (result: boolean) => {
      document.removeEventListener('keydown', onKey)
      backdrop.style.opacity = '0'
      card.style.transform = 'scale(0.97)'
      setTimeout(() => { backdrop.remove(); resolve(result) }, 150)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cleanup(false)
      else if (e.key === 'Enter') cleanup(true)
    }

    cancelBtn.onclick = () => cleanup(false)
    confirmBtn.onclick = () => cleanup(true)
    backdrop.onclick = e => { if (e.target === backdrop) cleanup(false) }
    document.addEventListener('keydown', onKey)
    confirmBtn.focus()
  })
}
