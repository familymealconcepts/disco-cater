import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations, withDiscoTables } from '../../../../lib/db'

export const runtime = 'nodejs'

interface UseRow { code: string; discount_applied: string | number; refund_status: string | null; order_ref?: string }
function shape(r: UseRow) {
  const amt = typeof r.discount_applied === 'number' ? r.discount_applied : parseFloat(String(r.discount_applied))
  return { code: r.code, discountApplied: Number.isFinite(amt) ? amt : 0, refundStatus: r.refund_status ?? 'pending' }
}

// GET /api/promo/order-promo?orderRef=...        → one promo or null
// GET /api/promo/order-promo?orderRefs=a,b,c     → { [orderRef]: promo } map (for tables)
// Reads promo_code_uses (the source of truth). The orderRef(s) are already scoped
// references, so no extra auth.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams

  const orderRefs = sp.get('orderRefs')?.trim()
  if (orderRefs) {
    const refs = orderRefs.split(',').map(s => s.trim()).filter(Boolean).slice(0, 500)
    if (refs.length === 0) return NextResponse.json({})
    try {
      const rows = (await withDiscoTables(() => sql`
        SELECT pc.code AS code, u.discount_applied AS discount_applied, u.refund_status AS refund_status, u.order_ref AS order_ref
        FROM promo_code_uses u
        JOIN promo_codes pc ON pc.id = u.promo_code_id
        WHERE u.order_ref = ANY(${refs})
      `, runMigrations)) as UseRow[]
      const map: Record<string, ReturnType<typeof shape>> = {}
      for (const r of rows) { if (r.order_ref && !map[r.order_ref]) map[r.order_ref] = shape(r) }
      return NextResponse.json(map)
    } catch (e) {
      console.error('[promo/order-promo] batch lookup failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({})
    }
  }

  const orderRef = sp.get('orderRef')?.trim()
  if (!orderRef) return NextResponse.json(null)

  try {
    const rows = (await withDiscoTables(() => sql`
      SELECT pc.code AS code, u.discount_applied AS discount_applied, u.refund_status AS refund_status
      FROM promo_code_uses u
      JOIN promo_codes pc ON pc.id = u.promo_code_id
      WHERE u.order_ref = ${orderRef}
      LIMIT 1
    `, runMigrations)) as UseRow[]
    return NextResponse.json(rows[0] ? shape(rows[0]) : null)
  } catch (e) {
    console.error('[promo/order-promo] lookup failed:', e instanceof Error ? e.message : e)
    return NextResponse.json(null)
  }
}
