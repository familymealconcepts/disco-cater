import { NextRequest, NextResponse } from 'next/server'
import { verifySuperAdmin } from '../../../../../lib/admin-auth'
import { searchDiners, searchEligibleRestaurants } from '../../../../../lib/promotions/diner-promotions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/promotions/lookup?kind=diner|restaurant&q= — search as you type on the Add form.
// Restaurants are only those with a third-party delivery menu.
export async function GET(req: NextRequest) {
  const auth = await verifySuperAdmin()
  if (!auth.ok) return NextResponse.json({ error: 'Not authenticated' }, { status: auth.status })
  const kind = req.nextUrl.searchParams.get('kind')
  const q = (req.nextUrl.searchParams.get('q') || '').trim()
  if (q.length < 2) return NextResponse.json({ results: [] })
  if (kind === 'diner') return NextResponse.json({ results: await searchDiners(q) })
  if (kind === 'restaurant') return NextResponse.json({ results: await searchEligibleRestaurants(q) })
  return NextResponse.json({ error: 'kind must be diner or restaurant' }, { status: 400 })
}
