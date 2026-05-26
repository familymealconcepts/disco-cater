'use client'
import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'
const BLUE = '#5B6FE8'
const INDIGO = '#6B6EF9'
const STEPS = ['Frequency', 'Start date', 'End condition', 'Review'] as const

// FM frequency enum on the server side: WEEKLY | BIWEEKLY | MONTHLY | CUSTOM
// (matches IOrderFrequency.frequencyType from
// _system/_services/subscriptions/subscriptions-crud.service.ts model)
type Frequency = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'CUSTOM'
type CustomUnit = 'WEEK' | 'MONTH'
type EndKind = 'NEVER' | 'COUNT' | 'DATE'

export interface SubscriptionDraft {
  frequency: Frequency
  customInterval?: number   // when frequency === 'CUSTOM'
  customUnit?: CustomUnit
  startDate: string         // YYYY-MM-DD
  endKind: EndKind
  endCount?: number
  endDate?: string
  restaurantRef?: string
  restaurantName?: string
  restaurantSlug?: string
  sourceOrderRef?: string   // when launched from "Repeat this order"
}

interface Props {
  restaurantName?: string
  restaurantSlug?: string
  restaurantRef?: string
  sourceOrderRef?: string   // history "Repeat this order"
  onClose: () => void
}

const SESSION_KEY = 'disco_subscription_draft'

export default function SubscriptionSetupModal({ restaurantName, restaurantSlug, restaurantRef, sourceOrderRef, onClose }: Props) {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<SubscriptionDraft>(() => ({
    frequency: 'WEEKLY',
    customInterval: 2,
    customUnit: 'WEEK',
    startDate: nextAvailableDate(),
    endKind: 'NEVER',
    endCount: 4,
    endDate: '',
    restaurantRef, restaurantName, restaurantSlug,
    sourceOrderRef,
  }))

  function next() { setStep(s => Math.min(STEPS.length - 1, s + 1)) }
  function back() { setStep(s => Math.max(0, s - 1)) }
  function canAdvance(): boolean {
    if (step === 0) return draft.frequency !== 'CUSTOM' || ((draft.customInterval || 0) > 0)
    if (step === 1) return !!draft.startDate
    if (step === 2) {
      if (draft.endKind === 'COUNT') return (draft.endCount || 0) > 0
      if (draft.endKind === 'DATE') return !!draft.endDate
      return true
    }
    return true
  }

  function confirm() {
    // FM has no standalone customer "create subscription" endpoint — diners
    // subscribe by checking out a subscription meal-package at a restaurant.
    // Stash the draft so the existing order-flow can pick it up, then route
    // the user to the restaurant page (or fullmap when none was chosen).
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(draft)) } catch {}
    if (draft.restaurantSlug) {
      router.push(`/restaurants/${draft.restaurantSlug}?subscribe=1`)
    } else {
      router.push('/fullmap?subscribe=1')
    }
    onClose()
  }

  return (
    <div onClick={onClose} style={backdrop}>
      <div onClick={e => e.stopPropagation()} style={modal}>
        {/* Header */}
        <div style={{ padding: '20px 24px 14px', borderBottom: '1px solid #f0f0f0' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: DARK }}>
              {sourceOrderRef ? 'Repeat this order' : 'New recurring order'}
            </h2>
            <button onClick={onClose} aria-label="Close" style={closeBtn}>×</button>
          </div>
          {restaurantName && (
            <div style={{ fontSize: 12, color: '#888' }}>Restaurant: <span style={{ color: DARK, fontWeight: 600 }}>{restaurantName}</span></div>
          )}
          <Stepper step={step} />
        </div>

        {/* Step body */}
        <div style={{ padding: '20px 24px', minHeight: 280 }}>
          {step === 0 && <Step1Frequency draft={draft} setDraft={setDraft} />}
          {step === 1 && <Step2StartDate draft={draft} setDraft={setDraft} />}
          {step === 2 && <Step3EndCondition draft={draft} setDraft={setDraft} />}
          {step === 3 && <Step4Review draft={draft} />}
        </div>

        {/* Footer */}
        <div style={{ padding: '14px 24px', borderTop: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <button onClick={back} disabled={step === 0} style={{ ...secondaryBtn, opacity: step === 0 ? 0.4 : 1, cursor: step === 0 ? 'not-allowed' : 'pointer' }}>
            ← Back
          </button>
          {step < STEPS.length - 1 ? (
            <button onClick={next} disabled={!canAdvance()} style={{ ...primaryBtn, opacity: canAdvance() ? 1 : 0.5, cursor: canAdvance() ? 'pointer' : 'not-allowed' }}>
              Continue →
            </button>
          ) : (
            <button onClick={confirm} style={primaryBtn}>
              Confirm recurring order
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Step 1: Frequency ───────────────────────────────────────────────────────

function Step1Frequency({ draft, setDraft }: { draft: SubscriptionDraft; setDraft: React.Dispatch<React.SetStateAction<SubscriptionDraft>> }) {
  const opts: { v: Frequency; label: string; sub: string }[] = [
    { v: 'WEEKLY', label: 'Weekly', sub: 'Every 7 days' },
    { v: 'BIWEEKLY', label: 'Bi-weekly', sub: 'Every 14 days' },
    { v: 'MONTHLY', label: 'Monthly', sub: 'Once per calendar month' },
    { v: 'CUSTOM', label: 'Custom', sub: 'Pick your own interval' },
  ]
  return (
    <div>
      <SectionTitle>How often?</SectionTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {opts.map(o => {
          const active = draft.frequency === o.v
          return (
            <button key={o.v} onClick={() => setDraft(d => ({ ...d, frequency: o.v }))}
              style={{ ...radioCard, border: active ? `1.5px solid ${INDIGO}` : '1.5px solid #e8e8e8', background: active ? '#F5F4FF' : '#fff' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{
                  width: 18, height: 18, borderRadius: '50%', border: `2px solid ${active ? INDIGO : '#ccc'}`,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  {active && <span style={{ width: 8, height: 8, borderRadius: '50%', background: INDIGO }} />}
                </span>
                <div style={{ textAlign: 'left' }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>{o.label}</div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 1 }}>{o.sub}</div>
                </div>
              </div>
            </button>
          )
        })}
      </div>
      {draft.frequency === 'CUSTOM' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, padding: 12, background: '#f8f8fc', borderRadius: 8 }}>
          <span style={{ fontSize: 13, color: DARK }}>Every</span>
          <input type="number" min={1} max={52} value={draft.customInterval ?? ''}
            onChange={e => setDraft(d => ({ ...d, customInterval: parseInt(e.target.value) || 0 }))}
            style={{ width: 64, padding: '7px 10px', border: '1.5px solid #e0e0e0', borderRadius: 7, fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }} />
          <select value={draft.customUnit || 'WEEK'} onChange={e => setDraft(d => ({ ...d, customUnit: e.target.value as CustomUnit }))}
            style={{ padding: '7px 10px', border: '1.5px solid #e0e0e0', borderRadius: 7, fontSize: 13, fontFamily: F, color: DARK, background: '#fff' }}>
            <option value="WEEK">weeks</option>
            <option value="MONTH">months</option>
          </select>
        </div>
      )}
    </div>
  )
}

// ── Step 2: Start date ──────────────────────────────────────────────────────

function Step2StartDate({ draft, setDraft }: { draft: SubscriptionDraft; setDraft: React.Dispatch<React.SetStateAction<SubscriptionDraft>> }) {
  return (
    <div>
      <SectionTitle>When should it start?</SectionTitle>
      <p style={{ fontSize: 12, color: '#888', margin: '0 0 14px' }}>
        Defaults to the next available occurrence — restaurants may decline dates that fall on closed days at checkout.
      </p>
      <input type="date" value={draft.startDate} onChange={e => setDraft(d => ({ ...d, startDate: e.target.value }))}
        min={today()}
        style={{ width: '100%', maxWidth: 260, padding: '10px 12px', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 14, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }} />
    </div>
  )
}

// ── Step 3: End condition ───────────────────────────────────────────────────

function Step3EndCondition({ draft, setDraft }: { draft: SubscriptionDraft; setDraft: React.Dispatch<React.SetStateAction<SubscriptionDraft>> }) {
  return (
    <div>
      <SectionTitle>When should it end?</SectionTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <EndOption checked={draft.endKind === 'NEVER'} onClick={() => setDraft(d => ({ ...d, endKind: 'NEVER' }))}
          label="Until I cancel" sub="Recurring orders continue until you pause or cancel" />
        <EndOption checked={draft.endKind === 'COUNT'} onClick={() => setDraft(d => ({ ...d, endKind: 'COUNT' }))}
          label="After a number of orders" sub="Set a maximum count">
          {draft.endKind === 'COUNT' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <span style={{ fontSize: 13, color: DARK }}>End after</span>
              <input type="number" min={1} max={520} value={draft.endCount ?? ''}
                onChange={e => setDraft(d => ({ ...d, endCount: parseInt(e.target.value) || 0 }))}
                style={{ width: 64, padding: '7px 10px', border: '1.5px solid #e0e0e0', borderRadius: 7, fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }} />
              <span style={{ fontSize: 13, color: DARK }}>orders</span>
            </div>
          )}
        </EndOption>
        <EndOption checked={draft.endKind === 'DATE'} onClick={() => setDraft(d => ({ ...d, endKind: 'DATE' }))}
          label="On a specific date" sub="Recurring stops after this date">
          {draft.endKind === 'DATE' && (
            <input type="date" value={draft.endDate || ''} min={draft.startDate || today()}
              onChange={e => setDraft(d => ({ ...d, endDate: e.target.value }))}
              style={{ width: '100%', maxWidth: 220, padding: '8px 10px', marginTop: 8, border: '1.5px solid #e0e0e0', borderRadius: 7, fontSize: 13, fontFamily: F, color: DARK, outline: 'none', background: '#fff' }} />
          )}
        </EndOption>
      </div>
    </div>
  )
}

function EndOption({ checked, onClick, label, sub, children }: {
  checked: boolean; onClick: () => void; label: string; sub: string; children?: React.ReactNode
}) {
  return (
    <div style={{ ...radioCard, padding: '12px 14px', border: checked ? `1.5px solid ${INDIGO}` : '1.5px solid #e8e8e8', background: checked ? '#F5F4FF' : '#fff' }}
      onClick={onClick}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <span style={{
          width: 18, height: 18, borderRadius: '50%', border: `2px solid ${checked ? INDIGO : '#ccc'}`,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1,
        }}>
          {checked && <span style={{ width: 8, height: 8, borderRadius: '50%', background: INDIGO }} />}
        </span>
        <div style={{ textAlign: 'left', flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: DARK }}>{label}</div>
          <div style={{ fontSize: 11, color: '#888', marginTop: 1 }}>{sub}</div>
          {children}
        </div>
      </div>
    </div>
  )
}

// ── Step 4: Review ──────────────────────────────────────────────────────────

function Step4Review({ draft }: { draft: SubscriptionDraft }) {
  const freq = useMemo(() => describeFrequency(draft), [draft])
  const end = useMemo(() => describeEnd(draft), [draft])
  return (
    <div>
      <SectionTitle>Review</SectionTitle>
      <div style={{ background: '#f8f8fc', borderRadius: 10, border: '1px solid #f0f0f0', padding: '14px 16px' }}>
        <ReviewRow label="Restaurant" value={draft.restaurantName || 'Choose at next step'} />
        <ReviewRow label="Frequency" value={freq} />
        <ReviewRow label="Start date" value={prettyDate(draft.startDate)} />
        <ReviewRow label="Ends" value={end} />
        <ReviewRow label="Payment" value="Saved payment method (selected at checkout)" />
      </div>
      <p style={{ fontSize: 11, color: '#888', margin: '14px 0 0', lineHeight: 1.5 }}>
        You'll confirm items and payment on the next screen. FM creates the recurring order at checkout — you can pause, skip, or cancel anytime from <strong>Subscriptions</strong>.
      </p>
    </div>
  )
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 13 }}>
      <span style={{ color: '#888' }}>{label}</span>
      <span style={{ color: DARK, fontWeight: 600, textAlign: 'right', maxWidth: '65%' }}>{value}</span>
    </div>
  )
}

// ── Stepper indicator ───────────────────────────────────────────────────────

function Stepper({ step }: { step: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12 }}>
      {STEPS.map((label, i) => {
        const active = i === step
        const done = i < step
        return (
          <div key={label} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
            <div style={{
              width: 22, height: 22, borderRadius: '50%',
              background: done ? INDIGO : active ? INDIGO : '#e8e8e8',
              color: done || active ? '#fff' : '#aaa',
              fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>{done ? '✓' : i + 1}</div>
            <span style={{ fontSize: 10, color: active ? DARK : '#aaa', fontWeight: active ? 700 : 500, marginLeft: 6, marginRight: 6, whiteSpace: 'nowrap' }}>
              {label}
            </span>
            {i < STEPS.length - 1 && <div style={{ flex: 1, height: 2, background: done ? INDIGO : '#e8e8e8', borderRadius: 1 }} />}
          </div>
        )
      })}
    </div>
  )
}

// ── helpers ─────────────────────────────────────────────────────────────────

function today(): string { return new Date().toISOString().slice(0, 10) }

function nextAvailableDate(): string {
  // "Next available" — bump start by one day so today's cut-off doesn't bite
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

function prettyDate(s?: string): string {
  if (!s) return '—'
  try { return new Date(`${s}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) }
  catch { return s }
}

export function describeFrequency(d: SubscriptionDraft): string {
  if (d.frequency === 'WEEKLY') return 'Weekly'
  if (d.frequency === 'BIWEEKLY') return 'Bi-weekly'
  if (d.frequency === 'MONTHLY') return 'Monthly'
  const n = d.customInterval || 1
  const unit = (d.customUnit || 'WEEK') === 'WEEK' ? (n === 1 ? 'week' : 'weeks') : (n === 1 ? 'month' : 'months')
  return `Every ${n} ${unit}`
}

export function describeEnd(d: SubscriptionDraft): string {
  if (d.endKind === 'NEVER') return 'Until I cancel'
  if (d.endKind === 'COUNT') return `After ${d.endCount || 0} orders`
  if (d.endKind === 'DATE') return d.endDate ? `On ${prettyDate(d.endDate)}` : 'On a specific date'
  return '—'
}

// ── styles ──────────────────────────────────────────────────────────────────

const backdrop: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 720,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
  fontFamily: F,
}
const modal: React.CSSProperties = {
  background: '#fff', borderRadius: 16, width: '100%', maxWidth: 520, maxHeight: '92vh',
  display: 'flex', flexDirection: 'column', boxShadow: '0 12px 48px rgba(0,0,0,0.18)',
  overflow: 'hidden',
}
const closeBtn: React.CSSProperties = {
  background: '#f4f4f8', border: 'none', cursor: 'pointer', width: 28, height: 28, borderRadius: '50%',
  fontSize: 16, color: '#888', display: 'flex', alignItems: 'center', justifyContent: 'center',
}
const primaryBtn: React.CSSProperties = {
  padding: '10px 18px', background: BLUE, color: '#fff', border: 'none', borderRadius: 8,
  fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: F,
}
const secondaryBtn: React.CSSProperties = {
  padding: '8px 14px', background: '#fff', color: DARK, border: '1px solid #e0e0e0', borderRadius: 8,
  fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: F,
}
const radioCard: React.CSSProperties = {
  background: '#fff', border: '1.5px solid #e8e8e8', borderRadius: 10, padding: '12px 14px',
  cursor: 'pointer', fontFamily: F, textAlign: 'left',
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 14, fontWeight: 700, color: DARK, marginBottom: 14 }}>{children}</div>
}
