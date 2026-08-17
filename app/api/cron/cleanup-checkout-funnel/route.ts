import { NextRequest, NextResponse } from 'next/server'
import { sql, withDiscoTables, runCheckoutFunnelMigrations } from '../../../../lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// disco_checkout_funnel_sessions retention: 90 days. These rows are
// disposable analytics data, some holding identifiable session behavior
// (contact_entered) — bounded retention is deliberate, not just cleanup
// hygiene. Runs daily (unlike the hourly reconciliation crons this session
// also added) since a 90-day window doesn't need sub-day precision; the
// route/auth shape otherwise matches those crons exactly.
function hasCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const auth = req.headers.get('authorization') || ''
  return auth === `Bearer ${secret}` || auth === secret
}

export async function GET(req: NextRequest) {
  if (!hasCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const rows = await withDiscoTables(
      () => sql`
        DELETE FROM disco_checkout_funnel_sessions
        WHERE updated_at < NOW() - INTERVAL '90 days'
        RETURNING session_id
      `,
      runCheckoutFunnelMigrations,
    ) as { session_id: string }[]
    console.log(`[cron/cleanup-checkout-funnel] deleted=${rows.length}`)
    return NextResponse.json({ ok: true, deleted: rows.length })
  } catch (err) {
    console.error('[cron/cleanup-checkout-funnel] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Cleanup failed' }, { status: 500 })
  }
}
