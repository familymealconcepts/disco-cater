import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'
import { getFmServiceAuthHeader } from '../../../../lib/fm-service-auth'

// One-time bulk visibility tool for the Disco fullmap. Admin-only.
//
//   { all: true }                 → mark every existing override visible, AND
//                                   insert visible=true rows for every ACCEPTED
//                                   + unblocked FM restaurant lacking an override.
//   { restaurantReferences: [..] } → upsert visible=true for just those refs.

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

type FmRow = Record<string, unknown>

// Fetch every page of FM's admin restaurants list with the service JWT (mirrors
// the /api/restaurants route). Retries once on 401 by force-refreshing.
async function fetchAllFmRestaurants(): Promise<FmRow[]> {
  const SIZE = 200
  const MAX_PAGES = 100
  const all: FmRow[] = []
  let header = await getFmServiceAuthHeader()
  let page = 0
  let totalPages = 1
  let retried = false

  while (page < totalPages && page < MAX_PAGES) {
    const params = new URLSearchParams({ page: String(page), size: String(SIZE) })
    const res = await fetch(`${FM}/api/admin/restaurants?${params}`, { headers: header, cache: 'no-store' })
    if (res.status === 401 && !retried) {
      retried = true
      header = await getFmServiceAuthHeader(true)
      continue
    }
    if (!res.ok) break
    const d = await res.json().catch(() => null)
    const content: FmRow[] = Array.isArray(d?.content) ? d.content : Array.isArray(d) ? d : []
    all.push(...content)
    totalPages = typeof d?.totalPages === 'number' ? d.totalPages : 1
    page++
  }
  return all
}

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

    // ── all: true — show every active FM restaurant ──
    if (body?.all === true) {
      // 1) Flip every existing override row to visible.
      const updatedRows = (await sql`
        UPDATE disco_restaurant_overrides SET visible = true, updated_at = NOW()
        WHERE visible = false
        RETURNING restaurant_reference
      `) as { restaurant_reference: string }[]
      const updated = updatedRows.length

      // 2) Insert visible rows for ACCEPTED + unblocked FM restaurants that have
      //    no override row yet.
      const existing = (await sql`SELECT restaurant_reference FROM disco_restaurant_overrides`) as { restaurant_reference: string }[]
      const have = new Set(existing.map((e) => e.restaurant_reference))

      const fmRows = await fetchAllFmRestaurants()
      const toInsert = fmRows
        .filter((r) => {
          const status = String((r.status ?? r.restaurantStatus) || '').toUpperCase()
          return status === 'ACCEPTED' && r.blocked !== true
        })
        .map((r) => String(r.reference ?? r.restaurantReference ?? ''))
        .filter((ref) => ref && !have.has(ref))

      const uniqueToInsert = Array.from(new Set(toInsert))
      let inserted = 0
      for (const ref of uniqueToInsert) {
        // ON CONFLICT DO NOTHING guards against races / dupes; count real inserts.
        const rows = (await sql`
          INSERT INTO disco_restaurant_overrides (restaurant_reference, visible, updated_at)
          VALUES (${ref}, true, NOW())
          ON CONFLICT (restaurant_reference) DO NOTHING
          RETURNING restaurant_reference
        `) as { restaurant_reference: string }[]
        if (rows.length) inserted++
      }

      return NextResponse.json({ updated, inserted })
    }

    return NextResponse.json({ error: 'Provide { all: true } or { restaurantReferences: [...] }' }, { status: 400 })
  } catch (e) {
    console.error('[bulk-set-visible] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Bulk visibility update failed' }, { status: 500 })
  }
}
