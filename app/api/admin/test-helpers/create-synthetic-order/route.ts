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

  // Money snapshot. subtotal/total/fee now live on disco_orders (added for the
  // Disco-native edit flow), so the synthetic order carries them too — the E2E
  // edit step diffs the new cart against these. Caller may override; defaults
  // give a clean taxRate of 0 (total = subtotal + fee).
  const n = (v: unknown, d: number): number => { const x = Number(v); return Number.isFinite(x) ? x : d }
  const subtotal = n(body?.subtotal, 3.0)
  const fee = n(body?.fee, 0.09)
  const total = n(body?.total, 3.09)

  try {
    await runDiscoOrderMigrations()
    // order_number is NOT NULL UNIQUE. Use epoch (ms) + a random suffix so repeat
    // runs (and concurrent inserts) never collide.
    const orderNumber = Date.now() * 1000 + Math.floor(Math.random() * 1000)
    const rows = (await sql`
      INSERT INTO disco_orders (
        fm_order_reference, order_number, restaurant_reference, customer_email,
        customer_first_name, customer_last_name, order_date, order_time, order_type,
        source_of_order, order_status, subtotal, total, fee, created_at
      ) VALUES (
        gen_random_uuid(), ${orderNumber}, ${restaurantReference}::uuid, ${customerEmail},
        'E2E', 'Test', (NOW()::date + 7), '10:00:00', 'PICKUP',
        'DISCO', 'DUE', ${subtotal}, ${total}, ${fee}, NOW()
      )
      RETURNING fm_order_reference, restaurant_reference, subtotal, total, fee, order_number
    `) as { fm_order_reference: string; restaurant_reference: string; subtotal: string; total: string; fee: string; order_number: string }[]

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
