import { NextRequest, NextResponse } from 'next/server'
import { requireArchiveAccess } from '../../../../../../lib/admin-archive-access'
import { logAdminAction } from '../../../../../../lib/admin-audit'
import { previewRestaurantDelete, deleteRestaurantPermanently, checkDeleteEligibility, type DeleteRowCounts } from '../../../../../../lib/disco-restaurant-delete'

// Permanent delete — the "Delete" item in each row's ⋯ menu on Super Admin →
// Restaurants → Ordering (Peter, 22 Oct 2026). Archive covers "gone but
// restorable"; this removes a location that should not exist at all. Same
// verified super-admin + two-account gate as archive/restore.
//
// REFUSED, with the reason shown and Archive suggested, when the location has
// ANY money history or could take money: an order (deleted ones and FM history
// copies included — refunds and payouts only exist through orders), a payment
// record, or a Stripe account. Also refused when FamilyMeal backs it: deleting
// in Disco would be undone by the next sync, and FamilyMeal is never changed.
//
//   GET    → eligibility + preview (row counts per table). Never mutates.
//   DELETE → perform it. Body must carry the location's exact name, typed by
//            the admin, and echo back the EXACT rowCounts just previewed —
//            re-derived live and compared, so a stale preview can never
//            authorize deleting more than what was actually shown.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const access = await requireArchiveAccess()
  if (!access.ok) return access.response
  const { ref } = await params

  try {
    const eligibility = await checkDeleteEligibility(ref)
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

  let body: { confirmName?: unknown; confirmRowCounts?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }) }

  try {
    const eligibility = await checkDeleteEligibility(ref)
    if (!eligibility.eligible) {
      return NextResponse.json({ error: eligibility.reason || 'Not eligible for permanent delete.' }, { status: 409 })
    }

    const liveRowCounts = await previewRestaurantDelete(ref)
    // Re-derive and compare — never trust a client-supplied preview verbatim.
    // Anything having changed since the client last previewed (a new order
    // placed, a menu item added) means the confirmation is stale; refuse and
    // make the caller re-preview rather than deleting more than what was shown.
    const typed = typeof body.confirmName === 'string' ? body.confirmName.trim() : ''
    if (!eligibility.restaurantName || typed !== eligibility.restaurantName.trim()) {
      return NextResponse.json({ error: "The name typed doesn't match this location's name — nothing was deleted." }, { status: 400 })
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
      detail: { restaurantName: eligibility.restaurantName, rowCounts: liveRowCounts },
    })

    const summary = await deleteRestaurantPermanently(ref)
    return NextResponse.json({ ok: true, restaurantName: eligibility.restaurantName, rowCounts: summary })
  } catch (e) {
    console.error('[permanent-delete] delete failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
  }
}
