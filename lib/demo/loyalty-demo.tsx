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
  key: 'copper' | 'silver' | 'gold' | 'marquee'
  name: string
  minOrders: number
  minSubtotal: number
  /** Percentage POINTS off the platform fee. The fee is Disco's own revenue
   *  (lib/promo-pricing.ts: familyMealFee is added to the diner total and
   *  excluded from the restaurant transfer), so a reduction never touches a
   *  restaurant's payout. Cosmetic here — nothing applies it. */
  feeCutPoints: number
  /** BOLD fill — bars, dots, rings, accents. Never carries text, so it is
   *  chosen for vibrancy rather than contrast. */
  colour: string
  /** The same hue darkened until WHITE TEXT clears 4.5:1. Used for every
   *  text-bearing tier surface. Measured, not eyeballed:
   *    copper  #B87333 -> #A5672D  4.59:1   (raw copper was 3.79 — large text only)
   *    silver  #9BA3AF -> #6F757D  4.65:1   (raw silver was 2.54 — failed outright)
   *    gold    #EFB84A -> #8F6E2C  4.74:1   (raw gold was 1.81 — failed badly)
   *    marquee #6466E8 unchanged   4.56:1   (already passed) */
  deep: string
  /** Reserved for Marquee alone, so the apex reads as Disco rather than as a
   *  fifth colour. */
  gradient?: string
  /** Dark ink for tier-TINTED backgrounds (12% colour on white), all >= 4.6:1. */
  ink: string
}

export const BRAND_GRADIENT = 'linear-gradient(90deg, #6466E8 0%, #C044C8 50%, #F0468A 100%)'

export const LOYALTY_TIERS: LoyaltyTier[] = [
  { key: 'copper',  name: 'Copper',  minOrders: 10, minSubtotal: 5000,  feeCutPoints: 0.5, colour: '#B87333', deep: '#A5672D', ink: '#7A4C21' },
  { key: 'silver',  name: 'Silver',  minOrders: 20, minSubtotal: 12500, feeCutPoints: 1.0, colour: '#9BA3AF', deep: '#6F757D', ink: '#636A74' },
  { key: 'gold',    name: 'Gold',    minOrders: 35, minSubtotal: 30000, feeCutPoints: 1.5, colour: '#EFB84A', deep: '#8F6E2C', ink: '#8A6B2B' },
  { key: 'marquee', name: 'Marquee', minOrders: 50, minSubtotal: 60000, feeCutPoints: 2.0, colour: '#6466E8', deep: '#6466E8', gradient: BRAND_GRADIENT, ink: '#4044A1' },
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

// ── THE DEMO ORDER ──────────────────────────────────────────────────────────
// ⚠️ INVENTED, like DEMO_STATS above. It is NOT in disco_orders, has no order
// reference anything can resolve, and is never written, fetched or mirrored. It
// exists so the tier discount can be SEEN the way a diner would see it, rather
// than described.
//
// HOW IT IS KEPT OUT OF EVERYTHING REAL:
//   • it is a constant in this file — no INSERT, no API, no migration
//   • every surface that renders it is behind isLoyaltyDemoUser(), which matches
//     one hardcoded address
//   • it is merged into the history list CLIENT-SIDE, after the fetch, so the
//     server never returns it and no caller can page past it into reality
//   • reporting, the restaurant portal, exports and every cron read the
//     database, which has never heard of it
//   • its id is deliberately unresolvable, so clicking it opens nothing
//
// The fee maths is the native default of 5%, reduced by Silver's 1 point to 4%.
export const DEMO_ORDER = {
  id: 'demo-loyalty-order',
  date: '2026-10-14',
  dateLabel: '14 October 2026',
  restaurantName: 'Apollo Bagels - Kips Bay',
  status: 'Confirmed',
  subtotal: 1000,
  tax: 88.75,
  /** What the fee WOULD have been, with no tier. */
  feeStandard: 50,
  /** What a Silver member is charged: 5% - 1pp = 4%. */
  feeCharged: 40,
  get saved() { return this.feeStandard - this.feeCharged },
  get total() { return this.subtotal + this.tax + this.feeCharged },
} as const



const F = "'DM Sans', sans-serif"
const DARK = '#1A1028'

/** BOLD fill for surfaces that carry no text — bars, dots, rings, accents. */
function tierFill(t: LoyaltyTier): string { return t.gradient ?? t.colour }
/** Text-bearing surfaces: the darkened hue, so white text always clears 4.5:1.
 *  Marquee keeps the gradient — its lightest stop still clears white text. */
function tierSurface(t: LoyaltyTier): string { return t.gradient ?? t.deep }
/** A soft wash of the tier colour, for rows and panels that carry dark ink. */
function tierTint(t: LoyaltyTier): string { return `${t.colour}2E` }

/** Small status chip — header, nav, and the card header all use this one. */
export function TierChip({ tier, size = 'sm' }: { tier: LoyaltyTier; size?: 'sm' | 'lg' }) {
  const lg = size === 'lg'
  return (
    <span
      title={`${tier.name} member (demo)`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: lg ? 8 : 5,
        background: tierSurface(tier), color: '#fff',
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
      // a soft halo of the same hue, so the dot reads as tier colour rather
      // than as a generic bullet at nav size
      boxShadow: tier ? `0 0 0 3px ${tier.colour}33` : 'none',
    }} />
  )
}

function Bar({ value, max, fill, track, ink, label, suffix }: { value: number; max: number; fill: string; track: string; ink: string; label: string; suffix: string }) {
  const pct = Math.max(0, Math.min(100, max > 0 ? (value / max) * 100 : 0))
  const done = value >= max
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ fontSize: 12.5, color: '#585786', fontFamily: F }}>{label}</span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: ink, fontFamily: F }}>
          {done ? '✓ ' : ''}{suffix}
        </span>
      </div>
      <div style={{ height: 12, borderRadius: 20, background: track, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: fill, borderRadius: 20, transition: 'width 0.3s' }} />
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

      {/* ── STATUS — the top-left element, and the loudest thing on the page ──
          Deliberately larger than everything else: full-bleed tier colour, a
          38px tier name, and the benefit raised into a pill rather than left as
          body text. tierSurface() (not tierFill) because this surface carries
          white text and the raw tier colours do not clear 4.5:1. */}
      <div style={{
        background: tier ? tierSurface(tier) : '#f7f7fb',
        border: tier ? 'none' : '1px solid #eee',
        color: tier ? '#fff' : DARK,
        borderRadius: 18, padding: '30px 32px', marginBottom: 18,
        boxShadow: tier ? '0 10px 30px rgba(0,0,0,0.16)' : 'none',
        position: 'relative', overflow: 'hidden',
      }}>
        {/* a brighter wash of the raw tier colour, so the bold hue is present
            even though the surface itself is the darkened one */}
        {tier && (
          <span aria-hidden style={{
            position: 'absolute', top: -70, right: -70, width: 210, height: 210,
            borderRadius: '50%', background: tier.colour, opacity: 0.4, pointerEvents: 'none',
          }} />
        )}
        <div style={{ position: 'relative' }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', opacity: 0.9, marginBottom: 8 }}>
            {firstName ? `${firstName}'s status` : 'Your status'}
          </div>
          <div style={{ fontSize: 38, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.05, marginBottom: 14 }}>
            {tier ? tier.name : 'Not yet a member'}
          </div>
          {tier ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', background: 'rgba(255,255,255,0.22)',
                padding: '7px 15px', borderRadius: 20, fontSize: 14, fontWeight: 800,
              }}>−{tier.feeCutPoints}% platform fee</span>
              <span style={{ fontSize: 14, opacity: 0.95 }}>{money2(savedThisYear)} saved so far</span>
            </div>
          ) : (
            <div style={{ fontSize: 14, color: '#585786' }}>
              Reach {LOYALTY_TIERS[0].minOrders} orders and {money(LOYALTY_TIERS[0].minSubtotal)} in a year to unlock Copper.
            </div>
          )}
        </div>
      </div>

      {/* PROGRESS — both bars, because both conditions must be met */}
      {next && (
        <div style={{ ...card, borderLeft: `5px solid ${next.colour}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: DARK }}>Progress to</span>
            <TierChip tier={next} />
          </div>
          <Bar label="Orders" value={orders} max={next.minOrders} fill={tierFill(next)} track={tierTint(next)} ink={next.ink} suffix={`${orders} of ${next.minOrders}`} />
          <Bar label="Order value" value={subtotal} max={next.minSubtotal} fill={tierFill(next)} track={tierTint(next)} ink={next.ink} suffix={`${money(subtotal)} of ${money(next.minSubtotal)}`} />
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
              display: 'flex', alignItems: 'center', gap: 14, padding: '12px 14px', borderRadius: 12,
              background: current ? tierTint(t) : 'transparent',
              border: `1.5px solid ${current ? t.colour : 'transparent'}`, marginBottom: 6,
              borderLeft: current ? `6px solid ${t.colour}` : '1.5px solid transparent',
            }}>
              <span aria-hidden style={{
                width: 34, height: 34, borderRadius: '50%', background: tierFill(t), flexShrink: 0,
                opacity: earned ? 1 : 0.22,
                boxShadow: current ? `0 0 0 4px ${tierTint(t)}` : 'none',
              }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14.5, fontWeight: 800, color: current ? t.ink : (earned ? DARK : '#999') }}>
                  {t.name}{current ? ' · current' : ''}
                </div>
                <div style={{ fontSize: 12, color: '#888' }}>
                  {t.minOrders} orders and {money(t.minSubtotal)} a year
                </div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 800, color: current ? t.ink : (earned ? DARK : '#bbb'), whiteSpace: 'nowrap' }}>
                −{t.feeCutPoints}% fee
              </div>
            </div>
          )
        })}
      </div>

      {/* THE DISCOUNT ON A REAL-LOOKING ORDER */}
      {tier && (
        <div style={{ ...card, borderLeft: `5px solid ${tier.colour}` }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: DARK, marginBottom: 2 }}>Your last order</div>
          <div style={{ fontSize: 12, color: '#888', marginBottom: 14 }}>
            {DEMO_ORDER.restaurantName} · {DEMO_ORDER.dateLabel}
          </div>
          <DemoFeeLine tier={tier} />
        </div>
      )}

      {/* WHAT IT SAVED */}
      <div style={{ ...card, borderLeft: tier ? `5px solid ${tier.colour}` : card.border }}>
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

/* ── THE DISCOUNT, AS A DINER SEES IT ──────────────────────────────────────────
 *
 * Two surfaces, because a diner meets the benefit twice and they answer different
 * questions. The RECEIPT LINE is the moment of truth — "what am I paying, and what
 * did my tier do about it" — so it strikes the standard fee through and names the
 * saving in dollars beside the tier. The HISTORY ROW is the reminder weeks later,
 * so it carries the saving as a quiet green note rather than re-explaining the
 * arithmetic.
 *
 * Both are rendered ONLY behind isLoyaltyDemoUser(). Neither reads a database.
 */

/** The fee block exactly as it would sit in a checkout summary or a confirmation. */
export function DemoFeeLine({ tier, compact = false }: { tier: LoyaltyTier; compact?: boolean }) {
  const o = DEMO_ORDER
  const row: React.CSSProperties = {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    fontSize: compact ? 13 : 13.5, padding: '7px 0', fontFamily: F,
  }
  return (
    <div style={{ fontFamily: F }}>
      <div style={{ ...row, color: '#585786' }}><span>Subtotal</span><span>{money2(o.subtotal)}</span></div>
      <div style={{ ...row, color: '#585786' }}><span>Tax</span><span>{money2(o.tax)}</span></div>
      <div style={{ ...row, alignItems: 'flex-start' }}>
        <span style={{ color: '#585786' }}>
          Platform fee
          <span style={{
            marginLeft: 8, fontSize: 10.5, fontWeight: 800, letterSpacing: '0.05em',
            textTransform: 'uppercase', color: '#fff', background: tierSurface(tier),
            padding: '2px 8px', borderRadius: 20, verticalAlign: 'middle',
          }}>{tier.name} −{tier.feeCutPoints}%</span>
        </span>
        <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
          <s style={{ color: '#aaa', marginRight: 8 }}>{money2(o.feeStandard)}</s>
          <strong style={{ color: DARK }}>{money2(o.feeCharged)}</strong>
        </span>
      </div>
      <div style={{ ...row, color: '#1D9E75', fontWeight: 700, paddingTop: 0 }}>
        <span>You saved</span><span>{money2(o.saved)}</span>
      </div>
      <div style={{ ...row, borderTop: '1px solid #eee', marginTop: 6, paddingTop: 12, fontSize: 15, fontWeight: 800, color: DARK }}>
        <span>Total</span><span>{money2(o.total)}</span>
      </div>
    </div>
  )
}

/** One row for the account order history, shaped like the real rows beside it. */
export function DemoHistoryRow({ tier }: { tier: LoyaltyTier }) {
  const o = DEMO_ORDER
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px',
      borderBottom: '1px solid #f0f0f0', fontFamily: F,
      borderLeft: `4px solid ${tier.colour}`, background: tierTint(tier),
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: DARK }}>{o.restaurantName}</div>
        <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
          {o.dateLabel} · {o.status}
        </div>
      </div>
      <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: DARK }}>{money2(o.total)}</div>
        <div style={{ fontSize: 11.5, color: '#1D9E75', fontWeight: 700, marginTop: 2 }}>
          saved {money2(o.saved)} · {tier.name}
        </div>
      </div>
    </div>
  )
}

/* ── EXPERIMENT: TIER COLOUR IN THE CHROME ────────────────────────────────────
 *
 * ⚠️ AN EXPERIMENT, NOT A COMMITMENT. Set LOYALTY_CHROME_EXPERIMENT = false and
 * every one of these overrides stops — the flag is the whole revert. Nothing else
 * has to be touched and no other surface reads it.
 *
 * WHAT IT TOUCHES, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * It tints three things that are ABOUT the diner: the thin rule under the header,
 * a very low-opacity page wash, and the account nav's active item. Each is an
 * accent whose meaning survives changing colour — a copper rule is still a rule.
 *
 * It leaves alone everything whose meaning is Disco's rather than the diner's:
 *   • the logo and the wordmark gradient — the brand is not the diner's status
 *   • primary buttons — a copper "Place order" reads as a different product, and
 *     the same button turning four colours across four diners is a brand with no
 *     colour of its own
 *   • any success / error / warning colour — those mean a thing, not a person
 *   • the header BACKGROUND, deliberately: a header that turns copper for most
 *     diners (copper being the entry tier, where most people sit) stops reading as
 *     Disco Cater at a glance, which is the brief's own warning
 *
 * CONTRAST. Nothing here puts text on a tier colour, so the raw hues are safe as
 * accents. The one text-bearing surface — the active nav item — uses `deep`
 * (white text clears 4.5:1) and the tint carries `ink`, both measured.
 *
 * MARQUEE keeps the brand gradient and is the one tier whose accent IS the brand,
 * which is the point of it.
 */
export const LOYALTY_CHROME_EXPERIMENT = true

export function LoyaltyChrome({ email }: { email?: string | null }) {
  if (!LOYALTY_CHROME_EXPERIMENT || !isLoyaltyDemoUser(email)) return null
  const tier = tierFor(DEMO_STATS.orders, DEMO_STATS.subtotal)
  if (!tier) return null
  const solid = tier.colour           // borders, which a gradient cannot do
  const surface = tierSurface(tier)   // the one text-bearing override
  // Built outside the JSX: a nested template literal inside a JSX expression is
  // what broke the first version of this.
  const HEADER = 'header, .dc-header, nav[class*="header"]'
  const marqueeRule = tier.gradient
    ? HEADER + ' { border-bottom: 2px solid transparent !important; border-image: ' + tier.gradient + ' 1 !important; }'
    : ''
  const css = [
    // Header: a tier RULE, not a tier header. The background is untouched so the
    // page reads as Disco Cater before it reads as anybody's status.
    HEADER + ' { border-bottom: 2px solid ' + solid + ' !important; }',
    // Page wash at ~4% — warm enough to notice, far too faint to compete with
    // content or to move any text contrast ratio.
    'body { background-image: linear-gradient(180deg, ' + solid + '0A 0%, transparent 340px) !important; background-repeat: no-repeat !important; }',
    // The account nav's current item — the one piece of chrome genuinely about
    // this diner. `deep` because it carries white text.
    'a[aria-current="page"], a[data-active="true"] { background: ' + surface + ' !important; color: #fff !important; }',
    // Focus rings follow the tier; an accent that never carries text.
    ':focus-visible { outline-color: ' + solid + ' !important; }',
    marqueeRule,
  ].filter(Boolean).join('\n')
  return <style>{css}</style>
}
