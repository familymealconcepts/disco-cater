// What a scheduled report's "Fulfillment types" filter actually means.
//
// ── THE DEFECT THIS REPLACES ────────────────────────────────────────────────
// The filter stored RAW `disco_orders.delivery_type` values and matched them
// exactly, while the picker offered only three of the seven values that exist:
//
//     PICKUP  OWN_DELIVERY  DLIVRD_DELIVERY
//
// Four are missing, and all four are third-party couriers:
//
//     DLIVRD_DELIVERY       1,716 orders   (the only one the picker offered)
//     NASH_DELIVERY           392
//     THIRD_PARTY_DELIVERY     56          (the current native-dispatch value)
//     DOOR_DASH_DELIVERY       28
//
// So no configuration reachable through the UI could include a third-party
// order — including the select-everything default a new report starts with.
// Gracious Bakery's weekly report was blank three weeks running because of it;
// eleven of their last twelve orders are THIRD_PARTY_DELIVERY.
//
// ── WHY THIS IS A CONCEPT LIST, NOT FOUR MORE CHECKBOXES ────────────────────
// The report already SHOWS three concepts. serviceTypeOf() in
// lib/reports/order-report-rows.ts collapses every courier value into the
// single label "Third-Party Delivery", so the Service column a restaurant reads
// has three possible values while the filter beneath it had seven. Adding
// THIRD_PARTY_DELIVERY as a fourth checkbox would have fixed Gracious and left
// NASH_DELIVERY and DOOR_DASH_DELIVERY still invisible — one more value, and
// the same bug waiting for the fifth courier.
//
// Instead the picker offers exactly the three concepts the Service column
// prints, and the expansion to raw values happens here. A new courier is then
// one entry in THIRD_PARTY_DELIVERY_TYPES (which already exists and is already
// the source of truth for fulfilment timing) and nothing else has to change.
//
// ── A NULL delivery_type IS PICKUP ──────────────────────────────────────────
// 20,373 historical FM-mirrored rows carry null. The row query reads
// COALESCE(delivery_type, 'PICKUP'), and serviceTypeOf() agrees, so PICKUP
// below carries the explicit value and the query's COALESCE handles the rest.
import { THIRD_PARTY_DELIVERY_TYPES } from '../order/fulfillment-time'

/** The three options the picker offers — the same three the Service column prints. */
export const FULFILLMENT_CONCEPTS = ['PICKUP', 'OWN_DELIVERY', 'THIRD_PARTY'] as const
export type FulfillmentConcept = (typeof FULFILLMENT_CONCEPTS)[number]

export const FULFILLMENT_CONCEPT_LABEL: Record<string, string> = {
  PICKUP: 'Pickup',
  OWN_DELIVERY: 'Self-Delivery',
  THIRD_PARTY: 'Third-Party Delivery',
}

/** Every raw delivery_type that counts as third-party, from the one existing list. */
export const THIRD_PARTY_VALUES: string[] = [...THIRD_PARTY_DELIVERY_TYPES].sort()

/**
 * Expand a stored filter into the raw `delivery_type` values to match on.
 *
 * ACCEPTS BOTH SHAPES, DELIBERATELY. Reports saved before this change hold raw
 * values ('DLIVRD_DELIVERY'); reports saved after hold concepts
 * ('THIRD_PARTY'). Both must keep working — a restaurant's saved report cannot
 * be allowed to start matching nothing because the vocabulary changed
 * underneath it, which is exactly how the column keys broke (see
 * lib/reports/native-reports.ts's column migration).
 *
 * An empty or absent filter means NO filter, and returns empty so the caller
 * skips the predicate entirely.
 *
 * A raw courier value that is NOT in THIRD_PARTY_VALUES still passes through
 * untouched, so an unrecognised value a restaurant somehow saved keeps matching
 * itself rather than silently disappearing.
 */
export function expandFulfillmentFilter(stored: string[] | null | undefined): string[] {
  const vals = (stored ?? []).map(v => String(v ?? '').trim().toUpperCase()).filter(Boolean)
  if (!vals.length) return []
  const out = new Set<string>()
  for (const v of vals) {
    if (v === 'THIRD_PARTY' || v === 'THIRD_PARTY_DELIVERY') {
      // THIRD_PARTY_DELIVERY is both a concept name and a real column value.
      // Treating it as the concept is the safe reading: it expands to a SUPERSET
      // that still includes itself, so nothing that used to match stops matching.
      for (const t of THIRD_PARTY_VALUES) out.add(t)
      continue
    }
    out.add(v)
  }
  return [...out]
}

/**
 * Collapse raw stored values back to concepts, for the picker's checkboxes.
 * Any third-party value present ticks the single Third-Party box.
 */
export function collapseFulfillmentFilter(stored: string[] | null | undefined): FulfillmentConcept[] {
  const vals = (stored ?? []).map(v => String(v ?? '').trim().toUpperCase()).filter(Boolean)
  const out = new Set<FulfillmentConcept>()
  for (const v of vals) {
    if (v === 'PICKUP') out.add('PICKUP')
    else if (v === 'OWN_DELIVERY') out.add('OWN_DELIVERY')
    else out.add('THIRD_PARTY')   // every courier value, known or not
  }
  return FULFILLMENT_CONCEPTS.filter(c => out.has(c))
}
