import { NextResponse } from 'next/server'
import { sql, runMigrations } from '../../../../lib/db'
import { getAdminAuthHeader } from '../../../../lib/admin-auth'
import { getFmServiceAuthHeader } from '../../../../lib/fm-service-auth'

// One-time tool: check FM Stripe Connect status for every VISIBLE restaurant and
// store it on disco_restaurant_overrides. FM has no bulk endpoint, so we probe
// HEAD /api/stripe/{reference} per restaurant (204 = connected, anything else =
// not), throttled. Admin-cookie gated. Can take several minutes for thousands.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function POST() {
  try { await getAdminAuthHeader() } catch { return NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }

  try {
    await runMigrations()
    const startedAt = Date.now()

    const refs = (await sql`
      SELECT restaurant_reference FROM disco_restaurant_overrides WHERE visible = true
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

      await sleep(100) // be gentle on FM
    }

    return NextResponse.json({
      total: refs.length,
      connected,
      notConnected,
      durationMs: Date.now() - startedAt,
    })
  } catch (e) {
    console.error('[sync-stripe-status] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Stripe status sync failed' }, { status: 500 })
  }
}
