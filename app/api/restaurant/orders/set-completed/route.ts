import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader, getRestaurantRef } from '../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext } from '../../../../../lib/restaurant-auth-context'
import { requireWritableRestaurantRef } from '../../../../../lib/restaurant-write-scope'
import { sql, runDiscoOrderMigrations } from '../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

function toIso(s: string | null): string | null {
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s
}

export async function PUT(req: NextRequest) {
  // Write target is the client-claimed restaurant_reference, verified against
  // the caller's permitted set — never the session's current selection (see
  // disco-profile's PUT for the full stale-intent rationale).
  const check = await requireWritableRestaurantRef(req.nextUrl.searchParams.get('restaurant_reference'))
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })
  const ref = check.ref

  // Disco-native: bulk-complete the restaurant's outstanding (DUE) orders in Neon.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    const from = toIso(req.nextUrl.searchParams.get('fromDate'))
    const to = toIso(req.nextUrl.searchParams.get('toDate'))
    try {
      await runDiscoOrderMigrations()
      const rows = (await sql`
        UPDATE disco_orders SET order_status = 'COMPLETED', updated_at = NOW()
        WHERE restaurant_reference = ${ref}::uuid AND order_status = 'DUE'
          AND (${from}::date IS NULL OR order_date >= ${from}::date)
          AND (${to}::date IS NULL OR order_date <= ${to}::date)
        RETURNING id
      `) as { id: number }[]
      return NextResponse.json({ ok: true, completed: rows.length })
    } catch { return NextResponse.json({ error: 'Unable to update' }, { status: 500 }) }
  }

  // FM's setCompleted endpoint has no explicit restaurant param — it always
  // targets FM's own internal "current restaurant" pointer, which we cannot
  // retarget per-call. So the claimed ref must also be the one CURRENTLY
  // active, or this write would silently land on FM's pointer instead of what
  // the page displayed — refuse rather than risk that.
  const active = await getRestaurantRef()
  if (ref !== active) {
    return NextResponse.json({ error: 'Your selected restaurant has changed — reload and try again.' }, { status: 409 })
  }

  let authHeaders: Record<string, string>
  try { authHeaders = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const { searchParams } = req.nextUrl
  const params = new URLSearchParams()
  if (searchParams.get('fromDate')) params.set('fromDate', searchParams.get('fromDate')!)
  if (searchParams.get('toDate')) params.set('toDate', searchParams.get('toDate')!)
  try {
    const res = await fetch(`${FM}/api/orders/setCompleted?${params}`, {
      method: 'PUT',
      headers: authHeaders,
    })
    if (!res.ok) return NextResponse.json({ error: 'Failed' }, { status: res.status })
    const text = await res.text()
    return NextResponse.json(text ? JSON.parse(text) : { ok: true })
  } catch {
    return NextResponse.json({ error: 'Unable to update' }, { status: 500 })
  }
}
