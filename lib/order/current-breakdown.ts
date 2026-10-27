// The order's money breakdown as it stands NOW — taxes, service charge,
// delivery, tip, discount — for the order PDF and the order details screen.
//
// Checkout writes the ORIGINAL disco_sale_transactions row. An edit that changes
// the money writes the full post-edit breakdown on its own MANUAL_EDIT row
// (ADDITIONAL for a charge or a paid edit invoice, REFUND for a refund), with
// `subtotal`/`fee` the new figures and `total` only the difference. So the
// newest MANUAL_EDIT row that carries a breakdown (state_tax set — FM-backed
// edits leave it NULL) describes the order as edited; without one, ORIGINAL does.
//
// Reading only ORIGINAL showed an edited order's checkout taxes next to its
// edited total (#900000522: $37.20 tax, $497.38 total on the PDF; the order is
// $563.35). Reports, dashboards and payouts deliberately still read ORIGINAL.
import { sql } from '../db'

export interface BreakdownRow {
  transaction_type: string
  subtotal: string | number | null
  total: string | number | null
  fee: string | number | null
  service_charge: string | number | null
  stripe_fee: string | number | null
  state_tax: string | number | null
  local_tax: string | number | null
  other_tax: string | number | null
  tips_in_price: string | number | null
  third_party_delivery_tips: string | number | null
  own_delivery_fee: string | number | null
  third_party_delivery_fee: string | number | null
  discount: string | number | null
  lead_gen_one_disco_fee: string | number | null
  lead_gen_two_disco_fee: string | number | null
}

/** `edited` = the row is an edit's breakdown, so the order's own subtotal, fee
 *  and total (disco_orders) are the current figures, not this row's `total`. */
export async function loadCurrentBreakdown(orderId: number): Promise<{ row: BreakdownRow | null; edited: boolean }> {
  const rows = (await sql`
    SELECT transaction_type, subtotal, total, fee, service_charge, stripe_fee, state_tax, local_tax, other_tax,
           tips_in_price, third_party_delivery_tips, own_delivery_fee, third_party_delivery_fee,
           discount, lead_gen_one_disco_fee, lead_gen_two_disco_fee
    FROM disco_sale_transactions
    WHERE order_id = ${orderId}
      AND (transaction_type = 'ORIGINAL'
           OR (source = 'MANUAL_EDIT' AND transaction_type IN ('ADDITIONAL', 'REFUND') AND state_tax IS NOT NULL))
    ORDER BY (transaction_type = 'ORIGINAL'), created_at DESC, id DESC
    LIMIT 1
  `) as BreakdownRow[]
  const row = rows[0] ?? null
  return { row, edited: !!row && row.transaction_type !== 'ORIGINAL' }
}
