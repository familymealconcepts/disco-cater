import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../lib/restaurant-auth'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const sp = req.nextUrl.searchParams
  const params = new URLSearchParams()
  params.set('page', sp.get('page') || '0')
  params.set('size', sp.get('size') || '25')
  if (sp.get('sort')) params.set('sort', sp.get('sort')!)
  if (sp.get('search')) params.set('search', sp.get('search')!)
  try {
    const res = await fetch(`${FM}/api/system-admin/users?${params}`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch users' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch users' }, { status: 500 })
  }
}

// ── NO LONGER WRITES TO FAMILYMEAL (22 Oct 2026) ──────────────────────────────
// Disco owns users and their locations and never writes changes to FamilyMeal
// (Peter). This route used to proxy create to FM's /api/system-admin/users,
// which created/edited/deleted FamilyMeal users and their location lists. The
// team screen now saves to Disco for every session (app/api/restaurant/team*),
// so the write is refused here rather than forwarded. Reads are unchanged.
export async function POST() {
  return NextResponse.json({
    error: 'Team changes are saved in Disco Cater now. Reload the Authorized Users page to manage this person.',
  }, { status: 410 })
}
