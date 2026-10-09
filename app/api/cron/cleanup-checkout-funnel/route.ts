import { NextRequest, NextResponse } from 'next/server'
import { sql, withDiscoTables, runCheckoutFunnelMigrations, runCheckoutContactsMigrations } from '../../../../lib/db'

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

    // disco_checkout_contacts retention: 30 days -- a THIRD of the funnel's 90,
    // on purpose. That table holds a name, email and phone for people who mostly
    // never ordered; it exists for a timely follow-up on an abandoned cart, and a
    // cart a month old is past following up, so there is no reason to hold the PII
    // longer. Keyed on updated_at (last capture or the order stamp), same as the
    // funnel. Its own try/catch: a failure here must not mask the funnel cleanup
    // above, which has already run and is reported either way.
    let contactsDeleted: number | null = null
    try {
      const contactRows = await withDiscoTables(
        () => sql`
          DELETE FROM disco_checkout_contacts
          WHERE updated_at < NOW() - INTERVAL '30 days'
          RETURNING session_id
        `,
        runCheckoutContactsMigrations,
      ) as { session_id: string }[]
      contactsDeleted = contactRows.length
    } catch (err) {
      console.error('[cron/cleanup-checkout-funnel] checkout-contacts cleanup failed:', err instanceof Error ? err.message : err)
    }

    console.log(`[cron/cleanup-checkout-funnel] deleted=${rows.length} contactsDeleted=${contactsDeleted ?? 'failed'}`)
    if (contactsDeleted === null) {
      return NextResponse.json({ error: 'Checkout-contacts cleanup failed', deleted: rows.length }, { status: 500 })
    }
    return NextResponse.json({ ok: true, deleted: rows.length, contactsDeleted })
  } catch (err) {
    console.error('[cron/cleanup-checkout-funnel] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Cleanup failed' }, { status: 500 })
  }
}
