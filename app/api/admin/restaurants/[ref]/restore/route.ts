import { NextRequest, NextResponse } from 'next/server'
import { sql } from '../../../../../../lib/db'
import { restoreDiscoNativeRestaurant } from '../../../../../../lib/disco-restaurant-archive'
import { requireArchiveAccess } from '../../../../../../lib/admin-archive-access'
import { logAdminAction } from '../../../../../../lib/admin-audit'

// Archive eligibility check — matches ../route.ts's isCurrentlyNative, NOT
// the narrower "never had any FM record" check used elsewhere in that file
// for editing. The canonical "is this restaurant native right now" signal is
// disco_restaurant_cache.is_disco_native alone — most real native restaurants
// carry a residual fm_restaurant_reference from their conversion (an
// audit/historical link, not a live-FM-presence flag), so checking that
// column here would wrongly refuse to restore almost every real one.
async function isCurrentlyNative(ref: string): Promise<boolean> {
  try {
    const rows = (await sql`
      SELECT 1 FROM disco_restaurant_cache WHERE restaurant_reference = ${ref} AND is_disco_native = true LIMIT 1
    `) as unknown[]
    return rows.length > 0
  } catch {
    return false
  }
}

// Restore an archived Disco-native restaurant — the genuine inverse of DELETE
// in ../route.ts: clears archived_at across the three identity tables. Does
// NOT resurrect any invite token that archiving revoked — a restored
// restaurant's admin gets a fresh invite sent, not an old one un-expired (see
// lib/disco-restaurant-archive.ts). Does NOT re-run anything else: no cache to
// invalidate (every discovery surface reads Neon fresh — see
// lib/marketplace-restaurants.ts), and SYSTEM_ADMIN scope is a live query
// (lib/disco-restaurant-auth.ts's getDiscoGroupAccounts) that picks the
// restored location back up on its own next request.
//
// FM-backed restore is not implemented — archiving an FM-backed restaurant is
// deferred (see ../route.ts), so there is nothing to restore on that path.
// Same two-account allowlist as archiving, enforced at the route.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  const access = await requireArchiveAccess()
  if (!access.ok) return access.response
  const { ref } = await params

  if (!(await isCurrentlyNative(ref))) {
    return NextResponse.json({ error: 'Restore is only available for Disco-native restaurants.' }, { status: 501 })
  }

  try {
    await restoreDiscoNativeRestaurant(ref)
    await logAdminAction({ action: 'restaurant_restore', restaurantReference: ref, actorEmail: access.email })
    return NextResponse.json({ ok: true, restored: true })
  } catch (e) {
    console.error('[admin/restaurants restore] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to restore restaurant' }, { status: 500 })
  }
}
