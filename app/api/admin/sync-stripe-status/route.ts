import { NextRequest, NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'
import { getFmServiceAuthHeader } from '../../../../lib/fm-service-auth'

// Check FM Stripe Connect status for VISIBLE restaurants and store it on
// disco_restaurant_overrides. FM has no bulk endpoint, so we probe
// HEAD /api/stripe/{reference} per restaurant (204 = connected, anything else =
// not). Admin-cookie gated.
//
// BATCHED: one POST processes a single page of `batchSize` (default 25) starting
// at `offset`, so each request stays well under the platform's function-duration
// limit. The client loops with the returned `nextOffset` until `done` is true.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function POST(req: NextRequest) {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }

  try {
    await runMigrations()
    const startedAt = Date.now()

    const body = await req.json().catch(() => null)
    const batchSize = Math.max(1, Math.min(500, Number(body?.batchSize) || 25))
    const offset = Math.max(0, Number(body?.offset) || 0)

    // Stable count + page (ORDER BY keeps the offset windows consistent run-to-run).
    const totalRows = (await sql`
      SELECT COUNT(*)::int AS n FROM disco_restaurant_overrides WHERE visible = true
    `) as { n: number }[]
    const total = totalRows[0]?.n ?? 0

    const refs = (await sql`
      SELECT restaurant_reference FROM disco_restaurant_overrides
      WHERE visible = true
      ORDER BY restaurant_reference
      LIMIT ${batchSize} OFFSET ${offset}
    `) as { restaurant_reference: string }[]

    let header = await getFmServiceAuthHeader()
    let connected = 0
    let notConnected = 0

    for (const { restaurant_reference: ref } of refs) {
      let isConnected = false
      try {
        let res = await fetch(`${FM}/api/stripe/${ref}`, { method: 'HEAD', headers: header, cache: 'no-store' })
        // Refresh the service token once if it expired mid-run.
        if (res.status === 401) {
          header = await getFmServiceAuthHeader(true)
          res = await fetch(`${FM}/api/stripe/${ref}`, { method: 'HEAD', headers: header, cache: 'no-store' })
        }
        isConnected = res.status === 204
      } catch (err) {
        // Network error → treat as not connected (and keep going).
        console.error(`[sync-stripe-status] HEAD failed for ${ref}:`, err instanceof Error ? err.message : err)
        isConnected = false
      }

      await sql`
        UPDATE disco_restaurant_overrides
        SET stripe_connected = ${isConnected}, stripe_checked_at = NOW()
        WHERE restaurant_reference = ${ref}
      `
      if (isConnected) connected++
      else notConnected++
    }

    const nextOffset = offset + refs.length
    // Done when this page was the last (fewer rows than asked) or we've reached total.
    const done = refs.length < batchSize || nextOffset >= total

    return NextResponse.json({
      total,
      connected,
      notConnected,
      durationMs: Date.now() - startedAt,
      nextOffset,
      done,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.error('[sync-stripe-status] failed:', message, e instanceof Error ? e.stack : '')
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
