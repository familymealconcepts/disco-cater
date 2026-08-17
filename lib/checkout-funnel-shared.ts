// Stage names + ordering for native checkout funnel capture. Zero imports —
// safe to pull into 'use client' components (RestaurantClient/CheckoutDrawer)
// AND the server-only DB writer (lib/checkout-funnel.ts) without dragging the
// Neon driver into a browser bundle.
//
// CHECKOUT_READY and ITEM_ADDED intentionally don't split further ("cart
// modified" isn't its own stage): both fire from the same "cart has content"
// funnel position, just with a refreshed cart_value_cents/item_count snapshot
// — a customer bouncing quantities up and down is still one stage, one row.
export type FunnelStage =
  | 'DATE_TIME_SELECTED'
  | 'ITEM_ADDED'
  | 'CHECKOUT_READY'
  | 'CHECKOUT_OPENED'
  | 'CONTACT_ENTERED'
  | 'PAYMENT_ATTEMPTED'
  | 'ORDER_PLACED'

export const FUNNEL_STAGES: FunnelStage[] = [
  'DATE_TIME_SELECTED', 'ITEM_ADDED', 'CHECKOUT_READY', 'CHECKOUT_OPENED',
  'CONTACT_ENTERED', 'PAYMENT_ATTEMPTED', 'ORDER_PLACED',
]

// Monotonic rank — furthest_stage only ever moves forward (see
// lib/checkout-funnel.ts's upsert), so bouncing between steps or re-hitting an
// earlier stage after going further never regresses it.
export const FUNNEL_STAGE_RANK: Record<FunnelStage, number> = {
  DATE_TIME_SELECTED: 1,
  ITEM_ADDED: 2,
  CHECKOUT_READY: 3,
  CHECKOUT_OPENED: 4,
  CONTACT_ENTERED: 5,
  PAYMENT_ATTEMPTED: 6,
  ORDER_PLACED: 7,
}

// One timestamp column per stage — set once (first-reached) and never
// overwritten. Values are a fixed internal whitelist (never user input), so
// lib/checkout-funnel.ts can safely interpolate them into a column name.
export const FUNNEL_STAGE_TIMESTAMP_COLUMN: Record<FunnelStage, string> = {
  DATE_TIME_SELECTED: 'date_time_selected_at',
  ITEM_ADDED: 'item_added_at',
  CHECKOUT_READY: 'checkout_ready_at',
  CHECKOUT_OPENED: 'checkout_opened_at',
  CONTACT_ENTERED: 'contact_entered_at',
  PAYMENT_ATTEMPTED: 'payment_attempted_at',
  ORDER_PLACED: 'order_placed_at',
}

export function isFunnelStage(v: unknown): v is FunnelStage {
  return typeof v === 'string' && (FUNNEL_STAGES as string[]).includes(v)
}
