// Daily cron: check every Disco-native restaurant's FM-side menu for drift
// against the baseline captured at last import/verification (lib/menu-drift.ts).
//
// A converted restaurant's native menu is a frozen snapshot — nothing else in
// the codebase re-checks FM after conversion. This is READ-ONLY against FM and
// never touches the native menu; it only updates disco_menu_drift_snapshots
// (has_drift / drift_details), which the admin restaurant list badge and the
// EditRestaurantDialog panel read.
//
// A restaurant is skipped (not flagged) when FM has no real record for its
// reference — expected for native restaurants with no FM twin at all.
//
// Triggers:
//   • GET  — Vercel Cron + CLI. Requires `Authorization: Bearer <CRON_SECRET>`.
//   • POST — super-admin (admin session cookie) or the same Bearer secret, so
//            this can also be triggered on demand from the admin UI.
import { NextRequest, NextResponse } from 'next/server'
import { sql } from '../../../../lib/db'
import { getAdminTokenFromRequest } from '../../../../lib/admin-auth'
import { checkMenuDrift } from '../../../../lib/menu-drift'
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
    const rows = (await sql`
      SELECT restaurant_reference FROM disco_restaurant_cache WHERE is_disco_native = true
    `.catch(() => [])) as { restaurant_reference: string }[]

    let checked = 0, skipped = 0, drifted = 0, errored = 0
    const drifts: { restaurantReference: string; changeCount: number }[] = []
    for (const r of rows) {
      try {
        const result = await checkMenuDrift(r.restaurant_reference, r.restaurant_reference)
        if (!result.checked) { skipped++; continue }
        checked++
        if (result.hasDrift) { drifted++; drifts.push({ restaurantReference: r.restaurant_reference, changeCount: result.details.length }) }
      } catch (e) {
        errored++
        console.error('[cron/menu-drift-check]', r.restaurant_reference, e instanceof Error ? e.message : e)
      }
    }

    const summary = { total: rows.length, checked, skipped, drifted, errored, elapsedMs: Date.now() - startedAt }
    console.log('[menu-drift-check] done:', JSON.stringify(summary))
    // Slack notification intentionally removed (2026-08-07, Peter's call) — detection
    // still runs exactly as before and every result still lands in
    // disco_menu_drift_snapshots (has_drift/drift_details, written inside
    // checkMenuDrift). Nothing pushes this anymore; check the manage-restaurants admin
    // list badge or EditRestaurantDialog's drift panel to see it.
    return NextResponse.json({ success: true, ...summary, drifts })
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    await alertOps('menu-drift-check: FAILED', { error, elapsedMs: Date.now() - startedAt })
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
