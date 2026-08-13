// M4 — marketplace drop-off guard (report-only).
//
// Single place that encodes the marketplace VISIBILITY rule as an evaluation,
// mirroring the live public feed in app/api/restaurants/route.ts. Kept PURE (no
// DB, no server-only imports) so it runs both server-side (the admin readiness
// endpoint) and client-side (the admin ordering table's per-row warning).
//
// The rule it mirrors (see app/api/restaurants/route.ts:41-49):
//   • FM-backed:    visible AND stripe_connected                       (2-part)
//   • Disco-native: visible AND COALESCE(online_ordering_enabled,true) (3-part)
//                   AND (stripe_connected OR a completed native Stripe account)
//
// The drop-off risk: an FM-backed restaurant that is currently visible under the
// 2-part rule can SILENTLY disappear the moment is_disco_native flips true, because
// the stricter 3-part rule then applies. This module reports that risk; it never
// changes state. If either rule changes in route.ts, update it here too.

export interface MarketplaceVisibilityInput {
  isDiscoNative: boolean
  visible: boolean
  // disco_restaurant_overrides.stripe_connected
  stripeConnected: boolean
  // Raw disco_restaurant_overrides.online_ordering_enabled — null = unset. The
  // native feed uses COALESCE(...,true), so only an EXPLICIT false gates.
  onlineOrderingEnabled: boolean | null
  // A disco_restaurant_accounts row with a stripe_account_id AND
  // stripe_onboarding_complete = true (native Stripe branch of the feed).
  hasCompletedNativeStripeAccount: boolean
}

export type MarketplaceBlockerCode = 'not-visible' | 'online-ordering-off' | 'stripe-not-connected'

export interface MarketplaceBlocker {
  code: MarketplaceBlockerCode
  message: string
}

export interface MarketplaceReadiness {
  // Visible right now under the FM-backed 2-part rule.
  currentlyVisibleAsFm: boolean
  // Would remain visible under the Disco-native 3-part rule after a flip.
  wouldBeVisibleAsNative: boolean
  // The silent-drop-off case: visible today, but hidden the instant it goes native.
  wouldDropOff: boolean
  // Reasons the NATIVE rule fails (empty when it would stay visible).
  blockers: MarketplaceBlocker[]
}

export function evaluateMarketplaceReadiness(i: MarketplaceVisibilityInput): MarketplaceReadiness {
  // KNOWN GAP, not fixed here (2026-08-13): for an is_disco_native restaurant,
  // i.stripeConnected (disco_restaurant_overrides.stripe_connected) is NOT a
  // valid payout signal. Every restaurant converted via convertToNative
  // inherits stripe_connected=true from the one-time historical FM migration
  // (scripts/migrate-fm-to-neon.ts, which set it true for anyone with ANY
  // stripe_account_id on FM's side, no capability check) — it answers "can FM
  // process this restaurant's payments," which is the CORRECT and only signal
  // for the FM-backed 642-restaurant population this OR also serves, but it's
  // the wrong question once a restaurant is native. hasCompletedNativeStripeAccount
  // is the only signal that's actually meaningful post-conversion. Confirmed via
  // a live audit: only 1 native restaurant (a non-visible test fixture) is
  // currently exploiting this — no real, visible native restaurant is affected
  // today — but this OR will misfire again as more restaurants convert with a
  // stale inherited true and no real account imported yet. Left as-is
  // deliberately: fixing it (e.g. an AND for native, or a separate native-only
  // check) needs its own decision, not a silent behavior change bundled into
  // an unrelated fix.
  const stripeOkNative = i.stripeConnected === true || i.hasCompletedNativeStripeAccount === true
  // COALESCE(online_ordering_enabled, true): null/unset defaults ON; only false gates.
  const onlineOk = i.onlineOrderingEnabled !== false
  const visibleOk = i.visible === true

  const wouldBeVisibleAsNative = visibleOk && onlineOk && stripeOkNative
  const currentlyVisibleAsFm = i.isDiscoNative === false && visibleOk && i.stripeConnected === true

  const blockers: MarketplaceBlocker[] = []
  if (!visibleOk) blockers.push({ code: 'not-visible', message: 'Marketplace visibility is off — turn on “Disco Cater Marketplace” for this restaurant.' })
  if (!onlineOk) blockers.push({ code: 'online-ordering-off', message: 'Online ordering is off — the Disco-native marketplace requires it on. Enable “Accept online orders” before switching.' })
  if (!stripeOkNative) blockers.push({ code: 'stripe-not-connected', message: 'Stripe isn’t recorded as connected for a Disco-native account — finish Stripe onboarding before switching.' })

  return {
    currentlyVisibleAsFm,
    wouldBeVisibleAsNative,
    wouldDropOff: currentlyVisibleAsFm && !wouldBeVisibleAsNative,
    blockers,
  }
}
