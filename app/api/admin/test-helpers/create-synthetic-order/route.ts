import { NextRequest, NextResponse } from 'next/server'
import { getAdminRole } from '../../../../../lib/admin-auth'
import { sql, runDiscoOrderMigrations } from '../../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// SUPER_ADMIN test helper: insert a synthetic Disco order (bypasses FM — native
// checkout is not built yet) so the E2E test has a real disco_orders row to
// charge/edit/refund against. Returns { fm_order_reference, restaurant_reference }.
export async function POST(req: NextRequest) {
  if ((await getAdminRole()) !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 }) }

  const restaurantReference = String(body?.restaurantReference || '').trim()
  const customerEmail = String(body?.customerEmail || '').trim() || 'e2e@discocater.com'
  if (!restaurantReference) return NextResponse.json({ error: 'restaurantReference is required.' }, { status: 400 })

  try {
    await runDiscoOrderMigrations()
    // order_number is NOT NULL UNIQUE — synthesize one (not present in the spec'd
    // VALUES, but required by the schema).
    const orderNumber = 990_000_000 + (Date.now() % 9_000_000)
    const rows = (await sql`
      INSERT INTO disco_orders (
        fm_order_reference, order_number, restaurant_reference, customer_email,
        customer_first_name, customer_last_name, order_date, order_time, order_type,
        source_of_order, subtotal, total, fee, order_status, created_at
      ) VALUES (
        gen_random_uuid(), ${orderNumber}, ${restaurantReference}::uuid, ${customerEmail},
        'E2E', 'Test', (NOW()::date + 7), '10:00:00', 'PICKUP',
        'DISCO', 1.00, 1.13, 0.03, 'DUE', NOW()
      )
      RETURNING fm_order_reference, restaurant_reference
    `) as { fm_order_reference: string; restaurant_reference: string }[]

    return NextResponse.json(rows[0])
  } catch (e) {
    console.error('[create-synthetic-order] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to create synthetic order.' }, { status: 500 })
  }
}
