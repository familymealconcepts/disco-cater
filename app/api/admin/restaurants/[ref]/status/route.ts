import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader, getAdminEmail } from '../../../../../../lib/admin-auth'
import { isDiscoNativeRestaurant } from '../../../../../../lib/order/native-checkout'
import { archiveDiscoNativeRestaurant, restoreDiscoNativeRestaurant } from '../../../../../../lib/disco-restaurant-archive'
import { sql, runMigrations } from '../../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// POST /api/admin/restaurants/{ref}/status?status={ACTIVE|INACTIVE|SUSPENDED|ARCHIVED}
//
// KEYED ON THE RESTAURANT. FamilyMeal's status column does not govern a
// Disco-native restaurant — the marketplace feed reads
// disco_restaurant_cache.is_live and disco_restaurant_overrides.archived_at — so
// suspending or archiving one through FM reported success and changed nothing a
// customer could see.
//
// The mapping onto Disco's own two concepts:
//   ACTIVE              → live, and un-archived if it was archived
//   INACTIVE, SUSPENDED → not live (off the marketplace, restaurant intact)
//   ARCHIVED            → archived, via the SAME helper the rest of the app uses
//                         (lib/disco-restaurant-archive.ts), which also mirrors
//                         the flag onto the cache and suffixes the name
//
// INACTIVE and SUSPENDED land on the same Disco state deliberately: Disco has no
// third thing for them to mean, and inventing one here would make this route the
// only place in the codebase that believed in it.
const NATIVE_STATUSES = new Set(['ACTIVE', 'INACTIVE', 'SUSPENDED', 'ARCHIVED'])

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
    if (!NATIVE_STATUSES.has(s)) {
      return NextResponse.json({ error: `Unsupported status for a Disco Cater restaurant: ${status}` }, { status: 400 })
    }
    try {
      await runMigrations()
      if (s === 'ARCHIVED') {
        await archiveDiscoNativeRestaurant(ref, await getAdminEmail())
        return NextResponse.json({ ok: true, native: true, status: s })
      }
      if (s === 'ACTIVE') {
        // Restore first (a no-op when it was never archived), then bring it live.
        await restoreDiscoNativeRestaurant(ref)
        await sql`UPDATE disco_restaurant_cache SET is_live = true, cached_at = NOW() WHERE restaurant_reference = ${ref}`
        return NextResponse.json({ ok: true, native: true, status: s })
      }
      await sql`UPDATE disco_restaurant_cache SET is_live = false, cached_at = NOW() WHERE restaurant_reference = ${ref}`
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
