// Native go-live gate — the ordered, verify-before-live checklist a restaurant must
// pass before a real customer can order + pay + (if applicable) get dispatched
// entirely through Disco-native. Steps 3 & 4 are REAL-ACTION verifications (a live
// $1 charge that settles; a real signed Expedite dispatch) — they can't be inferred
// passively, so they're recorded via recordGoLiveVerification once actually done.
//
// Order (strict — the first failing gate blocks the rest):
//   1 native-menu       a visible menu with items exists
//   2 stripe-onboarded  LIVE check: charges_enabled && transfers active (not assumed)
//   3 live-charge        a real live-mode $1 native charge actually settled (recorded)
//   4 expedite-dispatch  IF 3P delivery: one real signed Expedite dispatch succeeded (recorded)
//   5 online-ordering    online_ordering_enabled = true
//   6 marketplace-gate   would pass the M4 3-part visibility rule once flipped visible
//   7 closed-days-reviewed  an FM conversion with zero closed-days rows is unreviewed —
//                           block until a real row exists (automated carry-over,
//                           manual entry, or a native-first restaurant with nothing
//                           to carry over in the first place)
//   8 promo-codes-reviewed  same shape as gate 7, for promo_codes — an FM
//                           conversion with zero rows is unreviewed
//   9 flip               goLiveNativeRestaurant — only when 1–8 pass
import type Stripe from 'stripe'
import { sql, runDiscoMenuMigrations } from './db'
import { verifyAccountReusable } from './stripe-connect'
import { checkMarketplaceReadiness } from './marketplace-readiness'

let ensured = false
async function ensureTable(): Promise<void> {
  if (ensured) return
  await sql`
    CREATE TABLE IF NOT EXISTS disco_go_live_verifications (
      id SERIAL PRIMARY KEY,
      restaurant_reference TEXT NOT NULL,
      check_key TEXT NOT NULL,
      passed BOOLEAN NOT NULL DEFAULT true,
      detail TEXT,
      verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (restaurant_reference, check_key)
    )`
  ensured = true
}

export type GoLiveGateKey = 'native-menu' | 'stripe-onboarded' | 'live-charge' | 'expedite-dispatch' | 'online-ordering' | 'marketplace-gate' | 'closed-days-reviewed' | 'promo-codes-reviewed'
export interface GoLiveGate { key: GoLiveGateKey; step: number; label: string; done: boolean; blocking: boolean; detail: string; action?: string }
export interface GoLiveReadiness {
  restaurantReference: string; found: boolean; isDiscoNative: boolean; live: boolean
  offersThirdPartyDelivery: boolean
  gates: GoLiveGate[]
  readyToFlip: boolean
  firstBlocker?: GoLiveGateKey
}

// Record a real-action verification (step 3 live charge, step 4 Expedite dispatch).
export async function recordGoLiveVerification(ref: string, key: 'live-charge' | 'expedite-dispatch', passed: boolean, detail: string): Promise<void> {
  await ensureTable()
  await sql`
    INSERT INTO disco_go_live_verifications (restaurant_reference, check_key, passed, detail, verified_at)
    VALUES (${ref}, ${key}, ${passed}, ${detail}, NOW())
    ON CONFLICT (restaurant_reference, check_key) DO UPDATE SET passed = ${passed}, detail = ${detail}, verified_at = NOW()`
}

async function verificationPassed(ref: string, key: string): Promise<{ passed: boolean; detail: string | null }> {
  const rows = (await sql`SELECT passed, detail FROM disco_go_live_verifications WHERE restaurant_reference = ${ref} AND check_key = ${key} LIMIT 1`.catch(() => [])) as { passed: boolean; detail: string | null }[]
  return rows.length ? { passed: rows[0].passed, detail: rows[0].detail } : { passed: false, detail: null }
}

async function storedAccountId(ref: string): Promise<string | null> {
  const direct = (await sql`
    SELECT stripe_account_id FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref} AND stripe_account_id IS NOT NULL LIMIT 1
  `.catch(() => [])) as { stripe_account_id: string | null }[]
  if (direct.length) return direct[0].stripe_account_id
  // Translate an FM reference to its Disco restaurant_reference, then check that.
  const viaFm = (await sql`
    SELECT o.stripe_account_id FROM disco_restaurant_accounts a
    JOIN disco_restaurant_overrides o ON o.restaurant_reference = a.restaurant_reference
    WHERE a.fm_restaurant_reference = ${ref} AND o.stripe_account_id IS NOT NULL LIMIT 1
  `.catch(() => [])) as { stripe_account_id: string | null }[]
  return viaFm[0]?.stripe_account_id ?? null
}

export async function checkNativeGoLiveReadiness(ref: string, opts?: { stripe?: Stripe }): Promise<GoLiveReadiness> {
  await runDiscoMenuMigrations(); await ensureTable()

  const cache = (await sql`SELECT is_disco_native, is_live FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1`) as { is_disco_native: boolean | null; is_live: boolean | null }[]
  const found = cache.length > 0
  const isDiscoNative = cache[0]?.is_disco_native === true

  // 1 — native menu with items
  const menu = (await sql`
    SELECT COUNT(*)::int AS n FROM disco_menu_items i
    WHERE i.restaurant_reference = ${ref}::uuid AND i.visible = true
      AND EXISTS (SELECT 1 FROM disco_menu_categories c JOIN disco_menus mn ON mn.reference = c.menu_reference
                  WHERE c.reference = i.category_reference AND mn.visible = true AND mn.archived = false)
  `.catch(() => [{ n: 0 }])) as { n: number }[]
  const hasMenu = (menu[0]?.n ?? 0) > 0

  // Does any visible menu offer THIRD_PARTY delivery? (drives whether gate 4 applies)
  const tp = (await sql`
    SELECT COUNT(*)::int AS n FROM disco_menus
    WHERE restaurant_reference = ${ref}::uuid AND visible = true AND archived = false
      AND (delivery_settings->>'method') = 'THIRD_PARTY'
  `.catch(() => [{ n: 0 }])) as { n: number }[]
  const offersThirdPartyDelivery = (tp[0]?.n ?? 0) > 0

  // 2 — Stripe onboarding, LIVE (not the stored flag): charges_enabled && transfers active
  const acctId = await storedAccountId(ref)
  let stripeDone = false, stripeDetail = 'No Stripe account linked — onboard or import a charge-capable account.'
  if (acctId) {
    const chk = await verifyAccountReusable(acctId, opts?.stripe)
    stripeDone = chk.reusable
    stripeDetail = chk.reusable
      ? `LIVE-verified charge-capable (${acctId}).`
      : `Account ${acctId} NOT charge-capable: ${chk.reason}`
  }

  // 3 — real live-mode $1 native charge settled (recorded action)
  const lc = await verificationPassed(ref, 'live-charge')
  // 4 — real Expedite dispatch (recorded action) — only when 3P delivery is offered
  const ed = await verificationPassed(ref, 'expedite-dispatch')

  // 5 — online ordering on
  const ov = (await sql`SELECT online_ordering_enabled, stripe_connected FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref} LIMIT 1`.catch(() => [])) as { online_ordering_enabled: boolean | null; stripe_connected: boolean | null }[]
  const onlineOn = ov[0]?.online_ordering_enabled === true

  // 6 — would pass the M4 marketplace 3-part rule once visible is flipped on.
  // (checkMarketplaceReadiness needs visible=true; here we check the non-visibility
  // components — online ordering + Stripe — since the flip sets visible itself.)
  const mk = await checkMarketplaceReadiness(ref)
  const marketplaceOk = onlineOn && (mk.blockers.every(b => b.code === 'not-visible'))

  // 7 — closed-days reviewed. Derived from live state (like the notification-
  // settings admin badge), not the closed_days_flagged_at audit column, so this
  // is correct even for restaurants converted before that column existed (Glen
  // Rock, Elmwood Park, etc.) — a zero-rows FM conversion is unreviewed
  // regardless of whether anything ever flagged it. A restaurant with no FM
  // history (native-first — e.g. Almost Home) never had anything to carry over,
  // so it's trivially reviewed. Passes the moment ANY real row exists — the
  // automated carry-over succeeding, or a manual fix like Glen Rock's.
  const fmLink = (await sql`
    SELECT 1 FROM disco_restaurant_accounts
    WHERE (restaurant_reference = ${ref} OR fm_restaurant_reference = ${ref}) AND fm_restaurant_reference IS NOT NULL
    LIMIT 1
  `.catch(() => [])) as unknown[]
  const wasFmBacked = fmLink.length > 0
  const closedDaysRows = (await sql`
    SELECT COUNT(*)::int AS n FROM disco_restaurant_closed_days WHERE restaurant_reference::text = ${ref}
  `.catch(() => [{ n: 0 }])) as { n: number }[]
  const closedDaysReviewed = !wasFmBacked || (closedDaysRows[0]?.n ?? 0) > 0

  // 8 — promo codes reviewed. Same derivation as gate 7, for the same reason:
  // an FM conversion with zero promo_codes rows is unreviewed, not confirmed
  // to have none — a customer with a real FM code (e.g. Glen Rock's FRAN10)
  // would otherwise get "invalid code" with no signal anything's wrong.
  const promoCodeRows = (await sql`
    SELECT COUNT(*)::int AS n FROM promo_codes WHERE restaurant_ref = ${ref}
  `.catch(() => [{ n: 0 }])) as { n: number }[]
  const promoCodesReviewed = !wasFmBacked || (promoCodeRows[0]?.n ?? 0) > 0

  const gates: GoLiveGate[] = [
    { key: 'native-menu', step: 1, label: 'Native menu imported', done: hasMenu, blocking: true, detail: hasMenu ? 'A visible menu with items exists.' : 'No visible menu with items — run the faithful FM import.', action: hasMenu ? undefined : 'POST /api/admin/restaurants/[ref]/import-fm-menu' },
    { key: 'stripe-onboarded', step: 2, label: 'Stripe onboarding complete (LIVE-verified)', done: stripeDone, blocking: true, detail: stripeDetail, action: stripeDone ? undefined : 'Complete Stripe onboarding (KYC) or reuse a charge-capable account, then re-check.' },
    { key: 'live-charge', step: 3, label: 'Real live-mode $1 native charge settled', done: lc.passed, blocking: true, detail: lc.passed ? `Verified: ${lc.detail || 'settled'}.` : 'Not yet verified — place a real live-mode native order and confirm it settles into the connected account.', action: lc.passed ? undefined : 'Run a real live-mode $1 native order; on success call recordGoLiveVerification(ref, "live-charge", ...).' },
    { key: 'expedite-dispatch', step: 4, label: offersThirdPartyDelivery ? 'Real Expedite courier dispatch succeeded' : 'Expedite dispatch (N/A — no 3P delivery)', done: offersThirdPartyDelivery ? ed.passed : true, blocking: offersThirdPartyDelivery, detail: !offersThirdPartyDelivery ? 'Restaurant does not offer third-party delivery — not required.' : ed.passed ? `Verified: ${ed.detail || 'dispatched'}.` : 'Not yet verified — a real signed Expedite dispatch has never succeeded for this restaurant.', action: (!offersThirdPartyDelivery || ed.passed) ? undefined : 'Place a real 3P-delivery native order; confirm a courier is dispatched; call recordGoLiveVerification(ref, "expedite-dispatch", ...).' },
    { key: 'online-ordering', step: 5, label: 'Online ordering on', done: onlineOn, blocking: true, detail: onlineOn ? 'Accepting online orders.' : 'Turn on online ordering.', action: onlineOn ? undefined : 'Enable online_ordering_enabled.' },
    { key: 'marketplace-gate', step: 6, label: 'Passes marketplace visibility rule (M4)', done: marketplaceOk, blocking: true, detail: marketplaceOk ? 'Will be visible once flipped live.' : `Would fail the native visibility rule: ${mk.blockers.filter(b => b.code !== 'not-visible').map(b => b.message).join(' ') || 'online ordering / Stripe.'}`, action: marketplaceOk ? undefined : 'Resolve online ordering + Stripe first.' },
    { key: 'closed-days-reviewed', step: 7, label: 'Closed-days / holiday config reviewed', done: closedDaysReviewed, blocking: true, detail: closedDaysReviewed ? (wasFmBacked ? `${closedDaysRows[0]?.n ?? 0} closed-day row(s) on file.` : 'Native-first — no FM closed-days to carry over.') : 'FM-converted with ZERO closed-days on file — an unreviewed gap, not a confirmed "no closures." Enter the restaurant\'s real holidays/closed dates before going live.', action: closedDaysReviewed ? undefined : 'Enter the real FM closed-days/holidays into Schedule Override (app/api/restaurant/disco-closed-days), or re-run carryOverClosedDays if FM access ever opens up.' },
    { key: 'promo-codes-reviewed', step: 8, label: 'Promo codes reviewed', done: promoCodesReviewed, blocking: true, detail: promoCodesReviewed ? (wasFmBacked ? `${promoCodeRows[0]?.n ?? 0} promo code(s) on file.` : 'Native-first — no FM promo codes to carry over.') : 'FM-converted with ZERO promo codes on file — an unreviewed gap, not a confirmed "no codes." Enter the restaurant\'s real promo codes before going live.', action: promoCodesReviewed ? undefined : 'Enter the real FM promo codes into Promo Codes (app/api/restaurant/promo-codes), or re-run carryOverPromoCodes if FM access ever opens up.' },
  ]

  const blocking = gates.filter(g => g.blocking)
  const readyToFlip = found && isDiscoNative && blocking.every(g => g.done)
  const firstBlocker = blocking.find(g => !g.done)?.key

  return { restaurantReference: ref, found, isDiscoNative, live: cache[0]?.is_live === true, offersThirdPartyDelivery, gates, readyToFlip, firstBlocker }
}

export interface GoLiveResult { flipped: boolean; reason?: string; readiness: GoLiveReadiness }

// Step 7 — flip the restaurant LIVE (visible + online + is_live). ONLY when every
// gate passes. This is the single point where a real customer can start ordering.
export async function goLiveNativeRestaurant(ref: string, opts?: { stripe?: Stripe }): Promise<GoLiveResult> {
  const readiness = await checkNativeGoLiveReadiness(ref, opts)
  if (!readiness.found) return { flipped: false, reason: 'Restaurant not found.', readiness }
  if (!readiness.isDiscoNative) return { flipped: false, reason: 'Not Disco-native — convert it first.', readiness }
  if (!readiness.readyToFlip) {
    const failing = readiness.gates.filter(g => g.blocking && !g.done).map(g => `#${g.step} ${g.label}`).join('; ')
    return { flipped: false, reason: `Go-live gate not passed — resolve: ${failing}.`, readiness }
  }
  await sql`INSERT INTO disco_restaurant_overrides (restaurant_reference, visible, online_ordering_enabled, updated_at)
            VALUES (${ref}, true, true, NOW())
            ON CONFLICT (restaurant_reference) DO UPDATE SET visible = true, online_ordering_enabled = true, updated_at = NOW()`
  await sql`UPDATE disco_restaurant_cache SET is_live = true, cached_at = NOW() WHERE restaurant_reference = ${ref}`
  return { flipped: true, readiness: { ...readiness, live: true } }
}
