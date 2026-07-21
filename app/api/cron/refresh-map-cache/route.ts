// Daily cron: rebuild the public restaurant map cache (disco_restaurant_cache)
// from FamilyMeal.
//
// Runs at 04:00 UTC (see vercel.json) with its OWN 300s budget. This used to be
// a tail step of /api/cron/sync-restaurants, sharing one invocation with the
// FM→Sanity mirror. The two together did not fit: the cache refresh alone needs
// ~156s and the Sanity sync consumed most of the rest, so the cache only fully
// refreshed on 2 days in 6 weeks while the cron ran daily. Splitting them gives
// each job a full budget instead of making them compete.
//
// This is the USER-FACING half: disco_restaurant_cache feeds /api/restaurants
// (the marketplace + fullmap) and every restaurant page. It needs FM only —
// no Sanity, no SANITY_TOKEN.
//
// REQUIRED ENV (set in Vercel):
//   CRON_SECRET   shared secret. Vercel Cron sends it as
//                 `Authorization: Bearer ${CRON_SECRET}`.
//   FM service credentials, via lib/restaurant-cache.ts.
//
// Triggers:
//   • GET  — Vercel Cron + CLI. Requires `Authorization: Bearer <CRON_SECRET>`.
//   • POST — super-admin, authorized by the admin session cookie (so CRON_SECRET
//            is never shipped to the browser), or by the same Bearer secret.
//            The existing "Refresh Map Cache" admin button calls
//            /api/admin/refresh-restaurant-cache and is unaffected.
import { NextRequest, NextResponse } from 'next/server'
import { getAdminTokenFromRequest } from '../../../../lib/admin-auth'
import { refreshRestaurantCache } from '../../../../lib/restaurant-cache'
import { alertOps } from '../../../../lib/ops-alert'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

async function handle(): Promise<NextResponse> {
  const startedAt = Date.now()
  try {
    const result = await refreshRestaurantCache()
    console.log('[refresh-map-cache] done:', JSON.stringify(result))
    return NextResponse.json({ success: true, ...result })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await alertOps('refresh-map-cache: FAILED — public marketplace data is now stale', {
      error, elapsedMs: Date.now() - startedAt,
    })
    return NextResponse.json({ success: false, error }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return handle()
}

export async function POST(req: NextRequest) {
  const ok = hasCronSecret(req) || !!getAdminTokenFromRequest(req)
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return handle()
}
