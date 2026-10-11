// ⚠️ TEMPORARY DEMO — Disco Cater loyalty tiers, for Peter to look at.
// Cosmetic ONLY: no tier is computed from real orders, no fee is actually
// reduced, no checkout maths is touched anywhere. Strictly gated to ONE
// hardcoded test-diner email so it can never show for a real customer.
//
// ─── HOW TO FULLY REMOVE ─────────────────────────────────────────────────────
//   Fastest kill-switch: set LOYALTY_DEMO_ENABLED = false below. That single
//   flag turns off the header chip, the portal tab, and the page (which
//   redirects). Full removal: delete this file, delete
//   app/(customer)/account/loyalty/, and remove the small `isLoyaltyDemoUser(...)`
//   insertions in GlobalHeader.tsx and AccountLayoutClient.tsx (marked
//   "LOYALTY DEMO").
// ─────────────────────────────────────────────────────────────────────────────

// One-place kill switch. false → nothing renders anywhere.
export const LOYALTY_DEMO_ENABLED = true

// The ONLY account this demo is visible to (exact, case-insensitive match).
// NB: peteventi, not peterventi — the latter has no orders at all.
export const LOYALTY_DEMO_EMAIL = 'peteventi+1@gmail.com'

// Single gate used by every surface. Hardcoded email — NOT a general flag —
// so there is zero chance of leaking to a real customer.
export function isLoyaltyDemoUser(email?: string | null): boolean {
  if (!LOYALTY_DEMO_ENABLED) return false
  return typeof email === 'string' && email.trim().toLowerCase() === LOYALTY_DEMO_EMAIL
}

// ── TIERS ───────────────────────────────────────────────────────────────────
// Peter's thresholds, as specified: BOTH conditions must be met (AND), measured
// over a rolling 12 months. The three higher tiers are scaled above his entry
// tier of 10 orders AND $5,000.
//
// MEASURED AGAINST REAL HISTORY, these qualify almost nobody — 2 customers reach
// Copper and 0 reach any tier above it, out of 8,426 active diners. That is
// reported rather than silently softened; the numbers here are the ones asked
// for. See the report accompanying this change for a ladder that produces a
// real distribution (2/$250, 3/$750, 4/$2,000, 6/$5,000 → 538/87/15/3).
export interface LoyaltyTier {
  key: 'copper' | 'silver' | 'gold' | 'platinum'
  name: string
  minOrders: number
  minSubtotal: number
  /** Percentage POINTS off the platform fee. The fee is Disco's own revenue
   *  (lib/promo-pricing.ts: familyMealFee is added to the diner total and
   *  excluded from the restaurant transfer), so a reduction never touches a
   *  restaurant's payout. Cosmetic here — nothing applies it. */
  feeCutPoints: number
  /** Palette: copper and silver are the only new values. Gold reuses the
   *  existing brand accent #EFB84A; platinum reuses the brand GRADIENT, so the
   *  top tier reads as "Disco" rather than as a fifth metal. */
  colour: string
  gradient?: string
  ink: string
}

export const BRAND_GRADIENT = 'linear-gradient(90deg, #6466E8 0%, #C044C8 50%, #F0468A 100%)'

export const LOYALTY_TIERS: LoyaltyTier[] = [
  { key: 'copper',   name: 'Copper',   minOrders: 10, minSubtotal: 5000,  feeCutPoints: 0.5, colour: '#B87333', ink: '#5E3A1A' },
  { key: 'silver',   name: 'Silver',   minOrders: 20, minSubtotal: 12500, feeCutPoints: 1.0, colour: '#9BA3AF', ink: '#3F4651' },
  { key: 'gold',     name: 'Gold',     minOrders: 35, minSubtotal: 30000, feeCutPoints: 1.5, colour: '#EFB84A', ink: '#6B4E12' },
  { key: 'platinum', name: 'Platinum', minOrders: 50, minSubtotal: 60000, feeCutPoints: 2.0, colour: '#6466E8', gradient: BRAND_GRADIENT, ink: '#2A2060' },
]

/** Highest tier whose BOTH conditions are met. Null when none are. */
export function tierFor(orders: number, subtotal: number): LoyaltyTier | null {
  let out: LoyaltyTier | null = null
  for (const t of LOYALTY_TIERS) if (orders >= t.minOrders && subtotal >= t.minSubtotal) out = t
  return out
}

export function nextTierAfter(t: LoyaltyTier | null): LoyaltyTier | null {
  if (!t) return LOYALTY_TIERS[0]
  const i = LOYALTY_TIERS.findIndex(x => x.key === t.key)
  return i >= 0 && i < LOYALTY_TIERS.length - 1 ? LOYALTY_TIERS[i + 1] : null
}

// ── SEEDED DEMO DATA ────────────────────────────────────────────────────────
// ⚠️ THESE NUMBERS ARE INVENTED. They are NOT read from disco_orders and are
// NOT written anywhere. The real demo account has 18 orders totalling $21.28
// with $0.57 of fees paid, which renders an empty-looking UX — so the figures
// below stand in purely so the layout can be judged.
//
// Nothing outside this file may import DEMO_STATS, and no code path computes a
// real tier: isLoyaltyDemoUser() is the only way any of this renders, and it
// matches exactly one hardcoded address.
export const DEMO_STATS = {
  windowLabel: 'Last 12 months',
  orders: 23,
  subtotal: 14820,
  feesPaid: 444.6,
  savedThisYear: 148.2,
  recent: [
    { name: 'Utopia Bagels',            date: 'Oct 2',  subtotal: 980,  saved: 9.8 },
    { name: 'Apollo Bagels - Kips Bay', date: 'Sep 24', subtotal: 1240, saved: 12.4 },
    { name: 'Bird & Co.',               date: 'Sep 11', subtotal: 760,  saved: 7.6 },
  ],
} as const

export const DEMO_IS_SEEDED = true

const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'

function tierFill(t: LoyaltyTier): string { return t.gradient ?? t.colour }

/** Small status chip — header, nav, and the card header all use this one. */
export function TierChip({ tier, size = 'sm' }: { tier: LoyaltyTier; size?: 'sm' | 'lg' }) {
  const lg = size === 'lg'
  return (
    <span
      title={`${tier.name} member (demo)`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: lg ? 8 : 5,
        background: tierFill(tier), color: '#fff',
        fontSize: lg ? 13 : 10, fontWeight: 800, letterSpacing: '0.06em',
        padding: lg ? '5px 14px' : '2px 9px', borderRadius: 20,
        fontFamily: F, textTransform: 'uppercase', whiteSpace: 'nowrap',
        boxShadow: lg ? '0 2px 10px rgba(0,0,0,0.14)' : 'none',
      }}
    >
      <span aria-hidden style={{ width: lg ? 8 : 6, height: lg ? 8 : 6, borderRadius: '50%', background: 'rgba(255,255,255,0.9)' }} />
      {tier.name}
    </span>
  )
}

/** Nav icon — a filled dot in the tier's colour, matching AmexNavIcon's size. */
export function LoyaltyNavIcon({ tier }: { tier: LoyaltyTier | null }) {
  return (
    <span aria-hidden style={{
      display: 'inline-block', width: 16, height: 16, borderRadius: '50%',
      background: tier ? tierFill(tier) : '#e0e0e0',
      border: tier ? 'none' : '1.5px solid #c9c9c9', flexShrink: 0,
    }} />
  )
}

function Bar({ value, max, fill, label, suffix }: { value: number; max: number; fill: string; label: string; suffix: string }) {
  const pct = Math.max(0, Math.min(100, max > 0 ? (value / max) * 100 : 0))
  const done = value >= max
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ fontSize: 12.5, color: '#585786', fontFamily: F }}>{label}</span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: done ? '#1D9E75' : DARK, fontFamily: F }}>
          {done ? '✓ ' : ''}{suffix}
        </span>
      </div>
      <div style={{ height: 8, borderRadius: 20, background: '#f0f0f0', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: done ? '#1D9E75' : fill, borderRadius: 20, transition: 'width 0.3s' }} />
      </div>
    </div>
  )
}

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
const money2 = (n: number) => `$${n.toFixed(2)}`

/** The portal page body. Tracking + benefits, which is what was asked for. */
export function LoyaltyContent({ firstName }: { firstName?: string }) {
  const { orders, subtotal, feesPaid, savedThisYear, windowLabel, recent } = DEMO_STATS
  const tier = tierFor(orders, subtotal)
  const next = nextTierAfter(tier)
  const card: React.CSSProperties = { background: '#fff', border: '1px solid #eee', borderRadius: 14, padding: 20, marginBottom: 18 }

  return (
    <div style={{ padding: '26px 30px', fontFamily: F, maxWidth: 760 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');`}</style>

      <h1 style={{ fontSize: 22, fontWeight: 800, color: DARK, margin: '0 0 4px', letterSpacing: '-0.02em' }}>Disco Rewards</h1>
      <p style={{ fontSize: 13, color: '#888', margin: '0 0 20px' }}>
        Order more, pay a smaller platform fee. {windowLabel.toLowerCase()}.
      </p>

      {/* STATUS */}
      <div style={{ ...card, background: tier ? tierFill(tier) : '#f7f7fb', border: tier ? 'none' : '1px solid #eee', color: tier ? '#fff' : DARK, padding: 24 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.85, marginBottom: 6 }}>
          {firstName ? `${firstName}'s status` : 'Your status'}
        </div>
        <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 10 }}>
          {tier ? tier.name : 'Not yet a member'}
        </div>
        {tier ? (
          <div style={{ fontSize: 14, opacity: 0.95 }}>
            {tier.feeCutPoints}% off the platform fee on every order · {money2(savedThisYear)} saved so far
          </div>
        ) : (
          <div style={{ fontSize: 14, color: '#585786' }}>
            Reach {LOYALTY_TIERS[0].minOrders} orders and {money(LOYALTY_TIERS[0].minSubtotal)} in a year to unlock Copper.
          </div>
        )}
      </div>

      {/* PROGRESS — both bars, because both conditions must be met */}
      {next && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: DARK }}>Progress to</span>
            <TierChip tier={next} />
          </div>
          <Bar label="Orders" value={orders} max={next.minOrders} fill={tierFill(next)} suffix={`${orders} of ${next.minOrders}`} />
          <Bar label="Order value" value={subtotal} max={next.minSubtotal} fill={tierFill(next)} suffix={`${money(subtotal)} of ${money(next.minSubtotal)}`} />
          <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
            Both are needed to move up — {windowLabel.toLowerCase()}.
          </div>
        </div>
      )}

      {/* THE LADDER */}
      <div style={card}>
        <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 14 }}>Tiers</div>
        {LOYALTY_TIERS.map(t => {
          const earned = !!tier && LOYALTY_TIERS.findIndex(x => x.key === t.key) <= LOYALTY_TIERS.findIndex(x => x.key === tier.key)
          const current = tier?.key === t.key
          return (
            <div key={t.key} style={{
              display: 'flex', alignItems: 'center', gap: 14, padding: '11px 12px', borderRadius: 10,
              background: current ? 'rgba(107,110,249,0.07)' : 'transparent',
              border: current ? '1.5px solid #6466E8' : '1.5px solid transparent', marginBottom: 6,
            }}>
              <span aria-hidden style={{ width: 30, height: 30, borderRadius: '50%', background: tierFill(t), flexShrink: 0, opacity: earned ? 1 : 0.3 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: earned ? DARK : '#999' }}>
                  {t.name}{current ? ' · current' : ''}
                </div>
                <div style={{ fontSize: 12, color: '#888' }}>
                  {t.minOrders} orders and {money(t.minSubtotal)} a year
                </div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 800, color: earned ? DARK : '#bbb', whiteSpace: 'nowrap' }}>
                −{t.feeCutPoints}% fee
              </div>
            </div>
          )
        })}
      </div>

      {/* WHAT IT SAVED */}
      <div style={card}>
        <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 4 }}>Your savings</div>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 14 }}>
          {money2(feesPaid)} in platform fees · {money2(savedThisYear)} saved at your tier
        </div>
        {recent.map(r => (
          <div key={r.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid #f4f4f4', fontSize: 13 }}>
            <span style={{ color: DARK, fontWeight: 600 }}>{r.name}</span>
            <span style={{ color: '#888' }}>{r.date}</span>
            <span style={{ color: '#1D9E75', fontWeight: 700 }}>saved {money2(r.saved)}</span>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 11.5, color: '#aaa', lineHeight: 1.6 }}>
        Demo only — figures are illustrative and no fee is actually reduced.
      </div>
    </div>
  )
}
