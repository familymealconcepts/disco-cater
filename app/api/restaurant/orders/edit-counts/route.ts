import { NextRequest, NextResponse } from 'next/server'
import { sql, runDiscoOrderMigrations } from '../../../../../lib/db'
import { getRestaurantAuthContext } from '../../../../../lib/restaurant-auth-context'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Batch edit-history counts for a page of orders. The portal orders table uses
// this to show the edit-history icon only on orders that actually have edits.
//   POST { orderRefs: string[] } → { counts: { [orderRef]: number } }
export async function POST(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: { orderRefs?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ counts: {} }) }

  const refs = Array.isArray(body?.orderRefs)
    ? body.orderRefs.map(r => String(r)).filter(r => UUID_RE.test(r))
    : []
  if (!refs.length) return NextResponse.json({ counts: {} })

  try {
    await runDiscoOrderMigrations()
    const rows = (await sql`
      SELECT fm_order_reference::text AS ref, COUNT(*)::int AS n
      FROM disco_order_edits
      WHERE fm_order_reference = ANY(${refs}::uuid[])
      GROUP BY fm_order_reference
    `) as { ref: string; n: number }[]
    const counts: Record<string, number> = {}
    for (const r of rows) counts[r.ref] = r.n
    return NextResponse.json({ counts })
  } catch (e) {
    console.error('[orders/edit-counts]', e instanceof Error ? e.message : e)
    return NextResponse.json({ counts: {} })
  }
}
