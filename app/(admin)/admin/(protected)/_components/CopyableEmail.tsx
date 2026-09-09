'use client'
/**
 * An email cell you can copy in one click.
 *
 * The super-admin ordering table shows the restaurant's admin email in a
 * 190px fixed column. It carried a `title` tooltip, so the address was
 * READABLE on hover — but not selectable, which is the half that mattered:
 * copying meant a careful click-drag across a 232px target in a 7px-padded
 * row, easy to mis-grab or truncate.
 *
 * Widening the column fixes display; this fixes copying. One click, no drag
 * precision, and it cannot produce a partial address.
 */
import { useCallback, useRef, useState } from 'react'

const F = "'DM Sans', sans-serif"

/**
 * navigator.clipboard requires a SECURE CONTEXT. Production is HTTPS so it is
 * fine there, but on plain-http localhost it rejects silently and the click
 * looks broken to whoever is testing. Fall back to the deprecated
 * execCommand path, which still works everywhere, rather than showing nothing.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    // Off-screen but focusable: display:none would make execCommand a no-op.
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.setAttribute('readonly', '')
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export function CopyableEmail({ email, style }: { email: string; style?: React.CSSProperties }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onCopy = useCallback(async (e: React.MouseEvent) => {
    // Rows in this table have their own click handlers; copying must not also
    // trigger whatever the row does.
    e.stopPropagation()
    if (!email) return
    const ok = await copyText(email)
    setState(ok ? 'copied' : 'failed')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 1400)
  }, [email])

  if (!email) return <span style={{ color: '#bbb' }}>—</span>

  return (
    <span
      onClick={onCopy}
      // title kept deliberately: it still shows the full address on hover, and
      // it costs nothing now that the column is wide enough not to truncate.
      title={state === 'idle' ? `${email} — click to copy` : email}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCopy(e as unknown as React.MouseEvent) } }}
      style={{
        cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6,
        maxWidth: '100%', fontFamily: F, ...style,
      }}
    >
      {/* The ellipsis machinery stays as a guard: the column now fits every
          address in the table (longest measured 232px against 236px usable),
          but a longer one appearing later should clip rather than break the
          layout. */}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</span>
      {state === 'copied' && <span style={{ fontSize: 11, fontWeight: 700, color: '#2E9E5B', whiteSpace: 'nowrap' }}>Copied</span>}
      {state === 'failed' && <span style={{ fontSize: 11, fontWeight: 700, color: '#C62828', whiteSpace: 'nowrap' }}>Copy failed</span>}
    </span>
  )
}
