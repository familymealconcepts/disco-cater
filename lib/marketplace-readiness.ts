// M4 — server-side marketplace readiness check (report-only). Pulls the exact
// fields the public feed reads and runs them through the pure evaluator, so any
// flip process / future M3 conversion tooling can ask "would this restaurant drop
// off the marketplace if switched to Disco-native?" before flipping. Never mutates.
import { sql, runMigrations } from './db'
import { evaluateMarketplaceReadiness, type MarketplaceReadiness } from './marketplace-visibility'
import { stripeReadySql } from './stripe-readiness'

export interface MarketplaceReadinessResult extends MarketplaceReadiness {
  restaurantReference: string
  found: boolean
  name: string | null
  isDiscoNative: boolean
}

export async function checkMarketplaceReadiness(ref: string): Promise<MarketplaceReadinessResult> {
  await runMigrations()
  // restaurant_reference is TEXT in disco_restaurant_cache / _overrides / _accounts
  // (no ::uuid cast — matches app/api/restaurants/route.ts).
  const rows = (await sql`
    SELECT c.name, c.is_disco_native, o.visible, o.stripe_connected, o.online_ordering_enabled,
           (${sql.unsafe(stripeReadySql('o'))}) OR EXISTS (
             SELECT 1 FROM disco_restaurant_accounts a
             JOIN disco_restaurant_overrides o2 ON o2.restaurant_reference = a.restaurant_reference
             WHERE a.fm_restaurant_reference = c.restaurant_reference
               AND ${sql.unsafe(stripeReadySql('o2'))}
           ) AS has_completed_native_stripe
    FROM disco_restaurant_cache c
    LEFT JOIN disco_restaurant_overrides o ON o.restaurant_reference = c.restaurant_reference
    WHERE c.restaurant_reference = ${ref}
    LIMIT 1
  `) as {
    name: string | null; is_disco_native: boolean | null; visible: boolean | null
    stripe_connected: boolean | null; online_ordering_enabled: boolean | null
    has_completed_native_stripe: boolean
  }[]

  const row = rows[0]
  const isDiscoNative = row?.is_disco_native ?? false
  const readiness = evaluateMarketplaceReadiness({
    isDiscoNative,
    visible: row?.visible === true,
    stripeConnected: row?.stripe_connected === true,
    onlineOrderingEnabled: row?.online_ordering_enabled ?? null,
    hasCompletedNativeStripeAccount: row?.has_completed_native_stripe === true,
  })

  return { restaurantReference: ref, found: !!row, name: row?.name ?? null, isDiscoNative, ...readiness }
}
