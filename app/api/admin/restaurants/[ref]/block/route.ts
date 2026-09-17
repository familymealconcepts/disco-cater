import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import { isDiscoNativeRestaurant } from '../../../../../../lib/order/native-checkout'
import { sql, runMigrations } from '../../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// POST /api/admin/restaurants/{ref}/block?block={bool}
// FM-backed: forwards to FM POST /api/admin/restaurants/manage/block/{ref}.
//
// KEYED ON THE RESTAURANT BEING ACTED ON, not on the caller. Blocking a
// Disco-native restaurant through FamilyMeal changed a record that no longer
// governs it: the marketplace feed reads disco_restaurant_cache.is_live, so the
// restaurant stayed live on Disco Cater while the toggle reported success. Same
// semantics the restaurant portal already uses for a native location
// (app/api/restaurant/locations/[ref]/block).
export async function POST(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  const block = req.nextUrl.searchParams.get('block') || 'true'

  if (await isDiscoNativeRestaurant(ref)) {
    try {
      await runMigrations()
      await sql`UPDATE disco_restaurant_cache SET is_live = ${block !== 'true'}, cached_at = NOW() WHERE restaurant_reference = ${ref}`
      return NextResponse.json({ ok: true, native: true, blocked: block === 'true' })
    } catch (e) {
      console.error('[admin/restaurants/block] native update failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Unable to toggle block' }, { status: 500 })
    }
  }

  try {
    const res = await fetch(`${FM}/api/admin/restaurants/manage/block/${ref}?block=${block}`, { method: 'POST', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to toggle block' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to toggle block' }, { status: 500 })
  }
}
