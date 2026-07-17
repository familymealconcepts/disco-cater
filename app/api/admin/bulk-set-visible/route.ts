import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'

// Targeted bulk visibility tool for the Disco fullmap. Admin-only.
//
//   { restaurantReferences: [..] } → upsert visible=true for just those refs.
//
// M4 (visibility source of truth): the former { all: true } branch — which
// derived the visible set from FM restaurant status (ACCEPTED && !blocked) — was
// removed so FM data can no longer drive Disco marketplace visibility. Disco's own
// per-restaurant toggle (portal + super-admin) is now the single source of truth.
// Only the explicit, admin-chosen targeted branch remains.

export async function POST(req: NextRequest) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }

  try {
    await runMigrations()
    const body = await req.json().catch(() => null)

    // ── Targeted: upsert visible=true for the given references only ──
    if (Array.isArray(body?.restaurantReferences)) {
      const refs = (body.restaurantReferences as unknown[])
        .map((r) => (r == null ? '' : String(r)))
        .filter(Boolean)
      let updated = 0
      let inserted = 0
      for (const ref of refs) {
        const rows = (await sql`
          INSERT INTO disco_restaurant_overrides (restaurant_reference, visible, updated_at)
          VALUES (${ref}, true, NOW())
          ON CONFLICT (restaurant_reference) DO UPDATE SET visible = true, updated_at = NOW()
          RETURNING (xmax = 0) AS inserted
        `) as { inserted: boolean }[]
        if (rows[0]?.inserted) inserted++
        else updated++
      }
      return NextResponse.json({ updated, inserted })
    }

    // { all: true } is intentionally no longer supported (see header note).
    return NextResponse.json({ error: 'Provide { restaurantReferences: [...] }. Bulk "show all from FM" was removed — Disco controls visibility.' }, { status: 400 })
  } catch (e) {
    console.error('[bulk-set-visible] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Bulk visibility update failed' }, { status: 500 })
  }
}
