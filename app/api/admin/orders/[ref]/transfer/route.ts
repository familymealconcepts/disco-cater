import { NextRequest, NextResponse } from 'next/server'
import { getAdminRole, getAdminEmail } from '../../../../../../lib/admin-auth'
import { sql, runMigrations } from '../../../../../../lib/db'
import { sendOrderTransferredNotice } from '../../../../../../lib/email/notifications'
import { loadOrderItemsWithAddOns } from '../../../../../../lib/order-items'
import { remapLinesToRestaurant } from '../../../../../../lib/order/native-cart-reprice'
import { fmtDateHuman } from '../../../../../../lib/order-edit'
import { formatTime12 } from '../../../../../../lib/utils/time'
import { syncCourierAndReport } from '../../../../../../lib/order/courier-sync'
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
      SELECT name, address, phone, lat, lng FROM disco_restaurant_cache
      WHERE restaurant_reference = ${newRef}
    `) as Array<{ name: string | null; address: string | null; phone: string | null; lat: string | null; lng: string | null }>
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
    // ── EVERY DENORMALISED STORE FIELD MOVES, NOT JUST THE NAME ──────────────
    // disco_orders carries its own copy of the restaurant's name, address, phone
    // and email, and the order PDF prefers those over the cache (order-pdf.ts:
    // `o.restaurant_address || cacheAddress`), so a stale copy is never
    // corrected by the fallback. This used to update name and email only, which
    // put the RIGHT store name above the WRONG address and phone on #900000148's
    // PDF: "Two Hands - NoHo" over Tribeca's 251 Church St and 6467185619. The
    // destination's address was already being selected here and simply never
    // written.
    await sql`
      UPDATE disco_orders
      SET restaurant_reference = ${newRef}::uuid,
          restaurant_name = ${dest.name},
          restaurant_address = ${dest.address},
          restaurant_phone = ${dest.phone},
          restaurant_email = ${newEmails[0] ?? null},
          -- New to the receiving kitchen: it never saw this order, so it must
          -- show as new there (#900000724 kept seen_by_admin = true).
          seen_by_admin = false,
          updated_at = NOW()
      WHERE reference = ${order.reference}::uuid
    `

    // ── THE ITEMS AND MENU MOVE TOO ───────────────────────────────────────────
    // Items kept the old location's menu item references, so they kept counting
    // against the OLD kitchen's daily limits (orderedQtyByItem keys on the item)
    // and every later edit failed its menu check until 4550a47 re-matched them at
    // edit time. Now they are matched here, by the same rule (name → category →
    // menu, unique match only; lib/order/native-cart-reprice.ts). An item the new
    // location doesn't carry keeps its old reference and is reported back.
    let itemsMatched = 0, itemsUnmatched: string[] = []
    try {
      const itemRows = (await sql`
        SELECT i.id, i.meal_package_reference::text AS reference, i.name FROM disco_order_items i
          JOIN disco_orders o ON o.id = i.order_id WHERE o.reference = ${order.reference}::uuid ORDER BY i.id
      `) as Array<{ id: number; reference: string | null; name: string }>
      const withRef = itemRows.filter(r => !!r.reference) as Array<{ id: number; reference: string; name: string }>
      const r = await remapLinesToRestaurant(newRef, withRef)
      for (let i = 0; i < withRef.length; i++) {
        if (r.lines[i].reference !== withRef[i].reference) {
          await sql`UPDATE disco_order_items SET meal_package_reference = ${r.lines[i].reference}::uuid WHERE id = ${withRef[i].id}`
          itemsMatched++
        }
      }
      const stillForeign = (await sql`
        SELECT i.name FROM disco_order_items i JOIN disco_orders o ON o.id = i.order_id
          JOIN disco_menu_items m ON m.reference::text = i.meal_package_reference::text
         WHERE o.reference = ${order.reference}::uuid AND m.restaurant_reference::text <> ${newRef}
      `) as Array<{ name: string }>
      itemsUnmatched = stillForeign.map(x => x.name)
      // The order's menu: the new location's menu of the same name, if exactly one.
      await sql`
        UPDATE disco_orders o SET menu_reference = nm.reference
          FROM disco_menus om, disco_menus nm
         WHERE o.reference = ${order.reference}::uuid AND om.reference = o.menu_reference
           AND nm.restaurant_reference = ${newRef}::uuid AND lower(trim(nm.name)) = lower(trim(om.name))
           AND (SELECT count(*) FROM disco_menus x WHERE x.restaurant_reference = ${newRef}::uuid AND lower(trim(x.name)) = lower(trim(om.name))) = 1
      `
    } catch (e) {
      console.error('[admin/orders/transfer] item re-match failed (non-fatal):', e instanceof Error ? e.message : e)
    }

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
    // ONE email per recipient, naming both locations, the date and the items.
    // A chain's locations often share recipients; they used to get two emails
    // that contradicted each other and named nothing (#900000724).
    const fromName = order.restaurant_name || 'the previous location'
    const toName = dest.name || 'the new location'
    const facts = (await sql`
      SELECT id, to_char(order_date, 'YYYY-MM-DD') AS d, order_time::text AS t, order_type
        FROM disco_orders WHERE reference = ${order.reference}::uuid LIMIT 1
    `.catch(() => [])) as Array<{ id: number; d: string | null; t: string | null; order_type: string | null }>
    const lines = facts[0] ? await loadOrderItemsWithAddOns(facts[0].id).catch(() => []) : []
    const items = lines.map(l => ({
      count: l.quantity, name: l.name, price: l.pricePerUnit,
      ...(l.addOns.length ? { addOns: l.addOns.map(a => ({ name: a.name, price: a.price, count: a.quantity })) } : {}),
      ...(l.notes ? { comment: l.notes } : {}),
    }))
    const norm = (e: string) => e.trim().toLowerCase()
    const oldSet = new Set(oldEmails.map(norm)), newSet = new Set(newEmails.map(norm))
    const everyone = [...new Map([...oldEmails, ...newEmails].map(e => [norm(e), e])).values()]
    const sends = everyone.map(to => sendOrderTransferredNotice({
      to, orderNumber: orderNum, fromName, toName,
      role: oldSet.has(norm(to)) && newSet.has(norm(to)) ? 'both' : newSet.has(norm(to)) ? 'to' : 'from',
      orderDate: facts[0]?.d ? fmtDateHuman(facts[0].d) : undefined,
      orderTime: facts[0]?.t ? formatTime12(facts[0].t) : undefined,
      orderType: facts[0]?.order_type ?? null,
      items,
    }))
    const results = await Promise.allSettled(sends)
    const sentTo = (set: Set<string>) => everyone.filter((e, i) => set.has(norm(e)) && results[i].status === 'fulfilled'
      && (results[i] as PromiseFulfilledResult<{ success: boolean }>).value.success).length

    // Neither side having a reachable recipient is worth seeing: the order moved
    // and no kitchen was told by email. Logged rather than alerted — a transfer
    // is a deliberate, supervised action with an operator watching the response.
    if (!oldEmails.length) console.warn('[admin/orders/transfer] no reachable recipient at the losing restaurant:', oldRef)
    if (!newEmails.length) console.error('[admin/orders/transfer] no reachable recipient at the RECEIVING restaurant — nobody was told to cook it:', newRef, 'order', orderNum)

    // Expedite pickup-location update — best-effort, gated on an active delivery.
    // The order's restaurant_reference was just updated to newRef, so the rebuilt
    // payload's pickup task uses the new restaurant's address automatically.
    // Recorded on the order; a refusal alerts ops (lib/order/courier-sync.ts).
    // Expedite refuses a changed pickup address on an existing booking ("address
    // modifications are not allowed"), so for a real transfer expect the alert:
    // the courier then has to be rebooked by hand. No automatic cancel-and-rebook.
    let expedite: { success: boolean; error?: string } = { success: false, error: 'no active delivery' }
    if (order.expedite_delivery_id) {
      const r = await syncCourierAndReport(order.reference, 'TRANSFER')
      expedite = { success: r.success, error: r.error }
    }

    return NextResponse.json({
      success: true,
      from: oldRef,
      to: newRef,
      emails: {
        // customer: deliberately not sent — see the notifications block.
        oldRestaurant: { sent: sentTo(oldSet), recipients: oldEmails.length },
        newRestaurant: { sent: sentTo(newSet), recipients: newEmails.length },
      },
      expedite,
      items: { matched: itemsMatched, notOnNewMenu: itemsUnmatched },
    })
  } catch (err) {
    console.error('[admin/orders/transfer] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Unable to transfer order' }, { status: 500 })
  }
}
