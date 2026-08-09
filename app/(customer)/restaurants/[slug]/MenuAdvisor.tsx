'use client'
import { useState, useRef, useEffect } from 'react'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const GOLD = '#EFB84A'

export interface DiscoIntake {
  occasion?: string
  headcount?: string
  cuisines?: string[]
  location?: string
}

// A single live menu item passed to the advisor so it reasons over the REAL,
// current menu the customer sees — not the stale static top-few file.
export interface MenuItem { name: string; description?: string; category?: string; serves?: string | number; price?: number }

// The customer's real order context from the order-setup modal.
export interface OrderContext { headcount?: number; date?: string; service?: string }

type Msg = { role: 'user' | 'assistant'; content: string }

// Mode 2 — a collapsed gold pill that expands into a compact dark menu-advisor
// panel. Self-contained: it does NOT touch the cart, checkout, or auth.
export default function MenuAdvisor({
  restaurant,
  intake,
  packages,
  orderContext,
}: {
  restaurant: { name: string; cuisine?: string; location?: string }
  intake: DiscoIntake | null
  packages?: MenuItem[]
  orderContext?: OrderContext
}) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const firedRef = useRef(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  async function send(text: string, hidden = false) {
    const trimmed = text.trim()
    if (!trimmed || loading) return
    const apiMessages: Msg[] = [...messages, { role: 'user', content: trimmed }]
    // For the hidden auto-fire we keep the synthetic prompt out of the visible
    // transcript but still send it to the model.
    if (!hidden) setMessages(apiMessages)
    setInput('')
    setLoading(true)
    try {
      const res = await fetch('/api/disco-menu-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: apiMessages,
          // Pass the full live menu so the assistant reasons over the real, current
          // menu (the server falls back to the static file only if this is absent).
          restaurant: { name: restaurant.name, cuisine: restaurant.cuisine, location: restaurant.location, packages },
          intake: intake || undefined,
          orderContext: orderContext || undefined,
        }),
      })
      const data = await res.json()
      setMessages(prev => [...prev, { role: 'assistant', content: data.reply || 'Sorry, please try again.' }])
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Something went wrong. Please try again.' }])
    } finally {
      setLoading(false)
    }
  }

  // On first expand with any context (real order headcount, or the intake
  // questionnaire), auto-fire a recommendation using the real headcount when set.
  const realHeadcount = orderContext?.headcount
  useEffect(() => {
    if (!open || firedRef.current) return
    const occasion = intake?.occasion
    const headcount = realHeadcount ? `${realHeadcount} people` : intake?.headcount
    if (occasion || headcount) {
      firedRef.current = true
      send(
        `Recommend 2-3 packages for ${occasion || 'my event'} with ${headcount || 'my group'}. Include serves and price for each, and an estimated total.`,
        true,
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const showIntakeGreeting = (!!intake && (intake.occasion || intake.headcount) || !!realHeadcount) && messages.length === 0

  return (
    <div className="disco-menu-advisor">
      <style>{`
        .disco-menu-advisor { position: fixed; right: 18px; bottom: 24px; z-index: 120; font-family: ${F}; }
        @media (max-width: 900px) { .disco-menu-advisor { right: 14px; bottom: calc(84px + env(safe-area-inset-bottom, 0px)); } }
        /* #1: on mobile the "Ask Disco" label is too long — collapse to just the
           disco-ball logo in the gold circle. Sized at 46px (not the original
           54px) — the platform-standard ~44px minimum comfortable tap target
           plus a couple px of margin, small enough to stop crowding the
           screen without becoming hard to tap. */
        @media (max-width: 767px) {
          .disco-ask-btn { padding: 0 !important; width: 46px; height: 46px; justify-content: center; gap: 0 !important; }
          .disco-ask-btn .disco-ask-label { display: none; }
          .disco-ask-btn .disco-ask-ball { font-size: 19px !important; }
        }
        @keyframes discoAdvisorUp { from { opacity: 0; transform: translateY(12px) } to { opacity: 1; transform: translateY(0) } }
        @keyframes discoDot { 0%,80%,100% { transform: translateY(0); opacity: 0.4 } 40% { transform: translateY(-4px); opacity: 1 } }
        .disco-menu-advisor input::placeholder { color: rgba(255,255,255,0.45); }
      `}</style>

      {!open ? (
        <button
          onClick={() => setOpen(true)}
          aria-label="Ask Disco"
          className="disco-ask-btn"
          style={{
            display: 'flex', alignItems: 'center', gap: 7, padding: '11px 16px', borderRadius: 999,
            background: GOLD, color: DARK, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700,
            fontFamily: F, boxShadow: '0 6px 20px rgba(239,184,74,0.45)',
          }}
        >
          <span className="disco-ask-ball" style={{ fontSize: 14 }}>🪩</span> <span className="disco-ask-label">Ask Disco</span>
        </button>
      ) : (
        <div
          style={{
            width: 300, maxHeight: 400, display: 'flex', flexDirection: 'column',
            background: DARK, color: '#fff', borderRadius: 16, overflow: 'hidden',
            boxShadow: '0 16px 48px rgba(0,0,0,0.4)', animation: 'discoAdvisorUp 0.2s ease',
          }}
        >
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.1)', flexShrink: 0 }}>
            <span style={{ fontSize: 14 }}>🪩</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>Ask Disco</div>
              <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.5)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{restaurant.name}</div>
            </div>
            <button onClick={() => setOpen(false)} aria-label="Close" style={{ background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', cursor: 'pointer', width: 26, height: 26, borderRadius: '50%', fontSize: 15, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>×</button>
          </div>

          {/* Body */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {messages.length === 0 && !loading && (
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)', lineHeight: 1.55 }}>
                {showIntakeGreeting
                  ? `For ${intake?.occasion || 'your event'} with ${intake?.headcount || 'your group'}, here are my suggestions.`
                  : 'Tell me about your event.'}
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  maxWidth: '90%', padding: '8px 11px', borderRadius: m.role === 'user' ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
                  background: m.role === 'user' ? GOLD : 'rgba(255,255,255,0.08)',
                  color: m.role === 'user' ? DARK : '#fff',
                  fontSize: 12.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  fontWeight: m.role === 'user' ? 600 : 400,
                }}>
                  {m.content}
                </div>
              </div>
            ))}

            {loading && (
              <div style={{ display: 'flex', gap: 4, padding: '4px 2px' }}>
                {[0, 150, 300].map(d => (
                  <div key={d} style={{ width: 6, height: 6, borderRadius: '50%', background: GOLD, animation: 'discoDot 1s infinite', animationDelay: `${d}ms` }} />
                ))}
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div style={{ padding: '10px 12px', borderTop: '1px solid rgba(255,255,255,0.1)', flexShrink: 0 }}>
            <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.5)', marginBottom: 6 }}>
              {messages.length > 0 ? 'Questions about the menu?' : ' '}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') send(input) }}
                placeholder={showIntakeGreeting || messages.length > 0 ? 'Ask about the menu…' : 'Describe your event…'}
                style={{ flex: 1, padding: '9px 12px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.06)', color: '#fff', fontSize: 12.5, fontFamily: F, outline: 'none' }}
              />
              <button
                onClick={() => send(input)}
                disabled={loading || !input.trim()}
                aria-label="Send"
                style={{ width: 34, height: 34, borderRadius: '50%', border: 'none', background: GOLD, cursor: loading || !input.trim() ? 'default' : 'pointer', opacity: loading || !input.trim() ? 0.45 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, alignSelf: 'center' }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={DARK} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/></svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
