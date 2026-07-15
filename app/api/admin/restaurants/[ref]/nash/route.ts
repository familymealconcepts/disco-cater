import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../../../lib/admin-auth'
import { sql, runMigrations } from '../../../../../../lib/db'
import { isDiscoNativeRestaurant } from '../../../../../../lib/order/native-checkout'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

// PATCH /api/admin/restaurants/{ref}/nash?nashAllowed={bool}
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ ref: string }> }) {
  let h: Record<string, string>
  try { h = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { ref } = await params
  const nash = req.nextUrl.searchParams.get('nashAllowed') || 'false'

  // Disco-native: no FM record — persist the toggle to Neon so it sticks instead
  // of the FM proxy 404ing and the UI silently reverting it (S5).
  if (await isDiscoNativeRestaurant(ref)) {
    try {
      await runMigrations()
      await sql`
        INSERT INTO disco_restaurant_overrides (restaurant_reference, nash_allowed, updated_at)
        VALUES (${ref}, ${nash === 'true'}, NOW())
        ON CONFLICT (restaurant_reference) DO UPDATE SET nash_allowed = ${nash === 'true'}, updated_at = NOW()
      `
      return NextResponse.json({ ok: true, native: true })
    } catch (e) {
      console.error('[nash] native write failed:', e instanceof Error ? e.message : e)
      return NextResponse.json({ error: 'Unable to toggle nash' }, { status: 500 })
    }
  }

  try {
    const res = await fetch(`${FM}/api/admin/restaurants/${ref}/nashAllowed?nashAllowed=${nash}`, { method: 'PATCH', headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to toggle nash' }, { status: res.status })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to toggle nash' }, { status: 500 })
  }
}
