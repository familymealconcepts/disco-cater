import { NextRequest, NextResponse } from 'next/server'
import { runMigrations } from '../../../../lib/db'
import { getAdminAuthHeader, getAdminEmail } from '../../../../lib/admin-auth'
import { setMarketplaceVisible } from '../../../../lib/marketplace-switch'

// Targeted bulk visibility tool for the Disco fullmap. Admin-only.
//
//   { restaurantReferences: [..] } → upsert visible=true for just those refs.
//
// M4 (visibility source of truth): the former { all: true } branch — which
// derived the visible set from FM restaurant status (ACCEPTED && !blocked) — was
// removed so FM data can no longer drive Disco marketplace visibility. Disco's own
// per-restaurant toggle (portal + super-admin) is now the single source of truth.
// Only the explicit, admin-chosen targeted branch remains.
//
// Each ref goes through lib/marketplace-switch.ts. A TEST restaurant is refused
// there; this tool SKIPS it and reports it under `skippedTest` rather than
// failing the batch — one test row in a pasted list should not stop the rest.
// Every change and every refusal is audited by the helper, one row per ref.

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
      const skippedTest: string[] = []
      const actorEmail = await getAdminEmail().catch(() => null)
      for (const ref of refs) {
        const r = await setMarketplaceVisible(ref, true, { source: 'admin-bulk', actorEmail, authType: 'admin' })
        if (!r.ok) { skippedTest.push(ref); continue }
        if (r.inserted) inserted++
        else updated++
      }
      return NextResponse.json({ updated, inserted, skippedTest })
    }

    // { all: true } is intentionally no longer supported (see header note).
    return NextResponse.json({ error: 'Provide { restaurantReferences: [...] }. Bulk "show all from FM" was removed — Disco controls visibility.' }, { status: 400 })
  } catch (e) {
    console.error('[bulk-set-visible] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Bulk visibility update failed' }, { status: 500 })
  }
}
