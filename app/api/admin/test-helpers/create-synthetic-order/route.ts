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
  // restaurant_reference is a UUID column — a non-UUID value would otherwise blow
  // up as an opaque cast error. Surface it clearly (e.g. FM returned a non-UUID).
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!UUID_RE.test(restaurantReference)) {
    return NextResponse.json({ error: `restaurantReference is not a valid UUID: "${restaurantReference}"` }, { status: 400 })
  }

  try {
    await runDiscoOrderMigrations()
    // order_number is NOT NULL UNIQUE. Use epoch (ms) + a random suffix so repeat
    // runs (and concurrent inserts) never collide.
    const orderNumber = Date.now() * 1000 + Math.floor(Math.random() * 1000)
    // NOTE: subtotal/total/fee are NOT columns on disco_orders (they live on
    // disco_sale_transactions) — including them was the original 500. The
    // synthetic order only needs the order row; the E2E charges $1.13 via Stripe
    // test mode + records it in disco_stripe_payments separately.
    const rows = (await sql`
      INSERT INTO disco_orders (
        fm_order_reference, order_number, restaurant_reference, customer_email,
        customer_first_name, customer_last_name, order_date, order_time, order_type,
        source_of_order, order_status, created_at
      ) VALUES (
        gen_random_uuid(), ${orderNumber}, ${restaurantReference}::uuid, ${customerEmail},
        'E2E', 'Test', (NOW()::date + 7), '10:00:00', 'PICKUP',
        'DISCO', 'DUE', NOW()
      )
      RETURNING fm_order_reference, restaurant_reference
    `) as { fm_order_reference: string; restaurant_reference: string }[]

    return NextResponse.json(rows[0])
  } catch (e) {
    // Surface the exact Postgres error (message + code + detail + constraint) so
    // the E2E test result shows which constraint actually failed.
    const err = e as { message?: string; code?: string; detail?: string; constraint?: string; column?: string }
    const message = err?.message || String(e)
    console.error('[create-synthetic-order] insert failed:', { message, code: err?.code, detail: err?.detail, constraint: err?.constraint, column: err?.column })
    return NextResponse.json({
      error: `Synthetic order insert failed: ${message}`,
      pg: { code: err?.code, detail: err?.detail, constraint: err?.constraint, column: err?.column },
    }, { status: 500 })
  }
}
