import { NextRequest, NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'
import { checkMarketplaceReadiness } from '../../../../lib/marketplace-readiness'

// M4 — report-only marketplace drop-off guard. Given a restaurant reference,
// reports whether it is visible today and whether it would STAY visible if flipped
// to Disco-native, with the specific blocker(s). Read-only; changes nothing.
//   GET /api/admin/marketplace-readiness?restaurantReference=...
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }

  const ref = req.nextUrl.searchParams.get('restaurantReference')
  if (!ref) return NextResponse.json({ error: 'restaurantReference required' }, { status: 400 })

  try {
    return NextResponse.json(await checkMarketplaceReadiness(ref))
  } catch (e) {
    console.error('[marketplace-readiness] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Unable to check marketplace readiness' }, { status: 500 })
  }
}
