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
