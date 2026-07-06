import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { sql, runDiscoOrderMigrations } from '../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

function toIso(s: string | null): string | null {
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s
}

export async function PUT(req: NextRequest) {
  // Disco-native: bulk-complete the restaurant's outstanding (DUE) orders in Neon.
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    const ref = await resolveDiscoScopeRef(ctx)
    if (!ref) return NextResponse.json({ error: 'No restaurant in context' }, { status: 400 })
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
