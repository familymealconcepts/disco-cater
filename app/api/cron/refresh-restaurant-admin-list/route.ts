// Cron: rebuild the FM restaurant admin-list cache
// (disco_restaurant_admin_list_cache) that manage-restaurants/ordering reads
// instead of calling FM directly. Runs every 15 minutes (see vercel.json).
//
// REQUIRED ENV (set in Vercel):
//   CRON_SECRET   shared secret. Vercel Cron sends it as
//                 `Authorization: Bearer ${CRON_SECRET}`.
//   FM service credentials, via lib/fm-service-auth.ts.
//
// Triggers:
//   • GET  — Vercel Cron + CLI. Requires `Authorization: Bearer <CRON_SECRET>`.
//   • POST — super-admin, authorized by the admin session cookie (so
//            CRON_SECRET is never shipped to the browser), or by the same
//            Bearer secret. The "Refresh Now" button on the ordering page
//            calls /api/admin/refresh-restaurant-admin-list-cache instead
//            (admin-cookie only, no secret exposure risk either way).
import { NextRequest, NextResponse } from 'next/server'
import { isVerifiedSuperAdminRequest } from '../../../../lib/admin-auth'
import { refreshRestaurantAdminListCache } from '../../../../lib/restaurant-admin-list-cache'
import { withCronRun } from '../../../../lib/cron-runs'
import { syncMoneyFlowFromFamilyMeal } from '../../../../lib/money-flow-sync-server'
import { getFmServiceAuthHeader } from '../../../../lib/fm-service-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

async function handle(): Promise<NextResponse> {
  const result = await refreshRestaurantAdminListCache()
  console.log('[refresh-restaurant-admin-list] done:', JSON.stringify(result))
  // With FamilyMeal's values fresh, make Disco's Hold Payments match FamilyMeal's for any restaurant
  // where they differ (someone changed it in FamilyMeal's own admin). Writes Disco only, audits each
  // change, and alerts only when a restaurant can't be brought back in sync
  // (lib/money-flow-sync-server.ts). Best-effort, so the refresh's own result is never affected.
  let moneyFlowMismatches: number | null = null
  let moneyFlowSynced: number | null = null
  let moneyFlowUnresolved: number | null = null
  if (result.ok) {
    try {
      const run = await syncMoneyFlowFromFamilyMeal(await getFmServiceAuthHeader())
      moneyFlowMismatches = run.checked
      moneyFlowSynced = run.synced.length
      moneyFlowUnresolved = run.unresolved.length
    } catch (e) {
      console.error('[refresh-restaurant-admin-list] Hold Payments sync failed:', e instanceof Error ? e.message : e)
    }
  }
  return NextResponse.json({ ...result, moneyFlowMismatches, moneyFlowSynced, moneyFlowUnresolved }, { status: result.ok ? 200 : 500 })
}

async function runGet(req: NextRequest) {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return handle()
}

export async function POST(req: NextRequest) {
  const ok = hasCronSecret(req) || await isVerifiedSuperAdminRequest(req)
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return handle()
}

// Every run is recorded in disco_cron_runs for NM OS Platform Health (lib/cron-runs.ts).
export const GET = withCronRun('refresh-restaurant-admin-list', runGet)
