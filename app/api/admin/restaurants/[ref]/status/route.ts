import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader, getAdminEmail } from '../../../../../../lib/admin-auth'
import { isDiscoNativeRestaurant } from '../../../../../../lib/order/native-checkout'
import { archiveDiscoNativeRestaurant, restoreDiscoNativeRestaurant } from '../../../../../../lib/disco-restaurant-archive'
import { runMigrations } from '../../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// POST /api/admin/restaurants/{ref}/status?status={ACTIVE|INACTIVE|SUSPENDED|ARCHIVED}
//
// KEYED ON THE RESTAURANT. FamilyMeal's status column does not govern a
// Disco-native restaurant, so suspending or archiving one through FM reported
// success and changed nothing a customer could see.
//
// ── is_live IS GONE. THE LIVE/NOT-LIVE HALF OF THIS ROUTE WENT WITH IT ──────
// This route used to write disco_restaurant_cache.is_live: ACTIVE set it true,
// INACTIVE/SUSPENDED set it false. is_live is not a real concept — two rules
// decide everything, and this was neither of them:
//   • Stripe connected AND online ordering on -> the ordering page displays
//   • marketplace toggle on                   -> it is on the marketplace
//
// So INACTIVE and SUSPENDED are REFUSED for a native restaurant rather than
// quietly writing a column nothing reads. Silently accepting them would be
// worse than removing them: a super admin would press "Suspend", get a success,
// and the restaurant would still be selling. The refusal names the controls
// that actually do it.
//
// ARCHIVED and ACTIVE REMAIN, and are the reason this route still exists:
//   ACTIVE   → un-archive (restore), nothing else
//   ARCHIVED → archive, via the SAME helper the rest of the app uses
//              (lib/disco-restaurant-archive.ts), which mirrors the flag onto
//              the cache and suffixes the name
// Archive is a genuinely separate, STRONGER gate than either rule above — it is
// checked ahead of them on the customer page — so it must not be removed with
// is_live.
const NATIVE_STATUSES = new Set(['ACTIVE', 'ARCHIVED'])

export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  const status = req.nextUrl.searchParams.get('status')
  if (!status) return NextResponse.json({ error: 'status required' }, { status: 400 })

  if (await isDiscoNativeRestaurant(ref)) {
    const s = status.toUpperCase()
    if (s === 'INACTIVE' || s === 'SUSPENDED') {
      return NextResponse.json({
        error: 'Disco Cater restaurants have no "inactive" or "suspended" state. ' +
          'To take one off the marketplace, turn its marketplace toggle off. ' +
          'To stop it taking orders, turn online ordering off. ' +
          'To remove it entirely, archive it.',
      }, { status: 400 })
    }
    if (!NATIVE_STATUSES.has(s)) {
      return NextResponse.json({ error: `Unsupported status for a Disco Cater restaurant: ${status}` }, { status: 400 })
    }
    try {
      await runMigrations()
      if (s === 'ARCHIVED') {
        await archiveDiscoNativeRestaurant(ref, await getAdminEmail())
        return NextResponse.json({ ok: true, native: true, status: s })
      }
      // ACTIVE is now ONLY "un-archive". It no longer brings a restaurant live,
      // because nothing is gated on live any more — whether it sells and whether
      // it is listed are the two toggles named above, and this route must not
      // quietly flip either of them on the operator's behalf.
      await restoreDiscoNativeRestaurant(ref)
      return NextResponse.json({ ok: true, native: true, status: s })
    } catch (e) {
      console.error('[admin/restaurants/status] native update failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Unable to change status' }, { status: 500 })
    }
  }

  try {
    const res = await fetch(`${FM}/api/admin/restaurants/${ref}?status=${status}`, { method: 'POST', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to change status' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to change status' }, { status: 500 })
  }
}
