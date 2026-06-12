import { NextResponse } from 'next/server'
import { getAdminRole } from '../../../../../lib/admin-auth'
import { sql, runMigrations } from '../../../../../lib/db'

export const runtime = 'nodejs'

// Deletes all dashboard-generated test records from Neon. Test data is identified
// by the playwright+* email prefix (accounts/sessions) and the [TEST] name prefix
// (cache/overrides). SUPER_ADMIN only.
export async function POST() {
  if ((await getAdminRole()) !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    await runMigrations()

    const accounts = (await sql`DELETE FROM disco_restaurant_accounts WHERE email LIKE 'playwright+%' RETURNING id`) as unknown[]
    const sessions = (await sql`DELETE FROM disco_restaurant_sessions WHERE email LIKE 'playwright+%' RETURNING id`) as unknown[]
    // Delete overrides BEFORE cache so the cache subquery still resolves the refs.
    const overrideRows = (await sql`
      DELETE FROM disco_restaurant_overrides
      WHERE restaurant_reference IN (SELECT restaurant_reference FROM disco_restaurant_cache WHERE name LIKE '[TEST]%')
      RETURNING restaurant_reference
    `) as unknown[]
    const cacheRows = (await sql`DELETE FROM disco_restaurant_cache WHERE name LIKE '[TEST]%' RETURNING restaurant_reference`) as unknown[]

    return NextResponse.json({
      deleted: {
        accounts: accounts.length,
        sessions: sessions.length,
        cacheRows: cacheRows.length,
        overrideRows: overrideRows.length,
      },
    })
  } catch (err) {
    console.error('[admin/tests/cleanup] failed:', err instanceof Error ? err.message : err)
    return NextResponse.json({ error: 'Cleanup failed.' }, { status: 500 })
  }
}
