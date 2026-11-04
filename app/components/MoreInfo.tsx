'use client'
// "More Info" UI (lib/more-info.ts): the settings field (portal + Super Admin), the read-only text
// renderer, and the ordering page's "More info" button + popup.
//
// The text is rendered as React text nodes and <a> elements only (moreInfoSegments). There is no
// dangerouslySetInnerHTML anywhere here, so nothing a restaurant types can become markup or code.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { moreInfoSegments, MORE_INFO_HINT, MORE_INFO_MAX } from '../../lib/more-info'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'

/** The note with its line breaks kept and its links clickable (new tab, no referrer or opener). */
export function MoreInfoText({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', ...style }}>
      {moreInfoSegments(text).map((s, i) =>
        s.kind === 'link'
          ? <a key={i} href={s.href} target="_blank" rel="noopener noreferrer nofollow" style={{ color: '#4648D4', textDecoration: 'underline' }}>{s.text}</a>
          : <span key={i}>{s.text}</span>
      )}
    </div>
  )
}

/** Multi-line, grows as you type, MORE_INFO_MAX characters, with the hint and a counter. */
export function MoreInfoField({ value, onChange, inputStyle }: { value: string; onChange: (v: string) => void; inputStyle?: CSSProperties }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(el.scrollHeight, 76)}px`
  }, [value])
  return (
    <div>
      <textarea
        ref={ref}
        aria-label="More Info"
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, MORE_INFO_MAX))}
        maxLength={MORE_INFO_MAX}
        rows={3}
        placeholder="Parking, pickup instructions, catering policies…"
        style={{ width: '100%', boxSizing: 'border-box', resize: 'none', overflow: 'hidden', lineHeight: 1.5, fontFamily: F, ...inputStyle }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginTop: 6 }}>
        <span style={{ fontSize: 11.5, color: '#888', lineHeight: 1.4 }}>{MORE_INFO_HINT}</span>
        <span style={{ fontSize: 11, color: '#bbb', flexShrink: 0 }}>{value.length}/{MORE_INFO_MAX}</span>
      </div>
    </div>
  )
}

/**
 * The ordering page's small "More info" text button and its popup. Renders nothing when the note is
 * empty. Closes on the × button, Esc, or a click outside the card; focus returns to the button.
 */
export function MoreInfoButton({ restaurantName, text }: { restaurantName: string; text: string | null | undefined }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const close = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    close.current?.focus()
    const trigger = btn.current
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      trigger?.focus()
    }
  }, [open])

  const note = (text || '').trim()
  if (!note) return null

  return (
    <>
      <button
        ref={btn}
        type="button"
        onClick={() => setOpen(true)}
        data-testid="more-info-button"
        aria-haspopup="dialog"
        style={{ background: 'none', border: 'none', padding: 0, margin: '0 0 6px', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: '#4648D4', fontFamily: F, textDecoration: 'underline', textUnderlineOffset: 2 }}
      >
        More info
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          onClick={() => setOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(10,0,20,0.55)', zIndex: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="more-info-title"
            data-testid="more-info-dialog"
            onClick={(e) => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 20, width: '100%', maxWidth: 460, maxHeight: 'min(80vh, 640px)', display: 'flex', flexDirection: 'column', boxShadow: '0 32px 80px rgba(0,0,0,0.22)', overflow: 'hidden', fontFamily: F }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '14px 22px', flexShrink: 0, borderBottom: '1px solid #f0f0f0' }}>
              <div id="more-info-title" style={{ fontSize: 17, fontWeight: 800, color: DARK, letterSpacing: '-0.02em', flex: 1, minWidth: 0 }}>{restaurantName}</div>
              <button ref={close} type="button" onClick={() => setOpen(false)} aria-label="Close"
                style={{ background: '#f4f4f8', border: 'none', cursor: 'pointer', width: 32, height: 32, borderRadius: '50%', fontSize: 18, color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>×</button>
            </div>
            <div style={{ overflowY: 'auto', padding: '16px 22px 22px' }}>
              <MoreInfoText text={note} style={{ fontSize: 14, color: '#3d3b5c', lineHeight: 1.6 }} />
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}
