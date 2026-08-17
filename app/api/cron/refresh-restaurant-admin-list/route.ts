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
import { getAdminTokenFromRequest } from '../../../../lib/admin-auth'
import { refreshRestaurantAdminListCache } from '../../../../lib/restaurant-admin-list-cache'

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
  return NextResponse.json(result, { status: result.ok ? 200 : 500 })
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
