import { NextRequest, NextResponse } from 'next/server'
import { getRestaurantAuthHeader } from '../../../../../lib/restaurant-auth'
import { getRestaurantAuthContext, resolveDiscoScopeRef } from '../../../../../lib/restaurant-auth-context'
import { sql, runDiscoOrderMigrations } from '../../../../../lib/db'

const FM = process.env.FM_API_BASE_URL || 'https://api.familymeal.com'

export async function GET(req: NextRequest) {
  // Disco-native: report run history from disco_report_runs (was FM → 401).
  const ctx = await getRestaurantAuthContext()
  if (ctx?.authType === 'disco') {
    const scope = await resolveDiscoScopeRef(ctx)
    if (!scope) return NextResponse.json({ content: [], totalElements: 0 })
    await runDiscoOrderMigrations()
    const rows = (await sql`
      SELECT reference, report_name AS "reportName", file_type AS "fileType",
             run_status AS "runStatus", to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS "createdDate"
      FROM disco_report_runs WHERE restaurant_reference = ${scope}::uuid
      ORDER BY created_at DESC LIMIT 100
    `) as Record<string, unknown>[]
    return NextResponse.json({ content: rows, totalElements: rows.length })
  }

  let h: Record<string, string>
  try { h = await getRestaurantAuthHeader() } catch {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }
  const sp = req.nextUrl.searchParams
  const params = new URLSearchParams()
  const page = sp.get('page')
  if (page && page !== '0') params.set('page', page)
  params.set('size', sp.get('size') || '25')
  try {
    const res = await fetch(`${FM}/api/reports/runs?${params}`, { headers: h })
    if (!res.ok) return NextResponse.json({ error: 'Failed to fetch report runs' }, { status: res.status })
    return NextResponse.json(await res.json())
  } catch {
    return NextResponse.json({ error: 'Unable to fetch report runs' }, { status: 500 })
  }
}
