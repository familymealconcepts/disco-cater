import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { sql, runDiscoOrderMigrations } from '../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/webhooks/expedite
// Receives delivery status updates from Expedite. Verifies the
// X-Expedite-Signature ("<timestamp>.<HMAC-SHA256(EXPEDITE_SECRET, timestamp + '.' + rawBody)>"),
// updates disco_orders.expedite_status, logs an event, and returns 200 fast.
export async function POST(req: NextRequest) {
  // Read the raw body for signature verification (must hash the exact bytes).
  const raw = await req.text().catch(() => '')

  // Verify signature when a secret is configured.
  const secret = process.env.EXPEDITE_SECRET
  if (secret) {
    const header = req.headers.get('x-expedite-signature') || ''
    const dot = header.indexOf('.')
    const timestamp = dot >= 0 ? header.slice(0, dot) : ''
    const provided = dot >= 0 ? header.slice(dot + 1) : ''
    const expected = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')
    let valid = false
    try {
      const a = Buffer.from(provided, 'hex')
      const b = Buffer.from(expected, 'hex')
      valid = a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
    } catch { valid = false }
    if (!valid) {
      console.warn('[webhooks/expedite] invalid signature — rejecting')
      return NextResponse.json({ error: 'invalid signature' }, { status: 401 })
    }
  } else {
    console.warn('[webhooks/expedite] EXPEDITE_SECRET not set — accepting without verification')
  }

  let data: Record<string, unknown> = {}
  try { data = raw ? JSON.parse(raw) : {} } catch { /* non-JSON body */ }

  const externalDeliveryId = String(
    data.external_delivery_id ?? data.externalDeliveryId ?? '',
  ).trim()
  const status = String(
    data.status ?? data.delivery_status ?? data.deliveryStatus ?? data.state ?? req.headers.get('x-expedite-event') ?? '',
  ).trim()

  // Process best-effort, then always return 200 so Expedite doesn't retry-storm.
  try {
    await runDiscoOrderMigrations().catch(() => {})
    if (externalDeliveryId) {
      const rows = (await sql`
        SELECT reference FROM disco_orders WHERE expedite_delivery_id = ${externalDeliveryId} LIMIT 1
      `.catch(() => [])) as Array<{ reference: string }>
      const reference = rows[0]?.reference
      if (reference) {
        if (status) {
          await sql`
            UPDATE disco_orders SET expedite_status = ${status}, updated_at = NOW()
            WHERE expedite_delivery_id = ${externalDeliveryId}
          `.catch(e => console.error('[webhooks/expedite] status update failed:', e instanceof Error ? e.message : e))
        }
        await sql`
          INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
          VALUES (${reference}::uuid, 'EXPEDITE_STATUS', ${JSON.stringify({ status, externalDeliveryId, payload: data })}::jsonb, 'EXPEDITE_WEBHOOK')
        `.catch(e => console.error('[webhooks/expedite] event insert failed:', e instanceof Error ? e.message : e))
        console.log(`[webhooks/expedite] ${externalDeliveryId} → ${status || '(no status)'}`)
      } else {
        console.warn('[webhooks/expedite] no order for external_delivery_id:', externalDeliveryId)
      }
    } else {
      console.warn('[webhooks/expedite] missing external_delivery_id in payload')
    }
  } catch (e) {
    console.error('[webhooks/expedite] processing error:', e instanceof Error ? e.message : e)
  }

  return NextResponse.json({ received: true })
}
