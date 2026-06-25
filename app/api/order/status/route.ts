import { NextRequest, NextResponse } from 'next/server'
import { getToken } from '../../../../lib/auth'
import { sql } from '../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function num(v: unknown): number { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : 0 }

interface ConfirmationItem { name: string; quantity: number; price: number; lineTotal: number }

// Normalize the order's line items into a single { name, quantity, price,
// lineTotal } shape the confirmation page can render directly. FM nests them
// under orderMealPackages (count/price/name); also tolerate mealPackages/items.
function itemsFromFm(data: Record<string, unknown>): ConfirmationItem[] {
  const raw = (Array.isArray(data.orderMealPackages) ? data.orderMealPackages
    : Array.isArray(data.mealPackages) ? data.mealPackages
    : Array.isArray(data.items) ? data.items
    : []) as Record<string, unknown>[]
  return raw.map((it) => {
    const nested = (it.mealPackage as Record<string, unknown> | undefined) ?? undefined
    const name = String(it.name ?? it.mealPackageName ?? nested?.name ?? 'Item')
    const quantity = Math.max(1, Math.trunc(num(it.count) || num(it.quantity) || 1))
    const price = num(it.price) || num(it.pricePerUnit) || num(nested?.price)
    return { name, quantity, price, lineTotal: Math.round(price * quantity * 100) / 100 }
  })
}

export async function GET(req: NextRequest) {
  try {
    const token = getToken(req)
    if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const orderRef = req.nextUrl.searchParams.get('orderRef')
    if (!orderRef) return NextResponse.json({ error: 'orderRef required' }, { status: 400 })

    const res = await fetch(`${FM}/api/userOrder/${orderRef}`, {
      headers: { Accept: 'application/json', Authorization: token },
    })
    const data = await res.json()

    // Ensure the tax-exempt id reaches the confirmation page. FM usually returns
    // taxExempt/taxExemptId, but fall back to Neon (persisted at placement) so the
    // confirmation can always show the exemption.
    if (res.ok && data && typeof data === 'object' && !data.taxExemptId && UUID_RE.test(orderRef)) {
      try {
        const rows = (await sql`
          SELECT tax_exempt_id FROM disco_orders
          WHERE fm_order_reference = ${orderRef}::uuid OR reference = ${orderRef}::uuid
          LIMIT 1
        `) as { tax_exempt_id: string | null }[]
        const tid = rows[0]?.tax_exempt_id
        if (tid) { data.taxExemptId = tid; data.taxExempt = true }
      } catch { /* best-effort enrichment */ }
    }

    // Attach a normalized `items` array for the itemized list on the confirmation
    // page. Prefer FM's orderMealPackages; fall back to the Neon mirror
    // (disco_order_items) so the list shows even when FM omits the line items.
    if (res.ok && data && typeof data === 'object') {
      let items = itemsFromFm(data as Record<string, unknown>)
      if (items.length === 0 && UUID_RE.test(orderRef)) {
        try {
          const rows = (await sql`
            SELECT i.name, i.quantity, i.price_per_unit, i.total_price
            FROM disco_order_items i
            JOIN disco_orders o ON o.id = i.order_id
            WHERE o.fm_order_reference = ${orderRef}::uuid OR o.reference = ${orderRef}::uuid
            ORDER BY i.id
          `) as { name: string; quantity: number; price_per_unit: string; total_price: string | null }[]
          items = rows.map((r) => {
            const quantity = Math.max(1, Math.trunc(num(r.quantity) || 1))
            const price = num(r.price_per_unit)
            return { name: r.name, quantity, price, lineTotal: r.total_price != null ? num(r.total_price) : Math.round(price * quantity * 100) / 100 }
          })
        } catch { /* best-effort — confirmation still renders without items */ }
      }
      ;(data as Record<string, unknown>).items = items
    }

    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Failed to fetch order status' }, { status: 500 })
  }
}
