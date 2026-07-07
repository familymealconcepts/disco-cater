import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'
import { fetchFmRestaurantEmailPage } from '../../../../lib/admin/fm-restaurant-emails'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// One-time export of every FamilyMeal restaurant's admin email (active + inactive),
// which lives in FM, not Neon. BATCHED: each call returns ONE page of restaurants
// via the SUPER_ADMIN service account, so no single request has to walk the whole
// list. The admin console loops pages with live progress, dedupes by email, and
// downloads the CSV client-side. Admin-gated. Params: ?page=N&size=M (default 200).
export async function GET(req: NextRequest) {
  try { await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const page = Math.max(0, Number(req.nextUrl.searchParams.get('page')) || 0)
  const size = Math.min(500, Math.max(1, Number(req.nextUrl.searchParams.get('size')) || 200))
  try {
    const result = await fetchFmRestaurantEmailPage(page, size)
    return NextResponse.json(result)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[export-fm-restaurant-emails] page', page, 'failed:', message)
    return NextResponse.json({ error: message, page }, { status: 502 })
  }
}
