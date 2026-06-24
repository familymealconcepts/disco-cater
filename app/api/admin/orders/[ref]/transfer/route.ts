import { NextRequest, NextResponse } from 'next/server'
import { getAdminRole, getAdminEmail } from '../../../../../../lib/admin-auth'
import { sql, runMigrations } from '../../../../../../lib/db'
import { sendEmail } from '../../../../../../lib/email/send'
import { layout } from '../../../../../../lib/email/layout'
import { sendDlivrdDeliveryModified } from '../../../../../../lib/dlivrd'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface OrderRow {
  reference: string
  fm_order_reference: string | null
  order_number: string
  restaurant_reference: string
  restaurant_name: string | null
  restaurant_email: string | null
  customer_email: string
}

// Resolve a restaurant's contact email from disco_restaurant_accounts (the cache
// has no email). Returns null when the restaurant has no Disco account.
async function restaurantEmail(restaurantReference: string): Promise<string | null> {
  const rows = (await sql`
    SELECT email FROM disco_restaurant_accounts
    WHERE restaurant_reference = ${restaurantReference}
    ORDER BY id ASC LIMIT 1
  `) as Array<{ email: string | null }>
  return rows[0]?.email ?? null
}

// POST /api/admin/orders/{ref}/transfer  — SUPER_ADMIN only.
// Reassigns an order to another restaurant (Neon), logs the event, notifies the
// customer + both restaurants by email, and best-effort updates dlivrd pickup.
export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  if ((await getAdminRole()) !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const adminEmail = (await getAdminEmail()) || 'unknown'

  const { ref } = await params
  if (!UUID_RE.test(ref)) return NextResponse.json({ error: 'Invalid order reference' }, { status: 400 })

  let body: { newRestaurantReference?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }
  const newRef = String(body?.newRestaurantReference || '').trim()
  if (!UUID_RE.test(newRef)) return NextResponse.json({ error: 'Invalid newRestaurantReference' }, { status: 400 })

  try {
    await runMigrations() // ensures disco_orders + disco_restaurant_cache schema

    // Validate the destination restaurant exists in the cache, and grab its
    // address/coords for the dlivrd pickup update + its name for the order row.
    const destRows = (await sql`
      SELECT name, address, lat, lng FROM disco_restaurant_cache
      WHERE restaurant_reference = ${newRef}
    `) as Array<{ name: string | null; address: string | null; lat: string | null; lng: string | null }>
    if (!destRows.length) {
      return NextResponse.json({ error: 'Destination restaurant not found' }, { status: 400 })
    }
    const dest = destRows[0]

    // Look up the order in Neon by either reference (admin list surfaces the FM
    // reference, which maps to fm_order_reference here).
    const orderRows = (await sql`
      SELECT reference, fm_order_reference, order_number::text AS order_number,
             restaurant_reference, restaurant_name, restaurant_email, customer_email
      FROM disco_orders
      WHERE reference = ${ref}::uuid OR fm_order_reference = ${ref}::uuid
      LIMIT 1
    `) as OrderRow[]
    if (!orderRows.length) {
      return NextResponse.json({ error: 'Order not found in Neon' }, { status: 404 })
    }
    const order = orderRows[0]
    const oldRef = order.restaurant_reference

    if (oldRef === newRef) {
      return NextResponse.json({ error: 'Order is already at this location' }, { status: 400 })
    }

    const newEmail = await restaurantEmail(newRef)
    const oldEmail = order.restaurant_email || (await restaurantEmail(oldRef))

    // Reassign the order. Keep restaurant_name / restaurant_email coherent with
    // the new owning location so dashboards and future emails are correct.
    await sql`
      UPDATE disco_orders
      SET restaurant_reference = ${newRef}::uuid,
          restaurant_name = ${dest.name},
          restaurant_email = ${newEmail},
          updated_at = NOW()
      WHERE reference = ${order.reference}::uuid
    `

    // Audit event.
    await sql`
      INSERT INTO disco_order_events (order_reference, event_type, event_data, source)
      VALUES (
        ${order.reference}::uuid, 'TRANSFERRED',
        ${JSON.stringify({ from_restaurant: oldRef, to_restaurant: newRef, transferred_by: adminEmail })}::jsonb,
        'ADMIN_TRANSFER'
      )
    `

    const orderNum = order.order_number
    const newName = dest.name || 'the new location'

    // Notifications — best-effort; a send failure must not fail the transfer.
    const emailResults = await Promise.allSettled([
      // a. Customer
      sendEmail({
        to: order.customer_email,
        subject: `Your Disco Cater order #${orderNum} has been transferred`,
        html: layout(`
          <p style="font-size:18px;font-weight:700;margin:0 0 12px;">Your order has been transferred</p>
          <p style="margin:0 0 12px;">Your order has been transferred to <strong>${newName}</strong>. All other order details remain the same.</p>
        `),
      }),
      // b. Old restaurant (only if we have a contact email)
      oldEmail
        ? sendEmail({
            to: oldEmail,
            subject: `Order #${orderNum} transferred to another location`,
            html: layout(`
              <p style="margin:0 0 12px;">Order #${orderNum} has been transferred to another location.</p>
            `),
          })
        : Promise.resolve({ success: false, error: 'no old restaurant email' }),
      // c. New restaurant (only if we have a contact email)
      newEmail
        ? sendEmail({
            to: newEmail,
            subject: `Order #${orderNum} assigned to your location`,
            html: layout(`
              <p style="margin:0 0 12px;">Order #${orderNum} has been assigned to your location. Please prepare as scheduled.</p>
            `),
          })
        : Promise.resolve({ success: false, error: 'no new restaurant email' }),
    ])
    const emailOk = (i: number) => emailResults[i].status === 'fulfilled' && (emailResults[i] as PromiseFulfilledResult<{ success: boolean }>).value.success

    // dlivrd pickup-location update — best-effort, gated on EXPEDITE_* env.
    const dlivrd = await sendDlivrdDeliveryModified({
      externalDeliveryId: order.fm_order_reference || '',
      address: dest.address,
      lat: dest.lat != null ? Number(dest.lat) : null,
      lng: dest.lng != null ? Number(dest.lng) : null,
      businessName: dest.name,
    })

    return NextResponse.json({
      success: true,
      from: oldRef,
      to: newRef,
      emails: { customer: emailOk(0), oldRestaurant: emailOk(1), newRestaurant: emailOk(2) },
      dlivrd,
    })
  } catch (err) {
    console.error('[admin/orders/transfer] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to transfer order' }, { status: 500 })
  }
}
