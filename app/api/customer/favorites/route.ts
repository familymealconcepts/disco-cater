import { NextRequest, NextResponse } from 'next/server'
import { getCustomerSession } from '../../../../lib/customer-auth'
import { runDiscoOrderMigrations, sql } from '../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/customer/favorites
// Cross-device favorites for the logged-in customer (from the disco_customer_token
// session). Returns { authenticated, email, favorites: string[] }. When not
// logged in, returns authenticated:false + an empty list (never errors).
export async function GET(req: NextRequest) {
  const session = await getCustomerSession(req)
  if (!session) return NextResponse.json({ authenticated: false, favorites: [] })
  try {
    await runDiscoOrderMigrations()
    const rows = (await sql`
      SELECT restaurant_reference FROM disco_customer_favorites
      WHERE customer_email = ${session.email} ORDER BY created_at DESC
    `) as Array<{ restaurant_reference: string }>
    return NextResponse.json({ authenticated: true, email: session.email, favorites: rows.map(r => r.restaurant_reference) })
  } catch (err) {
    console.error('[customer/favorites] GET failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ authenticated: true, email: session.email, favorites: [] })
  }
}

// POST /api/customer/favorites { restaurant_reference } — add a favorite.
export async function POST(req: NextRequest) {
  const session = await getCustomerSession(req)
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  try {
    const body = await req.json().catch(() => ({}))
    const ref = String(body?.restaurant_reference || '').trim()
    if (!ref) return NextResponse.json({ error: 'restaurant_reference required' }, { status: 400 })
    await runDiscoOrderMigrations()
    await sql`
      INSERT INTO disco_customer_favorites (customer_email, restaurant_reference)
      VALUES (${session.email}, ${ref})
      ON CONFLICT (customer_email, restaurant_reference) DO NOTHING
    `
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[customer/favorites] POST failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to add favorite' }, { status: 500 })
  }
}
