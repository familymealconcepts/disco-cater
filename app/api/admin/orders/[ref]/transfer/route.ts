import { NextRequest, NextResponse } from 'next/server'
import { getAdminRole, getAdminEmail } from '../../../../../../lib/admin-auth'
import { sql, runMigrations } from '../../../../../../lib/db'
import { sendEmail } from '../../../../../../lib/email/send'
import { layout } from '../../../../../../lib/email/layout'
import { modifyDelivery, buildPayloadFromNeon } from '../../../../../../lib/expedite'
import { syncOneFmOrder } from '../../../../../../lib/fm-orders-sync'
import { resolveRestaurantNotificationEmails } from '../../../../../../lib/order-notifications'

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
  expedite_delivery_id: string | null
  customer_email: string
}

// Restaurant recipients come from the shared ladder — the configured "Email
// Notification Recipients" list, then the order's own restaurant_email, then the
// restaurant admin's account — the same resolver every other order notification
// uses (lib/order-notifications.ts).
//
// IT USED TO BE `SELECT email FROM disco_restaurant_accounts ... ORDER BY id
// LIMIT 1`, one row, no sentinel filter. That yields nothing usable for 4,047 of
// 4,097 restaurants (3,888 have no account row at all, 159 resolve to the
// stripe-import sentinel, which Mailgun hard-bounces every time). On the one
// real transfer to date, #900000148 Two Hands - Tribeca -> NoHo, BOTH sides
// resolved to their sentinel address, so neither kitchen was told the order had
// moved while the customer was emailed about it. The ladder returns
// naz@twohandshospitality.com for both.

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
    const lookup = async () => (await sql`
      SELECT reference, fm_order_reference, order_number::text AS order_number,
             restaurant_reference, restaurant_name, restaurant_email, expedite_delivery_id, customer_email
      FROM disco_orders
      WHERE reference = ${ref}::uuid OR fm_order_reference = ${ref}::uuid
      LIMIT 1
    `) as OrderRow[]
    let orderRows = await lookup()
    if (!orderRows.length) {
      // The admin orders list is FM-direct, so most orders are never synced into
      // Neon. Pull this one from FM first, then retry — so transfer works on any
      // FM order without requiring a prior full sync.
      const synced = await syncOneFmOrder(ref).catch(() => ({ ok: false }))
      if (synced.ok) orderRows = await lookup()
    }
    if (!orderRows.length) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }
    const order = orderRows[0]
    const oldRef = order.restaurant_reference

    if (oldRef === newRef) {
      return NextResponse.json({ error: 'Order is already at this location' }, { status: 400 })
    }

    const newEmails = await resolveRestaurantNotificationEmails(newRef, null)
    const oldEmails = await resolveRestaurantNotificationEmails(oldRef, order.restaurant_email)

    // Reassign the order. Keep restaurant_name / restaurant_email coherent with
    // the new owning location so dashboards and future emails are correct.
    //
    // restaurant_email takes the first RESOLVED recipient, or NULL — never the
    // raw account row. This previously wrote the stripe-import sentinel into the
    // order (that is what #900000148 carries), which is an address known to
    // hard-bounce; the resolver filters it out, so storing it only misleads
    // anyone reading the row.
    await sql`
      UPDATE disco_orders
      SET restaurant_reference = ${newRef}::uuid,
          restaurant_name = ${dest.name},
          restaurant_email = ${newEmails[0] ?? null},
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

    // ── NOTIFICATIONS ────────────────────────────────────────────────────────
    // THE CUSTOMER IS NOT TOLD. Peter's decision: a diner does not need to know
    // which of a chain's kitchens is cooking their order, and "your order has
    // been transferred" reads as though something went wrong when nothing has —
    // the date, time, items and price are all unchanged. This is a deliberate
    // divergence from nothing: FamilyMeal has no location-transfer feature at
    // all (no endpoint sets an existing order's restaurant, and its portal has
    // no such control), so there is no FM behaviour this departs from.
    //
    // BOTH RESTAURANTS ARE, and to every configured recipient rather than one
    // account row. The receiving kitchen has to cook the order; the losing one
    // has to stop. Best-effort — a send failure must not fail the transfer.
    const oldSends = oldEmails.map(to =>
      sendEmail({
        to,
        subject: `Order #${orderNum} transferred to another location`,
        html: layout(`
          <p style="margin:0 0 12px;">Order #${orderNum} has been transferred to another location. You no longer need to prepare it.</p>
        `),
      }))
    const newSends = newEmails.map(to =>
      sendEmail({
        to,
        subject: `Order #${orderNum} assigned to your location`,
        html: layout(`
          <p style="margin:0 0 12px;">Order #${orderNum} has been assigned to your location. Please prepare as scheduled.</p>
        `),
      }))
    const [oldResults, newResults] = await Promise.all([
      Promise.allSettled(oldSends),
      Promise.allSettled(newSends),
    ])
    const okCount = (rs: PromiseSettledResult<{ success: boolean }>[]) =>
      rs.filter(r => r.status === 'fulfilled' && r.value.success).length

    // Neither side having a reachable recipient is worth seeing: the order moved
    // and no kitchen was told by email. Logged rather than alerted — a transfer
    // is a deliberate, supervised action with an operator watching the response.
    if (!oldEmails.length) console.warn('[admin/orders/transfer] no reachable recipient at the losing restaurant:', oldRef)
    if (!newEmails.length) console.error('[admin/orders/transfer] no reachable recipient at the RECEIVING restaurant — nobody was told to cook it:', newRef, 'order', orderNum)

    // Expedite pickup-location update — best-effort, gated on an active delivery.
    // The order's restaurant_reference was just updated to newRef, so the rebuilt
    // payload's pickup task uses the new restaurant's address automatically.
    let expedite: { success: boolean; error?: string } = { success: false, error: 'no active delivery' }
    if (order.expedite_delivery_id) {
      const payload = await buildPayloadFromNeon(order.reference)
      expedite = payload
        ? await modifyDelivery(payload)
        : { success: false, error: 'could not build payload' }
    }

    return NextResponse.json({
      success: true,
      from: oldRef,
      to: newRef,
      emails: {
        // customer: deliberately not sent — see the notifications block.
        oldRestaurant: { sent: okCount(oldResults), recipients: oldEmails.length },
        newRestaurant: { sent: okCount(newResults), recipients: newEmails.length },
      },
      expedite,
    })
  } catch (err) {
    console.error('[admin/orders/transfer] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to transfer order' }, { status: 500 })
  }
}
