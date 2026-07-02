import { sql } from './db'

// ── Restaurant-funded promo settlement gate ───────────────────────────────────
// Restaurant-funded codes settle by refunding the customer WITH reverse_transfer
// (pulling the discount back out of the restaurant's Stripe destination transfer,
// so the RESTAURANT absorbs it). That only works under FM moneyFlow=DIRECT, where
// the charge is a destination charge with a transfer to reverse. Under FAMILY_MEAL
// the platform holds the funds and pays out manually — there is no Stripe transfer
// to reverse — so restaurant-funded settlement is NOT safe there.
//
// This flag gates the whole restaurant-funded path for REAL MONEY. While it is off
// (default), restaurant-funded codes are fully creatable/manageable in the portal,
// but the customer checkout treats them as not-yet-active so no discount is ever
// applied or settled. Flip PROMO_RESTAURANT_FUNDED_LIVE=true only after the
// reverse_transfer settlement is empirically confirmed in Stripe test mode.
export const RESTAURANT_FUNDED_PROMOS_LIVE = process.env.PROMO_RESTAURANT_FUNDED_LIVE === 'true'

export type MoneyFlow = 'DIRECT' | 'FAMILY_MEAL'

// Disco-side mirror of FM's per-restaurant moneyFlow, written by the money-flow
// PUT route. NULL when never set — FM's own default is DIRECT, so we treat NULL as
// DIRECT-eligible (a restaurant that has never toggled the "hold payments" switch).
export async function getRestaurantMoneyFlow(restaurantRef: string): Promise<MoneyFlow | null> {
  const ref = (restaurantRef || '').trim()
  if (!ref) return null
  try {
    const rows = (await sql`
      SELECT money_flow FROM disco_restaurant_overrides WHERE restaurant_reference = ${ref} LIMIT 1
    `) as { money_flow: string | null }[]
    const mf = rows[0]?.money_flow
    return mf === 'FAMILY_MEAL' ? 'FAMILY_MEAL' : mf === 'DIRECT' ? 'DIRECT' : null
  } catch {
    return null // overrides table / column not migrated yet
  }
}

// A restaurant-funded discount can only settle correctly (restaurant absorbs it)
// when the live flag is on AND the restaurant is on DIRECT money flow. NULL money
// flow counts as DIRECT (FM default). Used by both /api/promo/validate (to decide
// whether to apply the discount at checkout) and /api/promo/redeem (to decide
// whether reverse_transfer is safe).
export function canRestaurantFundedSettle(moneyFlow: MoneyFlow | null): boolean {
  return RESTAURANT_FUNDED_PROMOS_LIVE && moneyFlow !== 'FAMILY_MEAL'
}
