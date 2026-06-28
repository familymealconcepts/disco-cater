import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantRef } from '../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../lib/restaurant-auth-context'
import { sql, runMigrations } from '../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function PATCH(req: NextRequest) {
  const ctx = await getRestaurantAuthContext()
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const ref = ctx.restaurantReference || (await getRestaurantRef()) || ''

  const allowed = req.nextUrl.searchParams.get('onlineOrderingAllowed') === 'true'

  // FM is the source of truth for FM-backed restaurants; only call it when the
  // user actually has an FM session (Disco-native restaurants have none).
  let fmOk = true
  if (ctx.fmToken) {
    try {
      const res = await fetch(`${FM}/api/restaurants/onlineOrdering?onlineOrderingAllowed=${allowed}`, {
        method: 'PATCH',
        headers: { Authorization: ctx.fmToken },
      })
      fmOk = res.ok
    } catch {
      fmOk = false
    }
  }

  // Disco-side mirror so the super admin view + Disco-native restaurants have a
  // source of truth. Best-effort; never blocks the response.
  if (ref) {
    try {
      await runMigrations()
      await sql`
        INSERT INTO disco_restaurant_overrides (restaurant_reference, online_ordering_enabled, updated_at)
        VALUES (${ref}, ${allowed}, NOW())
        ON CONFLICT (restaurant_reference) DO UPDATE SET online_ordering_enabled = ${allowed}, updated_at = NOW()
      `
    } catch (e) {
      console.error('[online-ordering] Neon mirror failed:', e instanceof Error ? e.message : e)
    }
  }

  if (!fmOk) return NextResponse.json({ error: 'Failed' }, { status: 502 })
  return NextResponse.json({ ok: true, onlineOrderingAllowed: allowed })
}
