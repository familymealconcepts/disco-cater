import { NextRequest, NextResponse } from 'next/server'
import { getItemMinimumsByName } from '../../../../lib/order/native-minimums'

export const runtime = 'nodejs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Public (no auth) — same trust level and shape as the sibling
// /api/order/item-availability. Returns each visible native item's minimum
// quantity keyed by lowercased name, so a cart editor that holds only item NAMES
// (the recurring-occurrence editor) can floor its quantity stepper instead of
// bottoming out at 1. Nothing secret here: these minimums are already printed on
// the public menu.
//
// An item with no minimum is simply absent from the response — the client must
// treat a missing key as "no minimum", never as 0.
export async function GET(req: NextRequest) {
  const ref = (req.nextUrl.searchParams.get('restaurantReference') || '').trim()
  if (!UUID_RE.test(ref)) return NextResponse.json({ minimums: {} })
  try {
    return NextResponse.json({ minimums: await getItemMinimumsByName(ref) })
  } catch (e) {
    console.error('[order/item-minimums] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ minimums: {} })
  }
}
