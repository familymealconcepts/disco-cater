import { NextRequest, NextResponse } from 'next/server'
import { sql } from '../../../../../../lib/db'
import { requireArchiveAccess } from '../../../../../../lib/admin-archive-access'
import { logAdminAction } from '../../../../../../lib/admin-audit'
import { previewRestaurantDelete, deleteRestaurantPermanently, type DeleteRowCounts } from '../../../../../../lib/disco-restaurant-delete'

// Permanent delete — for test restaurants and duplicates only, records that
// shouldn't exist at all. NOT a general-purpose delete: Archive already
// covers "gone but restorable" for real restaurants, and this tool refuses
// anything that isn't a pure Disco-native restaurant with no FM record (see
// lib/disco-restaurant-delete.ts for why an FM-backed delete can't work
// durably). Same super-admin + two-account gate as archive/restore.
//
//   GET    → eligibility + preview (row counts per table, order detail if
//            exactly 1). Never mutates.
//   DELETE → perform it. Body must echo back the EXACT rowCounts + orderCount
//            the client just previewed — re-derived live and compared, so a
//            stale preview (something changed in between) can never
//            authorize deleting more than what was actually shown.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface EligibilityResult {
  eligible: boolean
  reason: string | null
  restaurantName: string | null
  orderCount: number
  order: {
    total: number | null; status: string | null
    customerEmail: string | null; customerName: string | null; placedAt: string | null
  } | null
}

async function checkEligibility(ref: string): Promise<EligibilityResult> {
  const acct = (await sql`
    SELECT is_disco_native, fm_restaurant_reference FROM disco_restaurant_accounts
    WHERE restaurant_reference = ${ref} LIMIT 1
  `) as { is_disco_native: boolean | null; fm_restaurant_reference: string | null }[]
  const cache = (await sql`SELECT name FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} LIMIT 1`) as { name: string | null }[]
  const restaurantName = cache[0]?.name ?? null

  if (!acct.length) {
    return { eligible: false, reason: 'Restaurant not found.', restaurantName, orderCount: 0, order: null }
  }
  if (acct[0].is_disco_native !== true || acct[0].fm_restaurant_reference) {
    return {
      eligible: false,
      reason: 'FM-backed — a Neon-only delete would be silently re-created by the daily map-cache cron (it reads FM\'s live restaurant list and upserts, never deletes). This tool only works for Disco-native restaurants with no FM record.',
      restaurantName, orderCount: 0, order: null,
    }
  }

  const orders = (await sql`
    SELECT id, total, order_status, customer_email, customer_first_name, customer_last_name, placed_at
    FROM disco_orders WHERE restaurant_reference = ${ref}::uuid AND is_deleted = false
    ORDER BY placed_at DESC NULLS LAST
  `.catch(() => [])) as {
    id: number; total: string | number | null; order_status: string | null
    customer_email: string | null; customer_first_name: string | null; customer_last_name: string | null
    placed_at: string | null
  }[]

  if (orders.length > 1) {
    return {
      eligible: false,
      reason: `${orders.length} orders exist — refusing outright. This tool only deletes restaurants with 0 or 1 order.`,
      restaurantName, orderCount: orders.length, order: null,
    }
  }

  const order = orders[0]
    ? {
        total: order_total(orders[0].total), status: orders[0].order_status,
        customerEmail: orders[0].customer_email,
        customerName: `${orders[0].customer_first_name || ''} ${orders[0].customer_last_name || ''}`.trim() || null,
        placedAt: orders[0].placed_at,
      }
    : null

  return { eligible: true, reason: null, restaurantName, orderCount: orders.length, order }
}

function order_total(v: string | number | null): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const access = await requireArchiveAccess()
  if (!access.ok) return access.response
  const { ref } = await params

  try {
    const eligibility = await checkEligibility(ref)
    if (!eligibility.eligible) return NextResponse.json(eligibility)
    const rowCounts = await previewRestaurantDelete(ref)
    return NextResponse.json({ ...eligibility, rowCounts })
  } catch (e) {
    console.error('[permanent-delete] preview failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to build delete preview' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const access = await requireArchiveAccess()
  if (!access.ok) return access.response
  const { ref } = await params

  let body: { confirmOrderCount?: unknown; confirmRowCounts?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

  try {
    const eligibility = await checkEligibility(ref)
    if (!eligibility.eligible) {
      return NextResponse.json({ error: eligibility.reason || 'Not eligible for permanent delete.' }, { status: 409 })
    }

    const liveRowCounts = await previewRestaurantDelete(ref)
    // Re-derive and compare — never trust a client-supplied preview verbatim.
    // Anything having changed since the client last previewed (a new order
    // placed, a menu item added) means the confirmation is stale; refuse and
    // make the caller re-preview rather than deleting more than what was shown.
    if (body.confirmOrderCount !== eligibility.orderCount) {
      return NextResponse.json({ error: 'Order count changed since preview — re-check before deleting.' }, { status: 409 })
    }
    const confirmed = (body.confirmRowCounts || {}) as DeleteRowCounts
    for (const [table, count] of Object.entries(liveRowCounts)) {
      if (confirmed[table] !== count) {
        return NextResponse.json({ error: `Row counts changed since preview (${table}) — re-check before deleting.` }, { status: 409 })
      }
    }

    // Audit row BEFORE the delete, and disco_admin_audit is explicitly
    // excluded from the delete sweep — this record survives.
    await logAdminAction({
      action: 'restaurant_permanent_delete',
      restaurantReference: ref,
      actorEmail: access.email,
      detail: { restaurantName: eligibility.restaurantName, orderCount: eligibility.orderCount, rowCounts: liveRowCounts },
    })

    const summary = await deleteRestaurantPermanently(ref)
    return NextResponse.json({ ok: true, restaurantName: eligibility.restaurantName, rowCounts: summary })
  } catch (e) {
    console.error('[permanent-delete] delete failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
  }
}
