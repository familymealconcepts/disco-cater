import { NextResponse } from 'next/server'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'
import { refreshRestaurantAdminListCache } from '../../../../lib/restaurant-admin-list-cache'

// Manual "Refresh Now" trigger for the ordering page's restaurant admin-list
// cache — for an admin who knows something changed on FM's side and doesn't
// want to wait for the next 15-min cron tick. Admin-cookie gated. Runs the
// exact same sequential-fetch + reconcile + staging-swap logic as the cron.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST() {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }

  const result = await refreshRestaurantAdminListCache()
  console.log('[refresh-restaurant-admin-list-cache] done:', JSON.stringify(result))
  return NextResponse.json(result, { status: result.ok ? 200 : 500 })
}
