// Cron: mirror disco_restaurant_overrides.online_ordering_enabled from FM's
// onlineOrderingAllowed for every FM-BACKED restaurant. See
// lib/online-ordering-mirror.ts for the rule (FM owns it before conversion,
// Disco owns it after), why it drifted to 325 disagreeing rows, and why
// correcting an FM-backed row is inert until that restaurant converts.
//
// SCHEDULE: offset a few minutes past each quarter hour (see vercel.json) so it
// reads a freshly rebuilt disco_restaurant_admin_list_cache rather than racing
// refresh-restaurant-admin-list on the same minute. It makes no FM call itself.
//
// REQUIRED ENV (set in Vercel):
//   CRON_SECRET   shared secret. Vercel Cron sends it as
//                 `Authorization: Bearer ${CRON_SECRET}`.
//
// Triggers:
//   • GET  — Vercel Cron + CLI. Requires `Authorization: Bearer <CRON_SECRET>`.
//   • POST — super-admin, authorized by the admin session cookie, or by the
//            same Bearer secret. Accepts `?dryRun=1` so the correction set can
//            be previewed without writing.
import { NextRequest, NextResponse } from 'next/server'
import { getAdminTokenFromRequest } from '../../../../lib/admin-auth'
import { mirrorOnlineOrderingFromFm } from '../../../../lib/online-ordering-mirror'
import { alertOps } from '../../../../lib/ops-alert'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const startedAt = Date.now()
  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'
  try {
    const result = await mirrorOnlineOrderingFromFm({ dryRun })
    console.log('[mirror-online-ordering] done:', JSON.stringify({ ...result, flips: result.flips.length, dryRun }))
    return NextResponse.json({ success: true, dryRun, ...result })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await alertOps('mirror-online-ordering: FAILED', { error, elapsedMs: Date.now() - startedAt })
    return NextResponse.json({ success: false, error }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // The cron itself never dry-runs, whatever the query string says.
  return handle(new NextRequest(new URL(req.nextUrl.pathname, req.nextUrl.origin), req))
}

export async function POST(req: NextRequest) {
  const ok = hasCronSecret(req) || !!getAdminTokenFromRequest(req)
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return handle(req)
}
