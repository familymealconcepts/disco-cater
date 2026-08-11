import { NextRequest, NextResponse } from 'next/server'
import { getItemsRemaining } from '../../../../lib/order/native-inventory'

export const runtime = 'nodejs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Public (no auth) — same trust level as /api/order/dates|times. Returns live
// remaining stock for a set of native menu items on a given date, so the cart
// can cap its quantity selector before checkout. Only capped items appear in
// the response; an item with no cap set is simply absent (uncapped → no limit).
export async function GET(req: NextRequest) {
  const refs = (req.nextUrl.searchParams.get('refs') || '').split(',').map(s => s.trim()).filter(s => UUID_RE.test(s))
  const date = (req.nextUrl.searchParams.get('date') || '').trim()
  if (refs.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ remaining: {} })
  }
  try {
    const remaining = await getItemsRemaining(refs, date)
    return NextResponse.json({ remaining })
  } catch (e) {
    console.error('[order/item-availability] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ remaining: {} })
  }
}
