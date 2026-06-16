import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../../lib/db'
import { getAdminAuthHeader } from '../../../../../lib/admin-auth'
import { getFmServiceAuthHeader } from '../../../../../lib/fm-service-auth'

// FULL Stripe Connect sync across EVERY FM restaurant (not just visible ones with
// an existing override row). Paginates the entire FM admin restaurant list, then
// checks Stripe Connect status per restaurant the same way the batched sync does
// — FM's HEAD /api/stripe/{reference} (204 = connected). Stripe Connect accounts
// are owned by FM (Disco has no stripe.accounts.* of its own), so FM's probe is
// the authoritative match; we just run it for ALL references and upsert.
//
// Results are written with INSERT ... ON CONFLICT DO UPDATE so restaurants that
// never had a disco_restaurant_overrides row get one created.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'
const PAGE_SIZE = 200
const MAX_PAGES = 200      // safety cap (200 × 200 = 40k restaurants)
const PROBE_CONCURRENCY = 25
const UPSERT_CHUNK = 1000

export async function POST(_req: NextRequest) {
  let adminHeader: Record<string, string>
  try { adminHeader = await getAdminAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  try {
    await runMigrations()
    const startedAt = Date.now()

    // 1) Paginate the ENTIRE FM admin restaurant list. FM can repeat a reference
    //    across multi-unit locations, so dedupe.
    const seen = new Set<string>()
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetch(`${FM}/api/admin/restaurants?page=${page}&size=${PAGE_SIZE}`, {
        headers: adminHeader,
        cache: 'no-store',
      })
      if (!res.ok) {
        if (page === 0) {
          const raw = await res.text().catch(() => '')
          return NextResponse.json({ error: 'Failed to load restaurants from FM', status: res.status, raw: raw.slice(0, 300) }, { status: res.status })
        }
        break // partial list — proceed with what we have
      }
      const data = await res.json().catch(() => null) as { content?: { reference?: string }[]; totalPages?: number } | null
      const content = Array.isArray(data?.content) ? data!.content! : []
      for (const r of content) { if (r?.reference) seen.add(r.reference) }
      const totalPages = typeof data?.totalPages === 'number' ? data.totalPages : undefined
      if (content.length < PAGE_SIZE || (totalPages !== undefined && page + 1 >= totalPages)) break
    }
    const refs = [...seen]

    // 2) Probe Stripe Connect status per restaurant (FM HEAD), bounded concurrency.
    let header = await getFmServiceAuthHeader()
    async function probe(ref: string): Promise<boolean> {
      try {
        let res = await fetch(`${FM}/api/stripe/${ref}`, { method: 'HEAD', headers: header, cache: 'no-store' })
        if (res.status === 401) {
          header = await getFmServiceAuthHeader(true) // refresh expired service token once
          res = await fetch(`${FM}/api/stripe/${ref}`, { method: 'HEAD', headers: header, cache: 'no-store' })
        }
        return res.status === 204
      } catch (err) {
        console.error(`[sync-stripe-status/full] HEAD failed for ${ref}:`, err instanceof Error ? err.message : err)
        return false
      }
    }

    const results: { ref: string; connected: boolean }[] = []
    let connected = 0
    let cursor = 0
    async function worker() {
      while (cursor < refs.length) {
        const ref = refs[cursor++]
        const isConnected = await probe(ref)
        if (isConnected) connected++
        results.push({ ref, connected: isConnected })
      }
    }
    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, refs.length || 1) }, () => worker()))

    // 3) Upsert in chunks — new restaurants get a row, existing rows are updated.
    for (let i = 0; i < results.length; i += UPSERT_CHUNK) {
      const slice = results.slice(i, i + UPSERT_CHUNK)
      const refList = slice.map(r => r.ref)
      const connList = slice.map(r => r.connected)
      await sql`
        INSERT INTO disco_restaurant_overrides (restaurant_reference, stripe_connected, stripe_checked_at, updated_at)
        SELECT ref, conn, NOW(), NOW()
        FROM unnest(${refList}::text[], ${connList}::boolean[]) AS t(ref, conn)
        ON CONFLICT (restaurant_reference) DO UPDATE
          SET stripe_connected = EXCLUDED.stripe_connected,
              stripe_checked_at = EXCLUDED.stripe_checked_at,
              updated_at = NOW()
      `
    }

    return NextResponse.json({
      total: results.length,
      connected,
      notConnected: results.length - connected,
      durationMs: Date.now() - startedAt,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[sync-stripe-status/full] failed:', message, e instanceof Error ? e.stack : '')
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
